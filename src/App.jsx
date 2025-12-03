import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, AlertTriangle, Shield, Zap, Skull, Activity, Crosshair, Server, Database, Smartphone, Laptop, Move, Trash2, Users, Swords, Target, MessageSquare, User, Bot, LayoutGrid, Clock, Ghost, Trophy, Wifi, WifiOff } from 'lucide-react';
import { io } from 'socket.io-client'; 

/**
 * DISK DRIVE DEFENDER: MULTIPLAYER CLIENT
 * Connects to Node.js backend. Falls back to local simulation if offline.
 */

// --- Constants ---
const DISK_SIZE = 200; 
const MAX_HP = 100;
const MAX_CACHE = 100;
const ARM_SPEED = 0.8; 
const GAME_DURATION = 300; 
// Local Sim Constants (used only if offline)
const LOCAL_SPAWN_RATE = 2500; 
const REQUEST_LIFETIME = 12000; 
const SERVICE_TIME = 500; 

const TEAMS = ['A', 'B', 'C'];

const TEAM_CONFIG = {
  A: { color: 'blue', label: 'Team A' },
  B: { color: 'purple', label: 'Team B' },
  C: { color: 'orange', label: 'Team C' }
};

const ATTACKS = {
  SHUFFLE: { name: 'Frag Queue', cost: 30, duration: 0, cooldown: 10000, icon: <Database size={16} /> },
  FREEZE: { name: 'Sys Freeze', cost: 60, duration: 3000, cooldown: 20000, icon: <Server size={16} /> },
  GHOST: { name: 'Ghost Write', cost: 45, duration: 0, cooldown: 30000, icon: <Ghost size={16} /> },
};

// Helper to generate rival objects based on player's team (Local Sim)
const getInitialRivals = (playerTeam) => {
  const others = TEAMS.filter(t => t !== playerTeam);
  const rivalObj = {};
  others.forEach(t => {
      rivalObj[t] = {
          name: `Team ${t} (Bot)`,
          hp: 100,
          cache: 20,
          score: 0,
          color: t === 'A' ? 'text-blue-400' : t === 'B' ? 'text-purple-400' : 'text-orange-400',
          status: 'ACTIVE'
      };
  });
  return rivalObj;
};

export default function DiskSchedulingGame() {
  // --- Network State ---
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  // --- App State ---
  const [gameState, setGameState] = useState('LOBBY'); 
  const [playerName, setPlayerName] = useState(`Player ${Math.floor(Math.random() * 1000)}`);
  const [myTeam, setMyTeam] = useState('A');
  const [myRole, setMyRole] = useState(null); 
  const [fillBots, setFillBots] = useState(true); // Only relevant in offline mode
  
  // Game Logic State
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [gameResult, setGameResult] = useState(null);

  // Player Stats (My Team)
  const [hp, setHp] = useState(MAX_HP);
  const [cache, setCache] = useState(20);
  const [score, setScore] = useState(0);

  // Rivals State
  const [rivals, setRivals] = useState(getInitialRivals('A'));
  const [lobbyPlayers, setLobbyPlayers] = useState({}); // socketId -> player data

  // Combat & Logs
  const [logs, setLogs] = useState([]);
  const [targetTeam, setTargetTeam] = useState(null);
  
  // Physics & Mechanics
  const [armPos, setArmPos] = useState(100);
  const [targetPos, setTargetPos] = useState(100);
  const [requests, setRequests] = useState([]); 
  
  // Visual Feedback
  const [servicingId, setServicingId] = useState(null);
  const [feedbackFx, setFeedbackFx] = useState(null);
  
  // Debuffs & Cooldowns
  const [debuffs, setDebuffs] = useState({
    frozen: false,
    shuffled: false
  });
  const [attackCooldowns, setAttackCooldowns] = useState({}); 

  // Refs
  const requestRef = useRef(requests);
  requestRef.current = requests;
  const armPosRef = useRef(100);
  const targetPosRef = useRef(100);
  const myTeamRef = useRef(myTeam); // Ref to track current team without re-connecting socket
  const myRoleRef = useRef(myRole);
  
  useEffect(() => {
      myTeamRef.current = myTeam;
  }, [myTeam]);

  useEffect(() => {
      myRoleRef.current = myRole;
  }, [myRole]);

  const lastTimeRef = useRef(Date.now());
  const serviceTimerRef = useRef(null);
  const serviceTargetIdRef = useRef(null);
  
  // --- Initialization ---
  useEffect(() => {
    // NOTE: To enable multiplayer, npm install socket.io-client and uncomment import
    // For this preview, we default to offline mode.
    let newSocket = null;
    try {
        console.log("Attempting to connect to socket...");
        // Use relative path to leverage Vite proxy
        newSocket = io({
            path: '/socket.io',
            transports: ['websocket', 'polling']
        }); 
        if (newSocket) {
            newSocket.on('connect', () => {
                console.log("Socket connected!", newSocket.id);
                setIsConnected(true);
                setPlayerName(`User-${newSocket.id.slice(0, 5)}`);
            });
            newSocket.on('connect_error', (err) => {
                console.error("Socket connection error:", err);
            });
            newSocket.on('disconnect', () => {
                console.log("Socket disconnected");
                setIsConnected(false);
            });
            
            // Server Listeners
            newSocket.on('init_game', (state) => {
                setGameState(state.status);
            });

            newSocket.on('game_start', () => {
                console.log("Game Started!");
                setGameState('PLAYING');
                setLogs([]);
            });

            newSocket.on('lobby_update', (players) => {
                setLobbyPlayers(players);
            });

            newSocket.on('game_tick', (data) => {
                const currentTeam = myTeamRef.current;
                // Sync State
                setTimeLeft(data.timeLeft);
                const myTeamData = data.teams[currentTeam];
                if (myTeamData) {
                    setHp(myTeamData.hp);
                    setCache(myTeamData.cache);
                    setScore(myTeamData.score);
                }
                // Sync Rivals
                setRivals(prevRivals => {
                    const newRivals = {};
                    Object.keys(data.teams).forEach(key => {
                        if (key !== currentTeam) {
                            newRivals[key] = {
                                ...(prevRivals[key] || getInitialRivals(currentTeam)[key]), // Keep local colors/names
                                hp: data.teams[key].hp,
                                score: data.teams[key].score
                            };
                        }
                    });
                    return newRivals;
                });
                
                // Sync Requests (Filter for my team)
                let myReqs = data.requests.filter(r => r.team === currentTeam);
                
                // Visibility Rule: Driver only sees highlighted requests
                if (myRoleRef.current === 'DRIVER') {
                    myReqs = myReqs.filter(r => r.highlighted);
                }

                setRequests(myReqs);
            });

            newSocket.on('arm_update', ({ targetPos }) => {
                // Teammate moved the arm
                setTargetPos(targetPos);
                targetPosRef.current = targetPos;
            });

            newSocket.on('debuff_received', ({ type }) => {
                applyDebuff(type, "Unknown");
            });

            newSocket.on('service_feedback', (data) => {
                setFeedbackFx({ 
                    id: Date.now(), 
                    x: (data.sector / 200) * 100, 
                    text: data.text, 
                    color: data.color 
                });
                setTimeout(() => setFeedbackFx(null), 1000);
            });

            newSocket.on('log', (data) => addLog(data.text, data.type));
            
            newSocket.on('game_over', (result) => {
                setGameState('GAMEOVER');
                setGameResult(result);
            });

            setSocket(newSocket);
        }
    } catch (e) {
        console.log("Socket not found, running offline mode.");
    }

    return () => {
        if (newSocket) newSocket.disconnect();
    }
  }, []); // Connect once on mount

  // --- Helpers ---
  const addLog = (msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setLogs(prev => [{ id, text: msg, type }, ...prev].slice(0, 6));
    setTimeout(() => {
        setLogs(prev => prev.filter(log => log.id !== id));
    }, 4000);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // --- Game Loop (Physics & Local Simulation Fallback) ---
  useEffect(() => {
    let animationFrameId;
    let spawnInterval;
    let rivalInterval;

    const gameLoop = () => {
      if (gameState !== 'PLAYING') return;

      const now = Date.now();
      lastTimeRef.current = now;

      // --- 1. Bot Logic (Offline Mode OR Autofill) ---
      // If connected, Server handles rivals. If offline, we sim rivals.
      if (!isConnected && fillBots) {
         runOfflineBotLogic();
      }

      // --- 2. Physics Engine (Client Side Prediction) ---
      // We always run physics locally for smooth 60FPS animation
      let currentArmPos = armPosRef.current;
      const target = targetPosRef.current;
      
      // If frozen debuff is active, stop movement
      if (!debuffs.frozen) {
          const diff = target - currentArmPos;
          if (Math.abs(diff) > 0.5) {
              currentArmPos += diff * 0.05 * ARM_SPEED; 
          } else {
              currentArmPos = target;
          }
      }
      
      // Clamp
      if (currentArmPos < 0) currentArmPos = 0;
      if (currentArmPos > 199) currentArmPos = 199;
      
      armPosRef.current = currentArmPos;
      setArmPos(currentArmPos);

      // --- 3. Offline Request Logic ---
      // If connected, server sends request updates. If offline, we simulate.
      if (!isConnected) {
          runOfflineRequestLogic(now);
      }

      // --- 4. Servicing Logic ---
      // We check collision locally. 
      // If Online: We emit 'service_attempt'. 
      // If Offline: We finish it locally.
      const activeReqs = requestRef.current;
      const currentSector = Math.round(currentArmPos); 
      const targetReq = activeReqs.find(r => Math.abs(r.sector - currentSector) < 3);

      if (targetReq) {
        if (serviceTargetIdRef.current !== targetReq.id) {
          serviceTargetIdRef.current = targetReq.id;
          setServicingId(targetReq.id);
          
          if (serviceTimerRef.current) clearTimeout(serviceTimerRef.current);
          
          serviceTimerRef.current = setTimeout(() => {
            if (isConnected) {
                socket.emit('service_success', { reqId: targetReq.id, team: myTeamRef.current });
                // Do NOT reset local service state here. Wait for request to disappear.
                // This prevents the loop where it services the same request repeatedly.
            } else {
                handleOfflineServiceSuccess(targetReq.id);
            }
          }, SERVICE_TIME);
        }
      } else {
        if (serviceTargetIdRef.current) {
          serviceTargetIdRef.current = null;
          setServicingId(null);
          if (serviceTimerRef.current) clearTimeout(serviceTimerRef.current);
        }
      }

      animationFrameId = requestAnimationFrame(gameLoop);
    };

    if (gameState === 'PLAYING') {
      lastTimeRef.current = Date.now();
      animationFrameId = requestAnimationFrame(gameLoop);
      
      // Offline Spawner
      if (!isConnected) {
          spawnInterval = setInterval(() => {
            const newReq = {
              id: Math.random().toString(36).substr(2, 9),
              sector: Math.floor(Math.random() * 200),
              birth: Date.now(),
              status: 'fresh',
              highlighted: false,
              isFake: false
            };
            setRequests(prev => [...prev, newReq]);
          }, LOCAL_SPAWN_RATE);

          rivalInterval = setInterval(() => {
             // Offline Timer
             setTimeLeft(prev => {
                if (prev <= 1) { finishGame('TIMEOUT'); return 0; }
                return prev - 1;
             });
             // Offline Rivals
             runOfflineRivalSim();
          }, 1000);
      }
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
      clearInterval(spawnInterval);
      clearInterval(rivalInterval);
      clearTimeout(serviceTimerRef.current);
    };
  }, [gameState, debuffs, myRole, fillBots, isConnected, socket]); 

  // --- Logic Helpers ---

  const runOfflineBotLogic = () => {
    // DRIVER BOT
    if (myRole !== 'DRIVER' && !debuffs.frozen) {
        const activeReqs = requestRef.current;
        let bestTarget = null;
        const highlighted = activeReqs.find(r => r.highlighted);
        if (highlighted) bestTarget = highlighted.sector;
        else if (activeReqs.length > 0) {
            let minDist = 999;
            activeReqs.forEach(r => {
            if (r.isFake && Math.random() > 0.2) return; 
            const dist = Math.abs(r.sector - armPosRef.current);
            if (dist < minDist) { minDist = dist; bestTarget = r.sector; }
            });
        }
        if (bestTarget !== null) { setTargetPos(bestTarget); targetPosRef.current = bestTarget; }
    }
    // SCHEDULER BOT
    if (myRole !== 'SCHEDULER') {
        requestRef.current.forEach(r => {
            if (r.status === 'critical' && !r.highlighted && !r.isFake) handleSchedulerPrioritize(r.id);
        });
    }
  };

  const runOfflineRequestLogic = (now) => {
      setRequests(prevReqs => {
        const nextReqs = prevReqs.map(req => {
          const age = now - req.birth;
          let status = 'fresh';
          if (age > REQUEST_LIFETIME * 0.5) status = 'warning';
          if (age > REQUEST_LIFETIME * 0.8) status = 'critical';
          return { ...req, age, status };
        });
        const exploded = nextReqs.filter(r => r.age >= REQUEST_LIFETIME);
        if (exploded.length > 0) {
            const realExplosions = exploded.filter(r => !r.isFake).length;
            if (realExplosions > 0) handleOfflineExplosion(realExplosions);
            return nextReqs.filter(r => r.age < REQUEST_LIFETIME);
        }
        return nextReqs;
      });
  };

  const runOfflineRivalSim = () => {
      setRivals(prev => {
          const next = { ...prev };
          Object.keys(next).forEach(team => {
            const bot = next[team];
            if (bot.hp <= 0) { bot.status = 'CRASHED'; return; }
            const skillChance = team === 'C' ? 0.7 : 0.5;
            if (Math.random() < skillChance) { bot.score += 100; bot.cache = Math.min(100, bot.cache + 15); }
            if (Math.random() < 0.1) bot.hp = Math.max(0, bot.hp - 10);
            if (bot.cache > 50 && Math.random() < 0.2) {
               bot.cache -= 50;
               const atkTypes = ['FREEZE', 'GHOST', 'SHUFFLE'];
               const type = atkTypes[Math.floor(Math.random() * atkTypes.length)];
               applyDebuff(type, bot.name); // Bot attacks player
            }
          });
          return next;
      });
  };

  // --- Handlers ---

  const startGame = () => {
    if (myRole) {
      if (isConnected) {
          socket.emit('join_lobby', { team: myTeamRef.current, role: myRole, name: playerName });
          // socket.emit('start_game'); // REMOVED: Don't auto-start, wait for lobby
      } else {
          setGameState('PLAYING');
          addLog(`Welcome, ${playerName}. Role: ${myRole}. Team: ${myTeam}. Offline Mode.`, 'info');
      }
    }
  };

  const handleOfflineExplosion = (count) => {
    setHp(prev => {
      const newHp = prev - (count * 10);
      if (newHp <= 0) finishGame('ELIMINATED');
      return newHp;
    });
    addLog(`CRITICAL: ${count} requests exploded! -${count*10} HP`, 'danger');
  };

  const handleOfflineServiceSuccess = (id) => {
    const req = requestRef.current.find(r => r.id === id);
    if (req) {
        if (req.isFake) {
             setFeedbackFx({ sector: req.sector, text: "GHOST! 0 PTS", id: Date.now(), color: 'text-purple-400' });
             addLog("Warning: Serviced Ghost Request (0 PTS)", 'warning');
        } else {
             setFeedbackFx({ sector: req.sector, text: "+100 PTS", id: Date.now(), color: 'text-green-400' });
             setScore(prev => prev + 100);
             setCache(prev => Math.min(prev + 10, MAX_CACHE));
        }
        setTimeout(() => setFeedbackFx(null), 1000);
    }
    setRequests(prev => prev.filter(r => r.id !== id));
    serviceTargetIdRef.current = null;
    setServicingId(null);
  };

  const finishGame = (reason) => {
    setGameState('GAMEOVER');
    let winner = 'Nobody';
    if (reason === 'LAST_STANDING') winner = `Team ${myTeam} (YOU)`;
    else if (reason === 'TIMEOUT') winner = `Team ${myTeam} (YOU)`; // Simplified offline logic
    else winner = 'Enemy Team';
    setGameResult({ winner, reason });
  };

  const applyDebuff = (type, attackerName) => {
    addLog(`WARNING: Unknown intrusion detected!`, 'danger');
    if (type === 'FREEZE') {
      setDebuffs(prev => ({ ...prev, frozen: true }));
      setTimeout(() => setDebuffs(prev => ({ ...prev, frozen: false })), ATTACKS.FREEZE.duration);
    } else if (type === 'GHOST') {
      // Only spawn local fakes if offline. Online, the server sends them.
      if (!isConnected) {
          const fakes = Array.from({length: 6}).map(() => ({
            id: `fake-${Date.now()}-${Math.random()}`,
            sector: Math.floor(Math.random() * 200),
            birth: Date.now(),
            status: 'fresh',
            highlighted: true, // Auto-highlighted to trick Driver
            isFake: true
          }));
          setRequests(prev => [...prev, ...fakes]);
      }
    } else if (type === 'SHUFFLE') {
       // Set shuffled state for visual scrambling
       setDebuffs(prev => ({ ...prev, shuffled: true }));
       setTimeout(() => setDebuffs(prev => ({ ...prev, shuffled: false })), ATTACKS.SHUFFLE.cooldown / 2); // Lasts 5s
    }
  };

  const executeAttack = (attackKey) => {
    const attack = ATTACKS[attackKey];
    const now = Date.now();
    
    // Cooldown Check
    if (attackCooldowns[attackKey] && now < attackCooldowns[attackKey]) {
        if (myRole === 'HACKER') addLog(`${attack.name} is on cooldown!`, 'warning');
        return;
    }

    const isMultiTarget = targetTeam === 'ALL';
    const finalCost = isMultiTarget ? attack.cost * 2 : attack.cost;

    if (cache >= finalCost) {
      if (isConnected) {
          socket.emit('attack', { team: myTeamRef.current, target: targetTeam, type: attackKey });
          // Optimistically update cache and cooldown
          setCache(prev => prev - finalCost);
          setAttackCooldowns(prev => ({ ...prev, [attackKey]: now + attack.cooldown }));
      } else {
          // Offline logic
          setCache(prev => prev - finalCost);
          setAttackCooldowns(prev => ({ ...prev, [attackKey]: now + attack.cooldown }));
          setRivals(prev => {
            const next = { ...prev };
            const targets = isMultiTarget ? Object.keys(next) : [targetTeam];
            targets.forEach(tKey => {
                const target = next[tKey];
                if (target && target.hp > 0) {
                    if (attackKey === 'GHOST') target.score = Math.max(0, target.score - 50); 
                    else {
                        target.hp = Math.max(0, target.hp - 15); 
                        target.cache = Math.max(0, target.cache - 10); 
                    }
                    addLog(`ATTACK: Used ${attack.name} on ${target.name}!`, 'success');
                }
            });
            return next;
          });
      }
    } else if (myRole === 'HACKER') {
        addLog(`Insufficient Cache! Need ${finalCost}`, 'warning');
    }
  };

  // --- Controls ---

  const handleDriverMove = (val) => {
    let input = parseInt(val);
    setTargetPos(input);
    targetPosRef.current = input;
    if (isConnected && myRole === 'DRIVER') {
        socket.emit('driver_input', { team: myTeamRef.current, targetPos: input });
    }
  };

  const handleSchedulerPrioritize = (id) => {
    if (isConnected) {
        socket.emit('highlight_request', { reqId: id });
    } else {
        setRequests(prev => prev.map(r => ({
            ...r, highlighted: r.id === id ? !r.highlighted : r.highlighted
        })));
    }
  };

  const handleSchedulerDrop = (id) => {
    if (isConnected) {
        socket.emit('drop_request', { reqId: id, team: myTeamRef.current });
    } else {
        setRequests(prev => prev.filter(r => r.id !== id));
        const req = requests.find(r => r.id === id);
        if (req && !req.isFake) {
            setHp(prev => Math.max(0, prev - 5)); 
            addLog("Request dropped manually. -5 HP", 'warning');
        } else {
            addLog("Ghost request deleted. Good eye.", 'success');
        }
    }
  };

  // --- Render Helpers ---

  const getRoleColor = (role) => {
    switch(role) {
      case 'DRIVER': return 'text-blue-400 border-blue-500';
      case 'SCHEDULER': return 'text-yellow-400 border-yellow-500';
      case 'HACKER': return 'text-red-400 border-red-500';
      default: return 'text-gray-400 border-gray-600';
    }
  };

  const getBlockColor = (req) => {
    switch(req.status) {
      case 'critical': return 'bg-red-600 animate-pulse border-red-400';
      case 'warning': return 'bg-yellow-500 border-yellow-300';
      default: return 'bg-green-500 border-green-300';
    }
  };

  // --- Views ---

  // 1. LOBBY VIEW
  if (gameState === 'LOBBY') {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-950 text-white font-mono p-6">
        <div className="max-w-4xl w-full bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-blue-500 via-yellow-500 to-red-500"></div>
          
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold mb-2 tracking-widest text-white">DISK DRIVE DEFENDER</h1>
            <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
                {isConnected ? <Wifi size={16} className="text-green-500"/> : <WifiOff size={16} className="text-red-500"/>}
                <span>{isConnected ? "CONNECTED TO SERVER" : "OFFLINE MODE"}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Left: Player Configuration */}
            <div className="space-y-6">
              
              {/* Name & Team */}
              <div className="flex gap-4">
                 <div className="flex-1">
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Operator Name</label>
                    <input 
                      type="text" 
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 text-white p-3 rounded focus:outline-none focus:border-blue-500 transition-colors"
                    />
                 </div>
                 <div className="w-1/3">
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Team</label>
                    <div className="flex bg-gray-800 rounded border border-gray-700 overflow-hidden">
                       {TEAMS.map(t => (
                         <button 
                           key={t} 
                           onClick={() => setMyTeam(t)}
                           className={`flex-1 py-3 text-sm font-bold transition-all ${myTeam === t ? 'bg-blue-600 text-white' : 'hover:bg-gray-700 text-gray-400'}`}
                         >
                           {t}
                         </button>
                       ))}
                    </div>
                 </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-4">Select Assignment</label>
                <div className="space-y-3">
                  {[
                    { id: 'DRIVER', icon: Laptop, label: 'Driver', desc: 'Control the physical arm. Requires dexterity.', color: 'blue' },
                    { id: 'SCHEDULER', icon: Activity, label: 'Scheduler', desc: 'Manage the queue. Requires strategy.', color: 'yellow' },
                    { id: 'HACKER', icon: Smartphone, label: 'Hacker', desc: 'Attack rivals. Requires timing.', color: 'red' }
                  ].map((role) => {
                    // Check if role is taken
                    const isTaken = isConnected && Object.values(lobbyPlayers).some(p => p.team === myTeam && p.role === role.id && p.name !== playerName);
                    
                    return (
                    <button 
                      key={role.id}
                      onClick={() => !isTaken && setMyRole(role.id)}
                      disabled={isTaken}
                      className={`w-full p-4 rounded-xl border flex items-center gap-4 transition-all
                        ${isTaken ? 'opacity-50 cursor-not-allowed bg-gray-900 border-gray-800' : 
                          myRole === role.id 
                          ? `bg-${role.color}-900/20 border-${role.color}-500 ring-1 ring-${role.color}-500` 
                          : 'bg-gray-800 border-gray-700 hover:bg-gray-700'}`}
                    >
                      <div className={`p-3 rounded-full bg-gray-900 ${myRole === role.id ? `text-${role.color}-400` : 'text-gray-500'}`}>
                        <role.icon size={20} />
                      </div>
                      <div className="text-left">
                        <div className={`font-bold ${myRole === role.id ? `text-${role.color}-400` : 'text-white'} ${isTaken ? 'line-through text-gray-600' : ''}`}>
                            {role.label} {isTaken && '(TAKEN)'}
                        </div>
                        <div className="text-xs text-gray-400">{role.desc}</div>
                      </div>
                    </button>
                  )})}
                </div>
              </div>
            </div>

            {/* Right: Lobby Options */}
            <div className="bg-gray-800/50 rounded-xl p-6 border border-gray-700 flex flex-col justify-between">
               <div>
                 <h3 className="font-bold text-white mb-4 flex items-center gap-2">
                   <Users size={18} /> TEAM ROSTER ({TEAM_CONFIG[myTeam].label})
                 </h3>
                 <div className="space-y-2 mb-6">
                    {/* My Player (Local Preview) */}
                    {!isConnected && (
                        <div className="flex justify-between items-center p-2 bg-gray-800 rounded border border-gray-600">
                        <div className="flex items-center gap-2"><User size={14} className="text-green-400"/> {playerName}</div>
                        <span className="text-xs font-mono bg-green-900/30 text-green-400 px-2 py-1 rounded">{myRole || 'SELECT ROLE'}</span>
                        </div>
                    )}

                    {/* Online Players List */}
                    {isConnected && Object.values(lobbyPlayers).filter(p => p.team === myTeam).map(p => (
                        <div key={p.id} className={`flex justify-between items-center p-2 rounded border transition-all ${p.ready ? 'bg-green-900/20 border-green-500/50' : 'bg-gray-800 border-gray-600'}`}>
                            <div className="flex items-center gap-2">
                                <User size={14} className={p.name === playerName ? "text-green-400" : "text-blue-400"}/> 
                                {p.name} {p.name === playerName && '(YOU)'}
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-mono bg-gray-700 text-gray-300 px-2 py-1 rounded">{p.role}</span>
                                {p.ready && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>}
                            </div>
                        </div>
                    ))}

                    {/* Bot Slots */}
                    {!isConnected && ['Bot Alpha', 'Bot Beta'].map((bot, i) => (
                      <div key={i} className="flex justify-between items-center p-2 bg-gray-900/50 rounded border border-gray-800 opacity-70">
                        <div className="flex items-center gap-2 text-gray-500"><Bot size={14} /> {fillBots ? bot : 'Empty Slot'}</div>
                        <span className="text-xs font-mono text-gray-600">{fillBots ? 'AUTO-FILL' : 'WAITING...'}</span>
                      </div>
                    ))}
                    
                    {isConnected && Object.values(lobbyPlayers).filter(p => p.team === myTeam).length === 0 && (
                        <div className="text-xs text-gray-500 italic p-2">Join to see teammates...</div>
                    )}
                 </div>

                 {!isConnected && (
                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className={`w-5 h-5 border rounded flex items-center justify-center ${fillBots ? 'bg-blue-600 border-blue-600' : 'border-gray-500'}`}>
                        {fillBots && <div className="w-2 h-2 bg-white rounded-full"></div>}
                        </div>
                        <input type="checkbox" checked={fillBots} onChange={() => setFillBots(!fillBots)} className="hidden" />
                        <span className="text-sm text-gray-300 group-hover:text-white">Fill empty slots with AI Teammates</span>
                    </label>
                 )}
               </div>
               
               <button 
                onClick={() => {
                    if (isConnected) {
                        // If already joined, toggle ready. If not, join lobby.
                        const myPlayer = Object.values(lobbyPlayers).find(p => p.name === playerName && p.team === myTeamRef.current);
                        if (myPlayer) {
                            socket.emit('toggle_ready');
                        } else {
                            startGame();
                        }
                    } else {
                        startGame();
                    }
                }}
                disabled={!myRole}
                className={`w-full py-4 mt-6 rounded-lg font-bold text-lg tracking-widest transition-all
                  ${!myRole ? 'bg-gray-700 text-gray-500 cursor-not-allowed' :
                    isConnected 
                        ? (Object.values(lobbyPlayers).find(p => p.name === playerName)?.ready 
                            ? 'bg-yellow-600 hover:bg-yellow-500 text-white shadow-lg shadow-yellow-900/20' 
                            : 'bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/20')
                        : 'bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/20'
                   }`}
               >
                 {isConnected 
                    ? (Object.values(lobbyPlayers).some(p => p.name === playerName) 
                        ? (Object.values(lobbyPlayers).find(p => p.name === playerName)?.ready ? 'UNREADY' : 'READY UP') 
                        : 'JOIN LOBBY') 
                    : 'START OFFLINE SIM'}
               </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 2. GAME OVER VIEW
  if (gameState === 'GAMEOVER') {
    const isWin = gameResult?.winner.includes('YOU') || (gameResult?.winner.includes(myTeam));
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-950 text-white font-mono relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-black to-black"></div>
        
        <div className="z-10 text-center animate-in zoom-in duration-500">
            {isWin ? (
                <Trophy size={80} className="text-yellow-400 mx-auto mb-6 animate-bounce" />
            ) : (
                <Skull size={80} className="text-red-500 mx-auto mb-6" />
            )}
            
            <h1 className={`text-6xl font-bold mb-2 tracking-tighter ${isWin ? 'text-yellow-400' : 'text-red-500'}`}>
                {isWin ? 'VICTORY' : 'DEFEAT'}
            </h1>
            <p className="text-2xl text-white mb-8 tracking-widest uppercase">{gameResult?.reason}</p>
            
            <div className="bg-gray-900/80 p-8 rounded-2xl border border-gray-700 backdrop-blur-xl max-w-md w-full mx-auto shadow-2xl">
               <div className="text-sm text-gray-500 uppercase tracking-widest mb-4">Winner</div>
               <div className={`text-3xl font-bold mb-8 ${isWin ? 'text-green-400' : 'text-white'}`}>
                   {gameResult?.winner}
               </div>

               <div className="grid grid-cols-2 gap-4 text-left">
                   <div className="bg-black/40 p-4 rounded border border-gray-800">
                       <span className="text-xs text-gray-500 block">Your Score</span>
                       <span className="text-xl font-bold text-white">{score}</span>
                   </div>
                   <div className="bg-black/40 p-4 rounded border border-gray-800">
                       <span className="text-xs text-gray-500 block">Your HP</span>
                       <span className={`text-xl font-bold ${hp > 0 ? 'text-green-400' : 'text-red-500'}`}>{hp}%</span>
                   </div>
               </div>
            </div>

            <button 
            onClick={() => window.location.reload()}
            className="mt-12 px-10 py-4 bg-blue-600 hover:bg-blue-500 rounded-full text-white font-bold tracking-wider shadow-lg shadow-blue-900/50 transition-all hover:scale-105"
            >
            RETURN TO LOBBY
            </button>
        </div>
      </div>
    );
  }

  const getVisualSector = (req) => {
      if (!debuffs.shuffled) return req.sector;
      // Stable random position based on ID to prevent jitter
      let hash = 0;
      for (let i = 0; i < req.id.length; i++) hash = (hash << 5) - hash + req.id.charCodeAt(i);
      return Math.abs(hash) % 200;
  };

  // 3. MAIN GAME VIEW
  return (
    <div className="flex h-screen bg-gray-900 text-white font-mono overflow-hidden select-none">
      
      {/* LEFT: MAIN GAME AREA */}
      <div className="flex-1 flex flex-col relative">
        {/* HEADER */}
        <div className="p-4 bg-gray-800 border-b border-gray-700 flex justify-between items-center shadow-lg z-10">
          <div className="flex items-center space-x-6">
             {/* HP Bar */}
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest">Integrity</span>
              <div className="w-32 h-2 bg-gray-700 rounded-full overflow-hidden border border-gray-600">
                <div className={`h-full transition-all duration-300 ${hp < 30 ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${hp}%` }} />
              </div>
            </div>
             {/* Cache Bar */}
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest">Cache</span>
              <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden border border-gray-600 relative">
                <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${cache}%` }} />
              </div>
            </div>
            {/* Player ID */}
            <div className="flex items-center gap-2 border-l border-gray-700 pl-6">
               <User size={16} className="text-gray-400"/>
               <div className="flex flex-col">
                 <span className="text-xs font-bold text-white">{playerName}</span>
                 <span className="text-[10px] text-gray-400">{myRole} // TEAM {myTeam}</span>
               </div>
            </div>
          </div>

          <div className="text-xl font-bold tracking-widest text-white/10 select-none pointer-events-none absolute left-1/2 -translate-x-1/2 flex flex-col items-center">
             <span>DISK DEFENDER</span>
             {/* TIMER DISPLAY */}
             <div className={`mt-1 flex items-center gap-2 text-sm ${timeLeft < 60 ? 'text-red-500 animate-pulse' : 'text-blue-400'}`}>
                <Clock size={14}/> {formatTime(timeLeft)}
             </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="text-right">
              <div className="text-xs text-gray-400">Score</div>
              <div className="font-bold text-xl">{score}</div>
            </div>
          </div>
        </div>

        {/* ROLE INDICATOR BAR */}
        <div className="flex bg-gray-950 border-b border-gray-800">
           <div className={`flex-1 py-2 text-center text-xs font-bold tracking-wider flex items-center justify-center gap-2 ${getRoleColor(myRole)} border-b-2 bg-gray-900`}>
              {myRole === 'DRIVER' && <Laptop size={14} />}
              {myRole === 'SCHEDULER' && <Activity size={14} />}
              {myRole === 'HACKER' && <Smartphone size={14} />}
              YOU ARE THE {myRole}
           </div>
           {(!isConnected && fillBots) && (
             <div className="px-4 py-2 flex items-center gap-2 text-xs text-gray-500 bg-gray-950 border-b-2 border-gray-800 italic">
               <Bot size={12}/> TEAMMATES AUTOMATED
             </div>
           )}
        </div>

        {/* BATTLEFIELD LAYER */}
        <div className="flex-1 relative p-6 flex flex-col items-center bg-gray-900 bg-[radial-gradient(#1f2937_1px,transparent_1px)] [background-size:16px_16px]">
          
          {/* DEBUFF OVERLAYS */}
          {debuffs.frozen && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/10 pointer-events-none backdrop-blur-sm">
              <div className="bg-blue-900/90 border border-blue-400 p-6 rounded text-center animate-pulse">
                <Server size={48} className="mx-auto text-blue-300 mb-2" />
                <h2 className="text-2xl font-bold text-white">SYSTEM FROZEN</h2>
              </div>
            </div>
          )}

          {/* DISK TRACK - VISIBLE TO ALL ROLES */}
          <div className="w-full max-w-4xl relative mt-8 mb-8">
            <div className="h-16 bg-gray-800 rounded-lg border-2 border-gray-700 relative overflow-hidden shadow-inner">
               {[0, 25, 50, 75, 100, 125, 150, 175].map(tick => (
                 <div key={tick} className="absolute top-0 bottom-0 border-r border-gray-700/50 text-[10px] text-gray-600 p-1" style={{ left: `${(tick/199)*100}%` }}>{tick}</div>
               ))}

              {/* Request Blocks */}
              {requests.map(req => {
                const visualSector = getVisualSector(req);
                return (
                  <div key={req.id} 
                    className={`absolute top-2 bottom-2 w-4 rounded-sm border shadow-lg flex items-center justify-center ${getBlockColor(req)} ${req.highlighted ? 'ring-2 ring-white z-20 scale-110' : 'z-10'}`}
                    style={{ left: `${(visualSector / 199) * 100}%` }}
                  >
                     {req.highlighted && <div className="absolute -top-6 text-white text-xs font-bold animate-bounce">↓</div>}
                  </div>
                );
              })}

              {/* Arm Head */}
              <div className={`absolute top-0 bottom-0 w-2 shadow-[0_0_15px_rgba(59,130,246,0.8)] z-30 transition-none ${servicingId ? 'bg-green-500 shadow-[0_0_20px_rgba(34,197,94,1)]' : 'bg-blue-500'}`}
                style={{ left: `${(armPos / 199) * 100}%` }}
              >
                <div className={`absolute -bottom-6 left-1/2 -translate-x-1/2 font-mono text-xs font-bold whitespace-nowrap ${servicingId ? 'text-green-400' : 'text-blue-400'}`}>
                   {servicingId ? 'READING...' : `HEAD: ${Math.round(armPos)}`}
                </div>
                {servicingId && <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 border-2 border-green-400 rounded-full animate-ping opacity-75"></div>}
              </div>

              {/* Target Ghost (Visible to Driver, or everyone to see plan) */}
              <div className="absolute top-0 bottom-0 w-1 bg-white/30 z-0 border-l border-white/50 border-dashed" style={{ left: `${(targetPos / 199) * 100}%` }} />
            </div>
            
            {/* Feedback Float */}
            {feedbackFx && (
              <div className={`absolute top-0 z-50 font-bold text-sm animate-[bounce_1s_ease-out_infinite] ${feedbackFx.color}`} style={{ left: `${(feedbackFx.sector / 199) * 100}%`, transform: 'translateY(-150%)' }}>{feedbackFx.text}</div>
            )}
          </div>

          {/* ROLE CONTROLS AREA (LOCKED BASED ON ROLE) */}
          <div className="w-full max-w-4xl flex-1 bg-gray-800/50 rounded-xl border border-gray-700 p-4 backdrop-blur-sm overflow-hidden flex flex-col items-center justify-center">
            
            {/* DRIVER VIEW */}
            {myRole === 'DRIVER' && (
              <div className="text-center w-full max-w-2xl space-y-6 animate-in fade-in duration-500">
                <div className="flex items-center justify-center gap-4 mb-4">
                   <Laptop className="text-blue-400" size={32} />
                   <div className="text-left">
                      <h3 className="text-xl font-bold text-white">MANUAL OVERRIDE ENGAGED</h3>
                      <p className="text-sm text-gray-400">Adjust L/R Actuators to match Scheduler priorities.</p>
                   </div>
                </div>
                <div className="bg-black/40 p-8 rounded-xl border border-blue-500/30 shadow-[0_0_20px_rgba(59,130,246,0.1)]">
                  <input type="range" min="0" max="199" value={targetPos} onChange={(e) => handleDriverMove(e.target.value)} disabled={debuffs.frozen}
                    className="w-full h-6 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50 hover:accent-blue-400 transition-all"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-4 font-mono uppercase tracking-widest">
                    <span>Sector 0</span>
                    <span className="text-blue-400 font-bold">Current Target: {targetPos}</span>
                    <span>Sector 199</span>
                  </div>
                </div>
              </div>
            )}

            {/* SCHEDULER VIEW */}
            {myRole === 'SCHEDULER' && (
              <div className="w-full h-full flex flex-col animate-in fade-in duration-500">
                <div className="flex justify-between items-center mb-4 border-b border-gray-700 pb-2">
                   <h3 className="text-lg font-bold text-yellow-400 flex items-center gap-2"><Activity size={18}/> I/O REQUEST BUFFER</h3>
                   <div className="text-xs text-gray-500 font-mono">
                      <span className="text-yellow-500">DRIVER STATUS:</span> {debuffs.frozen ? 'ERR_FROZEN' : 'ACTIVE'}
                   </div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 overflow-y-auto pr-2 pb-2 flex-1">
                  {requests.sort((a,b) => getVisualSector(a) - getVisualSector(b)).map(req => (
                    <div key={req.id} className={`p-3 rounded border flex justify-between items-center bg-gray-900 transition-all ${req.highlighted ? 'border-yellow-400 ring-1 ring-yellow-400/50 bg-yellow-900/10' : 'border-gray-700 hover:border-gray-500'}`}>
                      <div>
                        <span className="text-lg font-bold font-mono text-white">#{req.sector}</span>
                        <div className={`text-[10px] uppercase font-bold ${req.status === 'critical' ? 'text-red-500' : req.status === 'warning' ? 'text-yellow-500' : 'text-green-500'}`}>{req.status}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleSchedulerPrioritize(req.id)} disabled={debuffs.frozen} className={`p-2 rounded border transition-colors ${req.highlighted ? 'bg-yellow-500 text-black border-yellow-500' : 'bg-gray-800 text-gray-400 border-gray-600 hover:text-white'} ${debuffs.frozen ? 'opacity-50 cursor-not-allowed' : ''}`}><Crosshair size={16} /></button>
                        <button onClick={() => handleSchedulerDrop(req.id)} disabled={debuffs.frozen} className={`p-2 bg-red-900/20 text-red-400 hover:bg-red-900/50 rounded border border-red-900/50 ${debuffs.frozen ? 'opacity-50 cursor-not-allowed' : ''}`}><Trash2 size={16} /></button>
                      </div>
                    </div>
                  ))}
                  {requests.length === 0 && <div className="col-span-full text-center text-gray-600 italic py-10">Buffer Empty. Waiting for I/O interrupt...</div>}
                </div>
              </div>
            )}

            {/* HACKER VIEW */}
            {myRole === 'HACKER' && (
              <div className="w-full h-full flex flex-col animate-in fade-in duration-500">
                <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-2">
                   <h3 className="text-lg font-bold text-red-400 flex items-center gap-2"><Smartphone size={18}/> CYBER WARFARE CONSOLE</h3>
                   <div className="text-xs text-gray-500 font-mono">
                      <span className="text-red-500">SYSTEM STATUS:</span> {debuffs.frozen ? 'ERR_FROZEN' : 'ONLINE'}
                   </div>
                   
                   {/* TARGET SELECTOR */}
                   <div className="flex items-center gap-2 bg-black/30 p-1 rounded border border-gray-700">
                      <span className="text-[10px] text-gray-400 px-2 uppercase tracking-wider">Target Lock</span>
                      {Object.keys(rivals).map(t => (
                        <button 
                          key={t}
                          onClick={() => setTargetTeam(t)}
                          className={`px-4 py-1 text-xs font-bold rounded transition-all ${targetTeam === t ? 'bg-red-600 text-white shadow-lg shadow-red-900/50' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                        >
                          RIVAL {t}
                        </button>
                      ))}
                      {/* ALL Option */}
                      <button 
                          onClick={() => setTargetTeam('ALL')}
                          className={`px-4 py-1 text-xs font-bold rounded transition-all border-l border-gray-600 ${targetTeam === 'ALL' ? 'bg-red-900 text-white shadow-lg shadow-red-900/50 ring-1 ring-red-500' : 'bg-gray-800 text-red-400 hover:bg-gray-700'}`}
                        >
                          ALL RIVALS
                        </button>
                   </div>
                </div>

                <div className="grid grid-cols-3 gap-6 max-w-3xl mx-auto w-full">
                  {Object.keys(ATTACKS).map(key => {
                    const atk = ATTACKS[key];
                    const isMulti = targetTeam === 'ALL';
                    const finalCost = isMulti ? atk.cost * 2 : atk.cost;
                    
                    const canAfford = cache >= finalCost;
                    const isOnCooldown = attackCooldowns[key] && Date.now() < attackCooldowns[key];
                    const cooldownTime = isOnCooldown ? Math.ceil((attackCooldowns[key] - Date.now()) / 1000) : 0;
                    const isFrozen = debuffs.frozen;
                    
                    return (
                      <button key={key} onClick={() => executeAttack(key)} disabled={!canAfford || isOnCooldown || isFrozen}
                        className={`p-6 border rounded-xl flex flex-col items-center gap-3 transition-all relative overflow-hidden group
                          ${canAfford && !isOnCooldown && !isFrozen
                            ? 'bg-gray-900 border-red-500 hover:bg-red-950 hover:border-red-400 cursor-pointer shadow-red-900/20 shadow-xl' 
                            : 'bg-gray-800 border-gray-700 opacity-40 cursor-not-allowed grayscale'}`}
                      >
                        <div className={`p-4 rounded-full mb-2 ${canAfford && !isOnCooldown && !isFrozen ? 'bg-red-500/20 text-red-400 group-hover:bg-red-500 group-hover:text-white transition-colors' : 'bg-gray-700 text-gray-500'}`}>
                           {atk.icon}
                        </div>
                        <div className="text-center z-10">
                          <div className="font-bold text-white text-lg tracking-wide">{atk.name}</div>
                          <div className="text-xs font-mono text-gray-400 mt-1">COST: {finalCost} CACHE {isMulti && '(2x)'}</div>
                        </div>
                        
                        {isOnCooldown && (
                          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-20">
                             <Clock className="text-red-500 mb-1" size={24} />
                             <span className="text-2xl font-bold text-red-500">{cooldownTime}s</span>
                          </div>
                        )}

                        {canAfford && !isOnCooldown && <div className="absolute inset-0 bg-gradient-to-t from-red-900/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-auto text-center text-xs text-gray-500 font-mono">
                   Secure connection established. Deploy malware to disrupt rival I/O operations.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* COMBAT LOG (Bottom Overlay) */}
        <div className="absolute bottom-4 left-4 z-40 w-96 pointer-events-none">
          <div className="flex flex-col gap-1 items-start">
             {logs.map(log => (
               <div key={log.id} className={`text-xs px-3 py-1.5 rounded bg-black/80 border-l-4 backdrop-blur-md animate-in slide-in-from-left fade-in duration-300 shadow-lg
                 ${log.type === 'danger' ? 'border-red-500 text-red-200' : log.type === 'success' ? 'border-green-500 text-green-200' : 'border-gray-500 text-gray-300'}`}>
                 {log.text}
               </div>
             ))}
          </div>
        </div>
      </div>

      {/* GAME OVER OVERLAY */}
      {gameState === 'GAMEOVER' && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center backdrop-blur-sm animate-in fade-in duration-1000">
           <div className="text-center p-12 border-2 border-gray-800 bg-gray-950 rounded-2xl shadow-2xl max-w-2xl w-full relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-blue-500 via-purple-500 to-orange-500"></div>
              
              <Trophy size={64} className="mx-auto text-yellow-500 mb-6 animate-bounce" />
              <h2 className="text-6xl font-black text-white mb-2 tracking-tighter">GAME OVER</h2>
              <div className="text-2xl text-gray-400 mb-8 font-mono">{gameResult?.reason}</div>
              
              <div className="py-8 border-y border-gray-800 mb-8 bg-gray-900/50">
                 <div className="text-sm text-gray-500 uppercase tracking-widest mb-2">WINNER</div>
                 <div className="text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-yellow-600">
                    {gameResult?.winner}
                 </div>
              </div>

              <div className="flex justify-center gap-4">
                  <button 
                    onClick={() => window.location.reload()}
                    className="px-8 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded font-bold transition-all border border-gray-700"
                  >
                    LEAVE GAME
                  </button>
                  {isConnected && (
                      <button 
                        onClick={() => socket.emit('reset_lobby')}
                        className="px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold transition-all shadow-lg shadow-blue-900/20"
                      >
                        RETURN TO LOBBY
                      </button>
                  )}
              </div>
           </div>
        </div>
      )}

      {/* RIGHT: RIVALS SIDEBAR */}
      <div className="w-64 bg-gray-950 border-l border-gray-800 flex flex-col p-4 shadow-xl z-20">
        <div className="flex items-center gap-2 text-gray-400 mb-6 pb-2 border-b border-gray-800">
           <Swords size={16} />
           <span className="text-xs font-bold tracking-widest uppercase">Live Rivals</span>
        </div>

        <div className="space-y-4">
          {Object.keys(rivals).map(teamId => {
            const rival = rivals[teamId];
            return (
              <div key={teamId} className={`p-4 rounded-lg bg-gray-900 border ${targetTeam === teamId && myRole === 'HACKER' ? 'border-red-500 ring-1 ring-red-500 shadow-[0_0_15px_rgba(239,68,68,0.2)]' : 'border-gray-800'} relative overflow-hidden transition-all`}>
                
                {targetTeam === teamId && myRole === 'HACKER' && (
                  <div className="absolute top-2 right-2 text-red-500 animate-pulse"><Target size={16}/></div>
                )}

                <div className={`text-sm font-bold mb-2 ${rival.color}`}>{rival.name}</div>
                
                {/* Stats */}
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                      <span>HP</span>
                      <span>{rival.hp}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-gray-800 rounded-full">
                      <div className="h-full bg-red-500 rounded-full transition-all duration-500" style={{ width: `${rival.hp}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                      <span>SCORE</span>
                      <span className="text-white font-mono">{rival.score}</span>
                    </div>
                  </div>
                </div>

                {rival.hp <= 0 && (
                   <div className="absolute inset-0 bg-black/90 flex items-center justify-center text-red-600 font-bold tracking-widest border-2 border-red-600">CRASHED</div>
                )}
              </div>
            )
          })}
        </div>
        
        <div className="mt-auto p-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
             <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Team Comms</div>
             <div className="text-xs text-gray-400 italic">
               "{(!isConnected && fillBots) ? 'Bots active. Following standard protocols.' : isConnected ? 'Live Connection Established' : 'Waiting for human teammates...'}"
             </div>
        </div>
      </div>

    </div>
  );
}
