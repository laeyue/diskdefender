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

console.log("Server configuration loaded. Bot logic enabled.");

// --- GAME STATE ---
let countdownTimer = null;
let gameState = {
  status: 'LOBBY', // LOBBY, COUNTDOWN, PLAYING, GAMEOVER
  timeLeft: GAME_DURATION,
  countdown: null,
  fillBots: false, // Default to false
  teams: {
    A: { hp: MAX_HP, cache: 20, score: 0, cooldowns: {}, targetPos: 100 },
    B: { hp: MAX_HP, cache: 20, score: 0, cooldowns: {}, targetPos: 100 },
    C: { hp: MAX_HP, cache: 20, score: 0, cooldowns: {}, targetPos: 100 }
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

  // 4. Server-Side Bot Logic (Fill missing roles)
  if (gameState.fillBots) {
      TEAMS.forEach(teamId => {
          const teamPlayers = Object.values(gameState.players).filter(p => p.team === teamId && p.connected);
          const hasScheduler = teamPlayers.some(p => p.role === 'SCHEDULER');
          const hasHacker = teamPlayers.some(p => p.role === 'HACKER');

          // SCHEDULER BOT
          if (!hasScheduler) {
              gameState.requests.forEach(req => {
                  // Bot highlights requests that are warning or critical, or randomly highlights fresh ones
                  if (req.team === teamId && !req.highlighted && !req.isFake) {
                      if (req.status === 'critical' || req.status === 'warning') {
                          req.highlighted = true;
                      } else if (Math.random() < 0.05) { // 5% chance per tick to highlight fresh requests
                          req.highlighted = true;
                      }
                  }
              });
          }

          // HACKER BOT
          if (!hasHacker) {
              const teamState = gameState.teams[teamId];
              // 2% chance per tick to try an attack if cache is sufficient for at least one attack
              if (teamState.cache >= 30 && Math.random() < 0.02) {
                  const atkKeys = Object.keys(ATTACKS);
                  // Filter attacks we can afford
                  const affordableAttacks = atkKeys.filter(key => teamState.cache >= ATTACKS[key].cost);
                  
                  if (affordableAttacks.length > 0) {
                      const randomAtkKey = affordableAttacks[Math.floor(Math.random() * affordableAttacks.length)];
                      const attack = ATTACKS[randomAtkKey];
                      
                      // Check Cooldown
                      const readyTime = teamState.cooldowns[randomAtkKey] || 0;
                      
                      if (now >= readyTime) {
                          // Pick Target
                          const rivals = TEAMS.filter(t => t !== teamId && gameState.teams[t].hp > 0);
                          if (rivals.length > 0) {
                              const targetTeam = rivals[Math.floor(Math.random() * rivals.length)];
                              
                              // Execute Attack
                              teamState.cache -= attack.cost;
                              teamState.cooldowns[randomAtkKey] = now + attack.cooldown;
                              
                              // Apply Effects
                              io.to(targetTeam).emit('debuff_received', { type: randomAtkKey });
                              io.to(targetTeam).emit('log', { text: "WARNING: Unknown intrusion detected!", type: 'danger' });
                              io.to(teamId).emit('log', { text: `[BOT] Attack Successful: ${randomAtkKey} on Team ${targetTeam}`, type: 'success' });

                              if (randomAtkKey === 'GHOST') {
                                  for(let i=0; i<5; i++) {
                                      gameState.requests.push({
                                          id: `fake-${Date.now()}-${Math.random()}`,
                                          team: targetTeam,
                                          sector: Math.floor(Math.random() * 200),
                                          birth: Date.now(),
                                          status: 'fresh',
                                          isFake: true,
                                          highlighted: true
                                      });
                                  }
                              }
                          }
                      }
                  }
              }
          }
      });
  }

  // 5. Broadcast State (Optimized Split)
  
  // A. Global State (Lightweight - HP, Score, Time) -> Broadcast to ALL
  const globalTeams = {};
  TEAMS.forEach(t => {
      globalTeams[t] = {
          hp: gameState.teams[t].hp,
          score: gameState.teams[t].score
      };
  });
  
  io.emit('game_tick', {
    teams: globalTeams,
    timeLeft: gameState.timeLeft
  });

  // B. Team Specific State (Heavy - Requests, Cache, Cooldowns) -> Send to Team Rooms
  TEAMS.forEach(teamId => {
      const teamRequests = gameState.requests.filter(r => r.team === teamId);
      io.to(teamId).emit('team_data', {
          cache: gameState.teams[teamId].cache,
          cooldowns: gameState.teams[teamId].cooldowns,
          targetPos: gameState.teams[teamId].targetPos,
          requests: teamRequests
      });
  });

}, 100);

function resetGame() {
    console.log("Resetting game state...");
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
        gameState.teams[t].cooldowns = {};
        gameState.teams[t].targetPos = 100;
    });
    io.emit('lobby_update', gameState.players);
    io.emit('init_game', gameState);
}

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

  // Auto-reset after 10 seconds
  setTimeout(() => {
      if (gameState.status === 'GAMEOVER') {
          resetGame();
      }
  }, 10000);
}

function checkElimination() {
    const aliveTeams = TEAMS.filter(t => gameState.teams[t].hp > 0);
    if (aliveTeams.length === 1) {
        gameState.status = 'GAMEOVER';
        gameState.gameResult = { winner: `Team ${aliveTeams[0]}`, reason: 'Last Team Standing' };
        io.emit('game_over', gameState.gameResult);
        
        // Auto-reset after 10 seconds
        setTimeout(() => {
            if (gameState.status === 'GAMEOVER') {
                resetGame();
            }
        }, 10000);
    } else if (aliveTeams.length === 0) {
        endGame('Total System Failure');
    }
}
// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
  const playerId = socket.handshake.auth.playerId;
  console.log('User connected:', socket.id, 'PlayerID:', playerId);

  // Check for reconnection
  let existingPlayer = Object.values(gameState.players).find(p => p.playerId === playerId);
  
  if (existingPlayer) {
      console.log(`Player ${existingPlayer.name} reconnected.`);
      
      // Update socket ID mapping
      // Remove old socket key
      const oldSocketId = existingPlayer.id;
      delete gameState.players[oldSocketId];
      
      // Update player object
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      if (existingPlayer.disconnectTimeout) {
          clearTimeout(existingPlayer.disconnectTimeout);
          delete existingPlayer.disconnectTimeout;
      }

      // Add to new socket key
      gameState.players[socket.id] = existingPlayer;

      // Re-join team room
      socket.join(existingPlayer.team);

      // Send rejoin success
      socket.emit('rejoin_success', {
          team: existingPlayer.team,
          role: existingPlayer.role,
          name: existingPlayer.name,
          state: gameState
      });

      // Broadcast update (to show they are online)
      io.emit('lobby_update', gameState.players);
  }

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
        playerId: playerId, // Store persistent ID
        name: name || 'Unknown',
        team,
        role,
        ready: false,
        connected: true
    };

    // Broadcast updated player list to everyone
    io.emit('lobby_update', gameState.players);
    
    // Send initial game state to the new joiner
    socket.emit('init_game', gameState);
  });

  socket.on('leave_team', () => {
      const player = gameState.players[socket.id];
      if (player) {
          console.log(`Player ${player.name} left the team.`);
          socket.leave(player.team);
          delete gameState.players[socket.id];
          io.emit('lobby_update', gameState.players);
      }
  });

  socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      const player = gameState.players[socket.id];
      
      if (player) {
          player.connected = false;
          
          // Give them 30 seconds to reconnect before removing
          player.disconnectTimeout = setTimeout(() => {
              if (!player.connected) {
                  console.log(`Player ${player.name} timed out. Removing.`);
                  delete gameState.players[socket.id];
                  io.emit('lobby_update', gameState.players);
                  
                  // Auto-reset if lobby is empty
                  if (Object.keys(gameState.players).length === 0) {
                      console.log("Lobby empty. Resetting game state.");
                      if (countdownTimer) clearInterval(countdownTimer);
                      gameState.status = 'LOBBY';
                      gameState.countdown = null;
                      gameState.requests = [];
                      gameState.gameResult = null;
                      TEAMS.forEach(t => {
                          gameState.teams[t].hp = MAX_HP;
                          gameState.teams[t].score = 0;
                          gameState.teams[t].cache = 20;
                      });
                  }
              }
          }, 30000);
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
    if (invalidTeams.length > 0 && !gameState.fillBots) {
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
      resetGame();
  });

  socket.on('toggle_bots', () => {
      console.log(`[${socket.id}] Toggling bots. Old: ${gameState.fillBots}`);
      gameState.fillBots = !gameState.fillBots;
      console.log(`New Bot State: ${gameState.fillBots}`);
      io.emit('init_game', gameState); // Broadcast new bot state
      io.emit('log', { text: `Bots ${gameState.fillBots ? 'Enabled' : 'Disabled'}`, type: 'info' });
  });

  // Driver Movement (Relay to teammates only)
  socket.on('driver_input', ({ team, targetPos }) => {
    const player = gameState.players[socket.id];
    
    // Security Check: Ensure player exists, is on the claimed team, and is a DRIVER
    if (!player || player.team !== team || player.role !== 'DRIVER') {
        // console.warn(`Unauthorized driver input from ${socket.id} (Role: ${player?.role}, Team: ${player?.team}) trying to control ${team}`);
        return;
    }

    // Dead Check
    if (gameState.teams[team].hp <= 0) return;

    // Broadcast to everyone in Team A room so Scheduler/Hacker see the arm move
    // console.log(`[${team}] Driver moved to ${targetPos}`);
    if (gameState.teams[team]) {
        gameState.teams[team].targetPos = targetPos;
    }
    socket.to(team).emit('arm_update', { targetPos, team });
  });

  // Scheduler Actions
  socket.on('highlight_request', ({ reqId }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'SCHEDULER') return;
    if (gameState.teams[player.team].hp <= 0) return;

    const req = gameState.requests.find(r => r.id === reqId);
    // Only allow highlighting requests for their own team
    if (req && req.team === player.team) {
        req.highlighted = !req.highlighted;
    }
  });

  socket.on('drop_request', ({ reqId, team }) => {
    const player = gameState.players[socket.id];
    // Validate player is Scheduler and on the correct team
    if (!player || player.role !== 'SCHEDULER' || player.team !== team) return;
    if (gameState.teams[team].hp <= 0) return;

    const req = gameState.requests.find(r => r.id === reqId);
    // Double check request belongs to team
    if (req && req.team === team) {
        gameState.requests = gameState.requests.filter(r => r.id !== reqId);
        gameState.teams[team].hp = Math.max(0, gameState.teams[team].hp - 5);
        io.to(team).emit('log', { text: "Request dropped manually. -5 HP", type: 'warning' });
    }
  });

const MAX_CACHE = 100;

  // Service Success (Client claims they caught it)
  socket.on('service_success', ({ reqId, team }) => {
    const player = gameState.players[socket.id];
    // Only allow team members (or specifically Driver) to claim success
    if (!player || player.team !== team) return;
    if (gameState.teams[team].hp <= 0) return;

    const reqIndex = gameState.requests.findIndex(r => r.id === reqId);
    if (reqIndex > -1) {
        const req = gameState.requests[reqIndex];
        
        // Verify request belongs to team
        if (req.team !== team) return;

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
    const player = gameState.players[socket.id];
    // Validate Hacker Role and Team
    if (!player || player.role !== 'HACKER' || player.team !== team) return;
    if (gameState.teams[team].hp <= 0) return;

    if (!target || (target !== 'ALL' && !TEAMS.includes(target))) {
        console.log(`Attack failed: Invalid target '${target}' from ${player.name}`);
        return;
    }

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
            console.log(`Sending debuff ${type} to team ${t}`);
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