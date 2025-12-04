console.log("Starting server script...");
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Serve static files from the React app build directory
app.use(express.static(path.join(__dirname, 'dist')));

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- GAME CONFIGURATION ---
const TEAMS = ['A', 'B', 'C'];
const MAX_HP = 100;
const GAME_DURATION = 300; // 5 mins
const SPAWN_RATE = 2500;
const REQUEST_LIFETIME = 12000;

// --- GAME STATE ---
let countdownTimer = null;
let gameState = {
  status: 'LOBBY', // LOBBY, COUNTDOWN, PLAYING, GAMEOVER
  timeLeft: GAME_DURATION,
  countdown: null,
  teams: {
    A: { hp: MAX_HP, cache: 20, score: 0, cooldowns: {} },
    B: { hp: MAX_HP, cache: 20, score: 0, cooldowns: {} },
    C: { hp: MAX_HP, cache: 20, score: 0, cooldowns: {} }
  },
  requests: [], // Shared request pool
  gameResult: null,
  players: {} // socketId -> { name, team, role }
};

// Attack Costs & Cooldowns
const ATTACKS = {
  SHUFFLE: { cost: 30, cooldown: 10000 },
  FREEZE: { cost: 60, cooldown: 20000 },
  GHOST: { cost: 45, cooldown: 30000 }
};

// --- GAME LOOP (Runs 10x per second) ---
setInterval(() => {
  if (gameState.status !== 'PLAYING') return;

  const now = Date.now();

  // 1. Timer Logic
  if (now % 1000 < 100) { // Approx once per second
    gameState.timeLeft--;
    if (gameState.timeLeft <= 0) endGame('TIMEOUT');
  }

  // 2. Request Aging & Explosions
  gameState.requests.forEach(req => {
    const age = now - req.birth;
    
    // Status updates
    if (age > REQUEST_LIFETIME * 0.8) req.status = 'critical';
    else if (age > REQUEST_LIFETIME * 0.5) req.status = 'warning';

    // Explosion
    if (age >= REQUEST_LIFETIME) {
      req.dead = true;
      if (!req.isFake) {
        // Find owner team (requests are assigned to specific teams or shared? 
        // In this logic, requests spawn for specific teams)
        if (gameState.teams[req.team]) {
          gameState.teams[req.team].hp -= 10;
          io.to(req.team).emit('log', { text: `CRITICAL: Request exploded! -10 HP`, type: 'danger' });
          
          if (gameState.teams[req.team].hp <= 0) {
             checkElimination();
          }
        }
      }
    }
  });

  // Cleanup dead requests
  gameState.requests = gameState.requests.filter(r => !r.dead);

  // 3. Spawning Logic (Randomly every ~SPAWN_RATE)
  if (Math.random() < (100 / SPAWN_RATE)) { // Rough probability based on tick rate
    TEAMS.forEach(teamId => {
        // Spawn independent requests for each team so they don't fight over the same blocks
        gameState.requests.push({
            id: `req-${Date.now()}-${Math.random()}`,
            team: teamId,
            sector: Math.floor(Math.random() * 200),
            birth: Date.now(),
            status: 'fresh',
            isFake: false,
            highlighted: false
        });
    });
    io.emit('requests_update', gameState.requests);
  }

  // 4. Broadcast State
  io.emit('game_tick', {
    teams: gameState.teams,
    timeLeft: gameState.timeLeft,
    // Optimizing bandwidth: Clients usually only need their own requests in full detail
    // But sending all for simplicity in this prototype
    requests: gameState.requests 
  });

}, 100);

function endGame(reason) {
  gameState.status = 'GAMEOVER';
  
  // 1. Filter for ALIVE teams first (Dead teams shouldn't win by score if others survived)
  let candidates = Object.entries(gameState.teams).filter(([id, t]) => t.hp > 0);
  
  // 2. If everyone is dead (Total System Failure), consider everyone for the "best of the worst"
  if (candidates.length === 0) {
      candidates = Object.entries(gameState.teams);
  }

  // 3. Sort by Score (Highest First)
  const winnerEntry = candidates.sort((a,b) => b[1].score - a[1].score)[0];
  const winner = winnerEntry ? winnerEntry[0] : 'None';

  gameState.gameResult = { winner: `Team ${winner}`, reason };
  io.emit('game_over', gameState.gameResult);
}

function checkElimination() {
    const aliveTeams = TEAMS.filter(t => gameState.teams[t].hp > 0);
    if (aliveTeams.length === 1) {
        gameState.status = 'GAMEOVER';
        gameState.gameResult = { winner: `Team ${aliveTeams[0]}`, reason: 'Last Team Standing' };
        io.emit('game_over', gameState.gameResult);
    } else if (aliveTeams.length === 0) {
        endGame('Total System Failure');
    }
}
// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_lobby', ({ team, role, name }) => {
    // 1. Check Team Size
    const teamPlayers = Object.values(gameState.players).filter(p => p.team === team);
    if (teamPlayers.length >= 3) {
        socket.emit('log', { text: 'Team is full (Max 3)', type: 'danger' });
        return;
    }
    // 2. Check Role Availability
    const roleTaken = teamPlayers.find(p => p.role === role);
    if (roleTaken) {
        socket.emit('log', { text: `Role ${role} is already taken in Team ${team}`, type: 'danger' });
        return;
    }

    // Leave previous team room if exists to prevent cross-talk
    const previousPlayerState = gameState.players[socket.id];
    if (previousPlayerState && previousPlayerState.team) {
        socket.leave(previousPlayerState.team);
    }

    socket.join(team); // Join "Team A" room
    
    // Store player info
    gameState.players[socket.id] = {
        id: socket.id,
        name: name || 'Unknown',
        team,
        role,
        ready: false
    };

    // Broadcast updated player list to everyone
    io.emit('lobby_update', gameState.players);
    
    // Send initial game state to the new joiner
    socket.emit('init_game', gameState);
  });

  socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      if (gameState.players[socket.id]) {
          delete gameState.players[socket.id];
          io.emit('lobby_update', gameState.players);
      }

      // Auto-reset if lobby is empty
      if (Object.keys(gameState.players).length === 0) {
          console.log("Lobby empty. Resetting game state.");
          gameState.status = 'LOBBY';
          gameState.requests = [];
          gameState.gameResult = null;
          TEAMS.forEach(t => {
              gameState.teams[t].hp = MAX_HP;
              gameState.teams[t].score = 0;
              gameState.teams[t].cache = 20;
          });
      }
  });

  socket.on('toggle_ready', () => {
    const player = gameState.players[socket.id];
    if (!player) return;
    
    player.ready = !player.ready;
    io.emit('lobby_update', gameState.players);
    
    // Check Auto-Start
    const players = Object.values(gameState.players);
    if (players.length === 0) return;

    // 1. Are ALL players ready?
    const allReady = players.every(p => p.ready);
    if (!allReady) {
        if (gameState.status === 'COUNTDOWN') {
            console.log("Countdown cancelled.");
            clearInterval(countdownTimer);
            gameState.status = 'LOBBY';
            gameState.countdown = null;
            io.emit('init_game', gameState);
        }
        return;
    }

    // 2. Validate Team Composition
    const teamCounts = { A: 0, B: 0, C: 0 };
    players.forEach(p => {
        if (teamCounts[p.team] !== undefined) teamCounts[p.team]++;
    });

    const activeTeams = Object.entries(teamCounts).filter(([t, count]) => count > 0);
    
    // Need at least one team
    if (activeTeams.length === 0) return;

    const invalidTeams = activeTeams.filter(([t, count]) => count < 3);
    if (invalidTeams.length > 0) {
        const teamNames = invalidTeams.map(t => t[0]).join(', ');
        // Only spam log if everyone is ready but teams are invalid
        io.emit('log', { text: `Waiting for full teams: ${teamNames} need 3 players.`, type: 'warning' });
        return;
    }

    if (gameState.status !== 'COUNTDOWN') {
        console.log("All players ready. Starting countdown...");
        gameState.status = 'COUNTDOWN';
        gameState.countdown = 5;
        io.emit('init_game', gameState);

        if (countdownTimer) clearInterval(countdownTimer);
        
        countdownTimer = setInterval(() => {
            gameState.countdown--;
            io.emit('countdown_tick', gameState.countdown);
            
            if (gameState.countdown <= 0) {
                clearInterval(countdownTimer);
                console.log("Countdown finished. Starting game...");
                gameState.status = 'PLAYING';
                gameState.timeLeft = GAME_DURATION;
                gameState.requests = [];
                TEAMS.forEach(t => {
                    gameState.teams[t].hp = MAX_HP;
                    gameState.teams[t].score = 0;
                    gameState.teams[t].cache = 20;
                });
                io.emit('game_start');
            }
        }, 1000);
    }
  });

  socket.on('reset_lobby', () => {
      console.log("Reset lobby requested");
      if (countdownTimer) clearInterval(countdownTimer);
      gameState.status = 'LOBBY';
      gameState.countdown = null;
      gameState.requests = [];
      gameState.gameResult = null;
      // Reset players ready state
      Object.values(gameState.players).forEach(p => p.ready = false);
      
      TEAMS.forEach(t => {
          gameState.teams[t].hp = MAX_HP;
          gameState.teams[t].score = 0;
          gameState.teams[t].cache = 20;
      });
      io.emit('lobby_update', gameState.players);
      io.emit('init_game', gameState);
  });

  // Driver Movement (Relay to teammates only)
  socket.on('driver_input', ({ team, targetPos }) => {
    // Broadcast to everyone in Team A room so Scheduler/Hacker see the arm move
    socket.to(team).emit('arm_update', { targetPos, team });
  });

  // Scheduler Actions
  socket.on('highlight_request', ({ reqId }) => {
    const req = gameState.requests.find(r => r.id === reqId);
    if (req) req.highlighted = !req.highlighted;
  });

  socket.on('drop_request', ({ reqId, team }) => {
    gameState.requests = gameState.requests.filter(r => r.id !== reqId);
    gameState.teams[team].hp = Math.max(0, gameState.teams[team].hp - 5);
    io.to(team).emit('log', { text: "Request dropped manually. -5 HP", type: 'warning' });
  });

const MAX_CACHE = 100;

  // Service Success (Client claims they caught it)
  socket.on('service_success', ({ reqId, team }) => {
    const reqIndex = gameState.requests.findIndex(r => r.id === reqId);
    if (reqIndex > -1) {
        const req = gameState.requests[reqIndex];
        if (req.isFake) {
            io.to(team).emit('service_feedback', { sector: req.sector, text: "GHOST! 0 PTS", color: "purple" });
        } else {
            gameState.teams[team].score += 100;
            gameState.teams[team].cache = Math.min(MAX_CACHE, gameState.teams[team].cache + 10);
            io.to(team).emit('service_feedback', { sector: req.sector, text: "+100 PTS", color: "green" });
        }
        gameState.requests.splice(reqIndex, 1);
    }
  });

  // Hacker Attacks
  socket.on('attack', ({ team, target, type }) => {
    const attack = ATTACKS[type];
    const teamState = gameState.teams[team];
    
    // Validate Cost
    let cost = attack.cost;
    if (target === 'ALL') cost *= 2;

    if (teamState.cache >= cost) {
        teamState.cache -= cost;
        
        // Apply Effects
        const targets = target === 'ALL' ? TEAMS.filter(t => t !== team) : [target];
        
        targets.forEach(t => {
            io.to(t).emit('debuff_received', { type });
            io.to(t).emit('log', { text: "WARNING: Unknown intrusion detected!", type: 'danger' });
            
            // Logic for specific attacks
            if (type === 'GHOST') {
                // Spawn fake requests for victim
                for(let i=0; i<5; i++) {
                    gameState.requests.push({
                        id: `fake-${Date.now()}-${Math.random()}`,
                        team: t,
                        sector: Math.floor(Math.random() * 200),
                        birth: Date.now(),
                        status: 'fresh',
                        isFake: true,
                        highlighted: true // Auto-highlighted to trick Driver
                    });
                }
            } else if (type === 'SHUFFLE') {
                // Since requests are just an array, shuffling logic would need to happen on client 
                // or we shuffle the array here. 
                // For simplicity, we just tell client to shuffle their view.
            }
        });

        io.to(team).emit('log', { text: `Attack Successful: ${type}`, type: 'success' });
    }
  });

});

// Handle React routing, return all requests to React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
console.log("Attempting to listen on port " + PORT);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));