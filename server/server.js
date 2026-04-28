const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const WebSocket  = require('ws');
const { insertScore, getTopScores, getRank, clearScores } = require('./db');

const ADMIN_KEY   = process.env.ADMIN_KEY || 'gizli123';
const VALID_MODES = ['serbest', 'surpriz'];

const scoreRateLimit = new Map(); // ip -> lastSubmitMs

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['https://rafibir.github.io', 'http://localhost:3001']
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
const rooms        = new Map(); // id → room
const privateRooms = new Map(); // code → { ws, nickname, rank, timeout }
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

function createRoom(p1, p2) {
  const id = nextRoomId++;
  const room = {
    id,
    players: [p1, p2],
    scores:  [0, 0],
    gameOver:[false, false],
    timerInterval: null,
    timeLeft: 90,
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

wss.on('connection', (ws) => {
  ws._roomId    = null;
  ws._playerIdx = null;
  ws._nickname  = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── createPrivate: create a private room with invite code ───
    if (data.type === 'createPrivate') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      const rank = (data.rank && typeof data.rank.name === 'string') ? { icon: String(data.rank.icon || '').slice(0, 8), name: String(data.rank.name).slice(0, 20) } : null;
      ws._nickname = nickname;
      ws._rank = rank;
      const mode = data.mode === 'coop' ? 'coop' : 'race';
      const code = genCode();
      const timeout = setTimeout(() => privateRooms.delete(code), 5 * 60 * 1000);
      privateRooms.set(code, { ws, nickname, rank, timeout, mode });
      wsSend(ws, { type: 'privateCreated', code });
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
      clearTimeout(host.timeout);
      privateRooms.delete(code);
      if (host.mode === 'coop') {
        createCoopRoom({ ws, nickname, rank }, { ws: host.ws, nickname: host.nickname, rank: host.rank });
      } else {
        createRoom({ ws, nickname, rank }, { ws: host.ws, nickname: host.nickname, rank: host.rank });
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
        room.timeLeft = 90;
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

    // ── ping ─────────────────────────────────────────────────────
    else if (data.type === 'ping') {
      wsSend(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    // Remove from private room if waiting for a joiner
    for (const [code, entry] of privateRooms) {
      if (entry.ws === ws) { clearTimeout(entry.timeout); privateRooms.delete(code); break; }
    }

    // Remove from queue if still waiting
    const qi = queue.findIndex(p => p.ws === ws);
    if (qi !== -1) { queue.splice(qi, 1); return; }

    // Remove from coop queue if waiting
    const cqi = coopQueue.findIndex(p => p.ws === ws);
    if (cqi !== -1) { coopQueue.splice(cqi, 1); return; }

    // Notify opponent if mid-game
    const roomId = ws._roomId;
    if (roomId !== null) {
      const room = rooms.get(roomId);
      if (room) {
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
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
