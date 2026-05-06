const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const WebSocket  = require('ws');
const { insertScore, getTopScores, getRank, clearScores } = require('./db');

const ADMIN_KEY   = process.env.ADMIN_KEY;
const VALID_MODES = ['serbest', 'surpriz'];

const scoreRateLimit = new Map(); // ip -> lastSubmitMs

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: function(origin, cb) {
    const allowed = ['https://rafibir.github.io', 'http://localhost:3001', 'http://localhost:5500', 'http://127.0.0.1:5500'];
    if (!origin || origin === 'null' || allowed.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /api/scores?limit=20&mode=serbest
app.get('/api/scores', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const mode  = VALID_MODES.includes(req.query.mode) ? req.query.mode : 'serbest';
    res.json(await getTopScores(limit, mode));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scores  { nickname, score, mode }
app.post('/api/scores', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const last = scoreRateLimit.get(ip) || 0;
    if (now - last < 60_000) return res.status(429).json({ error: 'Çok sık istek. 1 dakika bekle.' });
    scoreRateLimit.set(ip, now);

    let { nickname, score, mode } = req.body;

    if (typeof nickname !== 'string' || nickname.trim().length === 0) {
      return res.status(400).json({ error: 'Geçerli bir nickname gir.' });
    }
    nickname = escapeHtml(nickname.trim()).slice(0, 20);

    score = parseInt(score);
    if (isNaN(score) || score < 1 || score > 100) {
      return res.status(400).json({ error: 'Skor 1-100 arasında olmalı.' });
    }

    if (!VALID_MODES.includes(mode)) mode = 'serbest';

    const date = new Date().toLocaleDateString('tr-TR', {
      day: '2-digit', month: '2-digit', year: '2-digit'
    });

    await insertScore(nickname, score, date, mode);
    const { rank, total } = await getRank(score, mode);
    res.json({ rank, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/scores?key=ADMIN_KEY&mode=serbest
app.delete('/api/scores', async (req, res) => {
  try {
    if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin endpoint disabled.' });
    if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Yetkisiz.' });
    const mode = VALID_MODES.includes(req.query.mode) ? req.query.mode : null;
    await clearScores(mode);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WebSocket Matchmaking ────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const queue        = [];        // { ws, nickname }
const coopQueue    = [];        // { ws, nickname, rank }
const coopQueue4   = [];        // { ws, nickname, rank }
const sabotajQueue = [];        // { ws, nickname, rank }
const blockQueues  = new Map(); // playerCount -> [{ ws, nickname, rank }]
const rooms        = new Map(); // id → room
const privateRooms = new Map(); // code → { ws|players, nickname, rank, timeout, mode }
let   nextRoomId   = 1;

function genCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); }
  while (privateRooms.has(code));
  return code;
}

function wsSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function endRoom(room) {
  clearInterval(room.timerInterval);
  room.timerInterval = null;

  const [s0, s1] = room.scores;
  room.players.forEach((p, i) => {
    if (!p) return;
    const mine = room.scores[i];
    const opp  = room.scores[1 - i];
    const winner = mine > opp ? 'you' : opp > mine ? 'opponent' : 'draw';
    wsSend(p.ws, { type: 'result', yourScore: mine, opponentScore: opp, winner });
  });

  // Odayı 30 saniye rematch için açık tut
  room.ended   = true;
  room.rematch = [false, false];
  room.timerInterval = null;
  room._deleteTimeout = setTimeout(() => rooms.delete(room.id), 30000);
}

function createCoopRoom(p1, p2) {
  const id = nextRoomId++;
  const room = {
    id,
    type: 'coop',
    players: [p1, p2],
    coopCurrentNumber: 1,
    coopGameOver: false,
    timerInterval: null,
  };
  p1.ws._roomId = id; p1.ws._playerIdx = 0;
  p2.ws._roomId = id; p2.ws._playerIdx = 1;
  rooms.set(id, room);

  // player 0 = odd (1,3,5...), player 1 = even (2,4,6...)
  setTimeout(() => {
    if (!rooms.has(id)) return;
    wsSend(p1.ws, { type: 'coopMatched', opponentNickname: p2.nickname, opponentRank: p2.rank || null, yourRole: 'odd' });
    wsSend(p2.ws, { type: 'coopMatched', opponentNickname: p1.nickname, opponentRank: p1.rank || null, yourRole: 'even' });
  }, 500);

  setTimeout(() => {
    if (!rooms.has(id)) return;
    wsSend(p1.ws, { type: 'coopStart' });
    wsSend(p2.ws, { type: 'coopStart' });
    wsSend(p1.ws, { type: 'coopYourTurn', n: 1 });
  }, 2000);
}

function createCoop4Room(players) {
  const id = nextRoomId++;
  const room = {
    id, type: 'coop4', players,
    currentNumber: 1, lastR: -1, lastC: -1,
    turnIdx: 0,
    activePlayers: players.map((_, i) => i),
    gameOver: false,
  };
  players.forEach((p, i) => { p.ws._roomId = id; p.ws._playerIdx = i; });
  rooms.set(id, room);

  players.forEach((p, i) => wsSend(p.ws, {
    type: 'coop4Matched', playerIdx: i,
    players: players.map(pl => ({ nickname: pl.nickname, rank: pl.rank || null })),
  }));

  setTimeout(() => {
    if (!rooms.has(id)) return;
    players.forEach(p => wsSend(p.ws, { type: 'coop4Start' }));
    players.forEach(p => wsSend(p.ws, { type: 'coop4Turn', turnIdx: 0, n: 1 }));
  }, 1500);
}

function createRoom(p1, p2) {
  const id = nextRoomId++;
  const room = {
    id,
    players: [p1, p2],
    scores:  [0, 0],
    gameOver:[false, false],
    timerInterval: null,
    timeLeft: 45,
  };

  p1.ws._roomId      = id;
  p1.ws._playerIdx   = 0;
  p2.ws._roomId      = id;
  p2.ws._playerIdx   = 1;

  rooms.set(id, room);

  startRoomGame(room);
}

function startRoomGame(room) {
  const [p1, p2] = room.players;

  wsSend(p1.ws, { type: 'matched', opponentNickname: p2.nickname, opponentRank: p2.rank || null });
  wsSend(p2.ws, { type: 'matched', opponentNickname: p1.nickname, opponentRank: p1.rank || null });

  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    wsSend(p1.ws, { type: 'start' });
    wsSend(p2.ws, { type: 'start' });

    room.timerInterval = setInterval(() => {
      room.timeLeft--;
      wsSend(p1.ws, { type: 'tick', timeLeft: room.timeLeft });
      wsSend(p2.ws, { type: 'tick', timeLeft: room.timeLeft });

      if (room.timeLeft <= 0) {
        room.gameOver[0] = true;
        room.gameOver[1] = true;
        endRoom(room);
      }
    }, 1000);
  }, 1500);
}

function validBlockMove(room, idx, r, c) {
  if (r < 0 || r >= room.size || c < 0 || c >= room.size) return false;
  if (room.board[r][c]) return false;
  const last = room.last[idx];
  if (last.r === -1 || last.c === -1) return true;
  const dr = Math.abs(r - last.r), dc = Math.abs(c - last.c);
  return (dr === 0 && dc === 3) || (dc === 0 && dr === 3) || (dr === 2 && dc === 2);
}

function blockHasMove(room, idx) {
  if (!room.alive[idx]) return false;
  for (let r = 0; r < room.size; r++) for (let c = 0; c < room.size; c++) if (validBlockMove(room, idx, r, c)) return true;
  return false;
}

function blockAliveIndexes(room) {
  return room.alive.map((v, i) => v ? i : -1).filter(i => i !== -1);
}

function getBlockPlayerCount(value) {
  const n = parseInt(value);
  return n === 4 ? 4 : 2;
}

function getBlockQueue(playerCount) {
  const count = getBlockPlayerCount(playerCount);
  if (!blockQueues.has(count)) blockQueues.set(count, []);
  return blockQueues.get(count);
}

function notifyBlockQueue(blockQueue, playerCount) {
  blockQueue.forEach(p => wsSend(p.ws, {
    type: 'blockWaiting',
    joined: blockQueue.length,
    playerCount,
  }));
}

function notifyCoop4Queue() {
  coopQueue4.forEach(p => wsSend(p.ws, {
    type: 'coop4Waiting',
    position: coopQueue4.length,
    joined: coopQueue4.length,
    playerCount: 4,
  }));
}

function blockPayload(room) {
  return {
    players: room.players.map((p, i) => ({ nickname: p.nickname, rank: p.rank || null, alive: room.alive[i], score: room.scores[i] })),
    turnIndex: room.turnIndex,
    board: room.board,
  };
}

function blockBroadcast(room, data) {
  room.players.forEach(p => { if (p) wsSend(p.ws, data); });
}

function startBlockTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (room.ended) return;
    const idx = room.turnIndex;
    if (!room.alive[idx]) return;
    room.alive[idx] = false;
    room.turnTimer = null;
    const alive = blockAliveIndexes(room);
    if (alive.length <= 1) endBlockRoom(room, alive[0] ?? idx, 'timeout');
    else advanceBlockTurn(room, [idx]);
  }, 20000);
}

function endBlockRoom(room, winnerIdx, reason = 'lastStanding') {
  if (room.ended) return;
  room.ended = true;
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.rematchVotes = new Array(room.players.length).fill(false);
  room.players.forEach((p, i) => {
    if (!p) return;
    wsSend(p.ws, { type: 'blockResult', winner: i === winnerIdx ? 'you' : 'opponent', winnerIndex: winnerIdx, winnerName: room.players[winnerIdx]?.nickname || 'Player', reason, players: blockPayload(room).players, board: room.board });
    // Keep _roomId/_playerIdx so client can request rematch
  });
  // Hold room for 30s to allow rematch (mirrors race rematch behavior)
  room._deleteTimeout = setTimeout(() => {
    rooms.delete(room.id);
    room.players.forEach(p => {
      if (p && p.ws.readyState === WebSocket.OPEN) {
        p.ws._roomId = null;
        p.ws._playerIdx = null;
      }
    });
  }, 30000);
}

function advanceBlockTurn(room, eliminatedNow = []) {
  const alive = blockAliveIndexes(room);
  if (alive.length <= 1) { endBlockRoom(room, alive[0] ?? 0); return; }

  const eliminated = [...eliminatedNow];
  for (let step = 1; step <= room.players.length; step++) {
    const idx = (room.turnIndex + step) % room.players.length;
    if (!room.alive[idx]) continue;

    if (blockHasMove(room, idx)) {
      room.turnIndex = idx;
      eliminated.forEach(playerIndex => blockBroadcast(room, { type: 'blockEliminated', playerIndex, ...blockPayload(room) }));
      blockBroadcast(room, { type: 'blockTurn', ...blockPayload(room) });
      startBlockTurnTimer(room);
      return;
    }

    room.alive[idx] = false;
    eliminated.push(idx);
    const stillAlive = blockAliveIndexes(room);
    if (stillAlive.length <= 1) { endBlockRoom(room, stillAlive[0] ?? idx); return; }
  }
}

function createBlockRoom(players) {
  const id = nextRoomId++;
  const size = 10;
  const count = players.length;
  const room = {
    id, type: 'block', size, players,
    board: Array.from({ length: size }, () => Array(size).fill(null)),
    scores: Array(count).fill(0),
    numbers: Array(count).fill(1),
    last: Array.from({ length: count }, () => ({ r: -1, c: -1 })),
    alive: Array(count).fill(true),
    turnIndex: 0,
    ended: false,
    playerCount: count,
    turnTimer: null,
  };

  players.forEach((p, i) => {
    p.ws._roomId = id;
    p.ws._playerIdx = i;
  });
  rooms.set(id, room);

  players.forEach((p, i) => {
    wsSend(p.ws, {
      type: 'blockMatched',
      playerCount: count,
      players: players.map(x => ({ nickname: x.nickname, rank: x.rank || null })),
      yourIndex: i,
    });
  });

  setTimeout(() => {
    if (!rooms.has(id)) return;
    players.forEach((p, i) => wsSend(p.ws, { type: 'blockStart', yourIndex: i, playerCount: count, ...blockPayload(room) }));
    startBlockTurnTimer(room);
  }, 1200);
}

wss.on('connection', (ws) => {
  ws._roomId    = null;
  ws._playerIdx = null;
  ws._nickname  = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { console.warn('[ws] invalid JSON from client', e.message, String(raw).slice(0, 200)); return; }

    // ── createPrivate: create a private room with invite code ───
    if (data.type === 'createPrivate') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname;
      ws._rank = rank;
      const mode = data.mode === 'coop' ? 'coop' : data.mode === 'block' ? 'block' : 'race';
      const code = genCode();
      const timeout = setTimeout(() => privateRooms.delete(code), 5 * 60 * 1000);
      if (mode === 'block') {
        const playerCount = getBlockPlayerCount(data.playerCount);
        privateRooms.set(code, { ws, nickname, rank, timeout, mode, playerCount, players: [{ ws, nickname, rank }] });
      } else if (mode === 'coop') {
        const playerCount = Number(data.playerCount) === 4 ? 4 : 2;
        privateRooms.set(code, { ws, nickname, rank, timeout, mode, playerCount, players: [{ ws, nickname, rank }] });
      } else {
        privateRooms.set(code, { ws, nickname, rank, timeout, mode });
      }
      wsSend(ws, { type: 'privateCreated', code, playerCount: privateRooms.get(code)?.playerCount || 2, joined: 1 });
    }

    // ── joinPrivate: join a private room by code ─────────────────
    else if (data.type === 'joinPrivate') {
      const code = String(data.code || '').toUpperCase().trim();
      const host = privateRooms.get(code);
      if (!host || host.ws.readyState !== WebSocket.OPEN) {
        wsSend(ws, { type: 'privateNotFound' });
        return;
      }
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname;
      ws._rank = rank;
      if (host.mode === 'block') {
        host.players = (host.players || [{ ws: host.ws, nickname: host.nickname, rank: host.rank }]).filter(p => p.ws.readyState === WebSocket.OPEN);
        if (host.players.some(p => p.ws === ws)) return;
        host.players.push({ ws, nickname, rank });
        host.players.forEach((p, i) => wsSend(p.ws, { type: 'blockPrivateWaiting', code, joined: host.players.length, playerCount: host.playerCount, yourIndex: i }));
        if (host.players.length >= host.playerCount) {
          clearTimeout(host.timeout);
          privateRooms.delete(code);
          createBlockRoom(host.players.slice(0, host.playerCount));
        }
      } else if (host.mode === 'coop' && host.playerCount === 4) {
        host.players = (host.players || [{ ws: host.ws, nickname: host.nickname, rank: host.rank }]).filter(p => p.ws.readyState === WebSocket.OPEN);
        if (host.players.some(p => p.ws === ws)) return;
        host.players.push({ ws, nickname, rank });
        host.players.forEach((p, i) => wsSend(p.ws, { type: 'coopPrivateWaiting', code, joined: host.players.length, playerCount: host.playerCount, playerIdx: i }));
        if (host.players.length >= host.playerCount) {
          clearTimeout(host.timeout);
          privateRooms.delete(code);
          createCoop4Room(host.players.slice(0, host.playerCount));
        }
      } else {
        clearTimeout(host.timeout);
        privateRooms.delete(code);
        if (host.mode === 'coop') {
          createCoopRoom({ ws, nickname, rank }, { ws: host.ws, nickname: host.nickname, rank: host.rank });
        } else {
          createRoom({ ws, nickname, rank }, { ws: host.ws, nickname: host.nickname, rank: host.rank });
        }
      }
    }

    // ── join: enter matchmaking queue ───────────────────────────
    else if (data.type === 'join') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname;
      ws._rank = rank;

      // Clean stale entries from queue
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
      }

      if (queue.length > 0) {
        const opponent = queue.shift();
        createRoom({ ws, nickname, rank }, opponent);
      } else {
        wsSend(ws, { type: 'waiting' });
        queue.push({ ws, nickname, rank });
      }
    }

    // ── move: player placed a number ────────────────────────────
    else if (data.type === 'move') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const idx = ws._playerIdx;
      const r = parseInt(data.r);
      const c = parseInt(data.c);
      const n = parseInt(data.n);

      if (isNaN(r) || isNaN(c) || isNaN(n)) return;
      if (r < 0 || r > 5 || c < 0 || c > 5)  return;
      if (room.scores[idx] >= 36)              return;

      room.scores[idx]++;

      const opp = room.players[1 - idx];
      if (opp) wsSend(opp.ws, { type: 'opponentMove', r, c, n, score: room.scores[idx] });
    }

    // ── noMoves: player is stuck ─────────────────────────────────
    else if (data.type === 'noMoves') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const idx = ws._playerIdx;
      if (room.gameOver[idx]) return;
      room.gameOver[idx] = true;

      const opp = room.players[1 - idx];
      if (opp) wsSend(opp.ws, { type: 'opponentNoMoves' });

      if (room.gameOver[0] && room.gameOver[1]) endRoom(room);
    }

    // ── rematch: oyun bitti, tekrar oyna ────────────────────────
    else if (data.type === 'rematch') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || !room.ended) return;

      const idx = ws._playerIdx;
      room.rematch[idx] = true;

      const opp = room.players[1 - idx];
      if (opp) wsSend(opp.ws, { type: 'rematchRequest' });

      if (room.rematch[0] && room.rematch[1]) {
        // İkisi de kabul etti — silme timeout'unu iptal et, odayı sıfırla
        clearTimeout(room._deleteTimeout);
        room._deleteTimeout = null;
        room.ended    = false;
        room.scores   = [0, 0];
        room.gameOver = [false, false];
        room.rematch  = [false, false];
        room.timeLeft = 45;
        startRoomGame(room);
      }
    }

    // ── emoji reaction ───────────────────────────────────────────
    else if (data.type === 'emoji') {
      const ALLOWED_EMOJIS = ['👍','🔥','😅','😎','🤝','💪','😂','🎉'];
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (!ALLOWED_EMOJIS.includes(data.emoji)) return;
      const idx = ws._playerIdx;
      const opp = room.players[1 - idx];
      if (opp) wsSend(opp.ws, { type: 'opponentEmoji', emoji: data.emoji });
    }

    // -- blockJoin: 2-player shared-board block mode matchmaking --
    else if (data.type === 'blockJoin') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname;
      ws._rank = rank;
      const playerCount = getBlockPlayerCount(data.playerCount);
      const blockQueue = getBlockQueue(playerCount);
      for (let i = blockQueue.length - 1; i >= 0; i--) if (blockQueue[i].ws.readyState !== WebSocket.OPEN) blockQueue.splice(i, 1);
      const alreadyQueued = blockQueue.find(p => p.ws === ws);
      if (alreadyQueued) {
        notifyBlockQueue(blockQueue, playerCount);
        return;
      }
      blockQueue.push({ ws, nickname, rank });
      notifyBlockQueue(blockQueue, playerCount);
      if (blockQueue.length >= playerCount) {
        const players = blockQueue.splice(0, playerCount);
        createBlockRoom(players);
        notifyBlockQueue(blockQueue, playerCount);
      }
    }

    // -- blockMove: shared board placement --
    else if (data.type === 'blockMove') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'block' || room.ended) return;
      const idx = ws._playerIdx;
      const r = parseInt(data.r), c = parseInt(data.c);
      if (idx !== room.turnIndex || !room.alive[idx]) return;
      if (isNaN(r) || isNaN(c) || !validBlockMove(room, idx, r, c)) return;
      const n = room.numbers[idx];
      room.board[r][c] = { player: idx, n };
      room.last[idx] = { r, c };
      room.scores[idx]++;
      room.numbers[idx]++;
      if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
      blockBroadcast(room, { type: 'blockMove', playerIndex: idx, r, c, n, ...blockPayload(room) });
      advanceBlockTurn(room);
    }

    // -- blockNoMoves: client reports being stuck --
    else if (data.type === 'blockNoMoves') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'block' || room.ended) return;
      const idx = ws._playerIdx;
      if (!room.alive[idx] || blockHasMove(room, idx)) return;
      if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
      room.alive[idx] = false;
      const alive = blockAliveIndexes(room);
      if (alive.length <= 1) endBlockRoom(room, alive[0] ?? idx);
      else advanceBlockTurn(room, [idx]);
    }

    // -- blockTimeout: client's 20s countdown hit 0, they forfeit --
    else if (data.type === 'blockTimeout') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'block' || room.ended) return;
      const idx = ws._playerIdx;
      if (!room.alive[idx]) return;
      if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
      room.alive[idx] = false;
      const alive = blockAliveIndexes(room);
      if (alive.length <= 1) endBlockRoom(room, alive[0] ?? idx, 'timeout');
      else advanceBlockTurn(room, [idx]);
    }

    // -- blockRematch: player wants to play again with same group --
    else if (data.type === 'blockRematch') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'block' || !room.ended || !room.rematchVotes) return;
      const idx = ws._playerIdx;
      if (idx === null || idx === undefined) return;
      if (room.rematchVotes[idx]) return; // already voted
      room.rematchVotes[idx] = true;

      // Currently-connected players (those who haven't disconnected post-game)
      const openIdxs = room.players.map((p, i) => p && p.ws.readyState === WebSocket.OPEN ? i : -1).filter(i => i !== -1);
      const voteCount = room.rematchVotes.filter(Boolean).length;

      // Notify all open players of vote progress
      room.players.forEach(p => {
        if (p && p.ws.readyState === WebSocket.OPEN) {
          wsSend(p.ws, { type: 'blockRematchVote', playerIndex: idx, voteCount, totalNeeded: openIdxs.length });
        }
      });

      // If all open players have voted (and at least 2 players), restart
      const allVoted = openIdxs.every(i => room.rematchVotes[i]);
      if (allVoted && openIdxs.length >= 2) {
        clearTimeout(room._deleteTimeout);
        room._deleteTimeout = null;
        // Reset state for new game
        const size = room.size;
        room.board = Array.from({ length: size }, () => Array(size).fill(null));
        room.scores = new Array(room.players.length).fill(0);
        room.numbers = new Array(room.players.length).fill(1);
        room.last = Array.from({ length: room.players.length }, () => ({ r: -1, c: -1 }));
        room.alive = room.players.map((p, i) => !!(p && p.ws.readyState === WebSocket.OPEN));
        room.turnIndex = room.alive.findIndex(a => a);
        room.ended = false;
        room.rematchVotes = null;
        // Notify all open players to start new round
        room.players.forEach((p, i) => {
          if (p && p.ws.readyState === WebSocket.OPEN) {
            wsSend(p.ws, { type: 'blockStart', yourIndex: i, playerCount: room.playerCount, ...blockPayload(room) });
          }
        });
        startBlockTurnTimer(room);
      }
    }

    // ── coopJoin: enter cooperative matchmaking ─────────────────
    else if (data.type === 'coopJoin') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname;
      ws._rank = rank;

      for (let i = coopQueue.length - 1; i >= 0; i--) {
        if (coopQueue[i].ws.readyState !== WebSocket.OPEN) coopQueue.splice(i, 1);
      }

      if (coopQueue.length > 0) {
        const partner = coopQueue.shift();
        createCoopRoom({ ws, nickname, rank }, partner);
      } else {
        wsSend(ws, { type: 'coopWaiting' });
        coopQueue.push({ ws, nickname, rank });
      }
    }

    // ── coopMove: player placed a cooperative number ─────────────
    else if (data.type === 'coopMove') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'coop' || room.coopGameOver) return;

      const idx = ws._playerIdx;
      const r = parseInt(data.r);
      const c = parseInt(data.c);
      const n = parseInt(data.n);

      if (isNaN(r) || isNaN(c) || isNaN(n)) return;
      if (r < 0 || r > 9 || c < 0 || c > 9) return;
      if (n !== room.coopCurrentNumber) return;

      // odd numbers (1,3,5...) belong to player 0; even to player 1
      const expectedIdx = (n % 2 === 1) ? 0 : 1;
      if (idx !== expectedIdx) return;

      const opp = room.players[1 - idx];
      if (opp) wsSend(opp.ws, { type: 'coopOpponentMove', r, c, n });

      room.coopCurrentNumber++;

      if (n === 100) {
        room.coopGameOver = true;
        wsSend(ws, { type: 'coopResult', outcome: 'complete', score: 100 });
        if (opp) wsSend(opp.ws, { type: 'coopResult', outcome: 'complete', score: 100 });
        rooms.delete(room.id);
        return;
      }

      const nextN = room.coopCurrentNumber;
      if (opp) wsSend(opp.ws, { type: 'coopYourTurn', n: nextN });
    }

    // ── coopStuck: a player has no valid coop moves ───────────────
    else if (data.type === 'coopStuck') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'coop' || room.coopGameOver) return;

      room.coopGameOver = true;
      const score = room.coopCurrentNumber - 1;
      room.players.forEach(p => {
        if (p) wsSend(p.ws, { type: 'coopResult', outcome: 'stuck', score });
      });
      rooms.delete(room.id);
    }

    // ── coop4Join: 4-player coop matchmaking ────────────────────
    else if (data.type === 'coop4Join') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname; ws._rank = rank;
      for (let i = coopQueue4.length - 1; i >= 0; i--) if (coopQueue4[i].ws.readyState !== WebSocket.OPEN) coopQueue4.splice(i, 1);
      if (coopQueue4.some(p => p.ws === ws)) {
        notifyCoop4Queue();
        return;
      }
      coopQueue4.push({ ws, nickname, rank });
      notifyCoop4Queue();
      if (coopQueue4.length >= 4) {
        const players = coopQueue4.splice(0, 4);
        createCoop4Room(players);
        notifyCoop4Queue();
      }
    }

    // ── coop4Move: player placed a number ───────────────────────
    else if (data.type === 'coop4Move') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'coop4' || room.gameOver) return;
      const idx = ws._playerIdx;
      if (idx !== room.turnIdx || !room.activePlayers.includes(idx)) return;
      const r = parseInt(data.r), c = parseInt(data.c), n = parseInt(data.n);
      if (isNaN(r) || isNaN(c) || isNaN(n) || r < 0 || r > 9 || c < 0 || c > 9) return;
      if (n !== room.currentNumber) return;
      room.currentNumber++;
      room.lastR = r; room.lastC = c;
      room.players.forEach(p => { if (p) wsSend(p.ws, { type: 'coop4Move', playerIdx: idx, r, c, n }); });
      if (n === 100) {
        room.gameOver = true;
        room.players.forEach(p => { if (p) wsSend(p.ws, { type: 'coop4Result', outcome: 'complete', score: 100 }); });
        rooms.delete(room.id); return;
      }
      const pos = room.activePlayers.indexOf(room.turnIdx);
      room.turnIdx = room.activePlayers[(pos + 1) % room.activePlayers.length];
      room.players.forEach(p => { if (p) wsSend(p.ws, { type: 'coop4Turn', turnIdx: room.turnIdx, n: room.currentNumber }); });
    }

    // ── coop4Stuck: current player has no valid moves ────────────
    else if (data.type === 'coop4Stuck') {
      const roomId = ws._roomId;
      if (roomId === null) return;
      const room = rooms.get(roomId);
      if (!room || room.type !== 'coop4' || room.gameOver) return;
      if (ws._playerIdx !== room.turnIdx) return;
      room.gameOver = true;
      const score = room.currentNumber - 1;
      room.players.forEach(p => { if (p) wsSend(p.ws, { type: 'coop4Result', outcome: 'stuck', score }); });
      rooms.delete(room.id);
    }

    // ── ping ─────────────────────────────────────────────────────
    else if (data.type === 'ping') {
      wsSend(ws, { type: 'pong' });
    }
  });

  ws.on('error', () => {});

  ws.on('close', () => {
    // Remove from private room if waiting for a joiner
    for (const [code, entry] of privateRooms) {
      if (entry.ws === ws || entry.players?.some(p => p.ws === ws)) {
        if ((entry.mode === 'block' || entry.mode === 'coop') && entry.players) {
          entry.players = entry.players.filter(p => p.ws !== ws && p.ws.readyState === WebSocket.OPEN);
          if (entry.players.length) {
            entry.ws = entry.players[0].ws;
            entry.nickname = entry.players[0].nickname;
            entry.rank = entry.players[0].rank;
            const type = entry.mode === 'block' ? 'blockPrivateWaiting' : 'coopPrivateWaiting';
            entry.players.forEach((p, i) => wsSend(p.ws, { type, code, joined: entry.players.length, playerCount: entry.playerCount, yourIndex: i, playerIdx: i }));
            continue;
          }
        }
        clearTimeout(entry.timeout);
        privateRooms.delete(code);
        break;
      }
    }

    // Remove from queue if still waiting
    const qi = queue.findIndex(p => p.ws === ws);
    if (qi !== -1) { queue.splice(qi, 1); return; }

    // Remove from coop queue if waiting
    const cqi = coopQueue.findIndex(p => p.ws === ws);
    if (cqi !== -1) { coopQueue.splice(cqi, 1); return; }

    // Remove from coop4 queue if waiting
    const c4qi = coopQueue4.findIndex(p => p.ws === ws);
    if (c4qi !== -1) { coopQueue4.splice(c4qi, 1); notifyCoop4Queue(); return; }

    for (const [playerCount, blockQueue] of blockQueues) {
      const bqi = blockQueue.findIndex(p => p.ws === ws);
      if (bqi !== -1) { blockQueue.splice(bqi, 1); notifyBlockQueue(blockQueue, playerCount); return; }
    }

    // Notify opponent if mid-game
    const roomId = ws._roomId;
    if (roomId !== null) {
      const room = rooms.get(roomId);
      if (room) {
        if (room.type === 'block') {
          const idx = ws._playerIdx;
          if (idx === null || idx === undefined || !room.alive[idx]) return;
          room.alive[idx] = false;
          room.players[idx].ws._roomId = null;
          room.players[idx].ws._playerIdx = null;
          const alive = blockAliveIndexes(room);
          if (alive.length <= 1) {
            endBlockRoom(room, alive[0] ?? idx, 'disconnect');
            return;
          }
          if (room.turnIndex === idx) {
            advanceBlockTurn(room, [idx]);
          } else {
            blockBroadcast(room, { type: 'blockEliminated', playerIndex: idx, ...blockPayload(room) });
            blockBroadcast(room, { type: 'blockTurn', ...blockPayload(room) });
          }
        } else if (room.type === 'coop4') {
          const idx = ws._playerIdx;
          const wasCurrentTurn = room.turnIdx === idx;
          const oldPos = room.activePlayers.indexOf(idx);
          room.players[idx] = null;
          room.activePlayers = room.activePlayers.filter(i => i !== idx);
          room.players.forEach(p => { if (p) wsSend(p.ws, { type: 'coop4PlayerLeft', playerIdx: idx }); });
          if (room.activePlayers.length <= 1) {
            room.gameOver = true;
            room.activePlayers.forEach(i => {
              if (room.players[i]) {
                wsSend(room.players[i].ws, { type: 'coop4Result', outcome: 'disconnect', score: room.currentNumber - 1 });
                room.players[i].ws._roomId = null;
              }
            });
            rooms.delete(room.id); return;
          }
          if (wasCurrentTurn) {
            const nextPos = room.activePlayers.length > 0 ? (oldPos % room.activePlayers.length) : 0;
            room.turnIdx = room.activePlayers[nextPos];
            room.players.forEach(p => { if (p) wsSend(p.ws, { type: 'coop4Turn', turnIdx: room.turnIdx, n: room.currentNumber }); });
          }
          return;
        } else {
          clearInterval(room.timerInterval);
          room.players.forEach(p => {
            if (p && p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
              wsSend(p.ws, { type: 'opponentLeft' });
              p.ws._roomId = null;
            }
          });
          rooms.delete(roomId);
        }
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
