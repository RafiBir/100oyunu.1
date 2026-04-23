const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const WebSocket  = require('ws');
const { insertScore, getTopScores, getRank, clearScores } = require('./db');

const ADMIN_KEY   = process.env.ADMIN_KEY || 'gizli123';
const VALID_MODES = ['serbest', 'surpriz'];

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /api/scores?limit=20&mode=serbest
app.get('/api/scores', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const mode  = VALID_MODES.includes(req.query.mode) ? req.query.mode : 'serbest';
  res.json(getTopScores(limit, mode));
});

// POST /api/scores  { nickname, score, mode }
app.post('/api/scores', (req, res) => {
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

  insertScore(nickname, score, date, mode);
  const { rank, total } = getRank(score, mode);
  res.json({ rank, total });
});

// DELETE /api/scores?key=ADMIN_KEY&mode=serbest
app.delete('/api/scores', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Yetkisiz.' });
  const mode = VALID_MODES.includes(req.query.mode) ? req.query.mode : null;
  clearScores(mode);
  res.json({ ok: true });
});

// ── WebSocket Matchmaking ────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const queue = [];        // { ws, nickname }
const rooms = new Map(); // id → room
let   nextRoomId = 1;

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
  setTimeout(() => rooms.delete(room.id), 30000);
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

  wsSend(p1.ws, { type: 'matched', opponentNickname: p2.nickname });
  wsSend(p2.ws, { type: 'matched', opponentNickname: p1.nickname });

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

    // ── join: enter matchmaking queue ───────────────────────────
    if (data.type === 'join') {
      const nickname = String(data.nickname || 'Player').trim().slice(0, 20) || 'Player';
      ws._nickname = nickname;

      // Clean stale entries from queue
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
      }

      if (queue.length > 0) {
        const opponent = queue.shift();
        createRoom({ ws, nickname }, opponent);
      } else {
        wsSend(ws, { type: 'waiting' });
        queue.push({ ws, nickname });
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
        // İkisi de kabul etti — odayı sıfırla ve yeni oyun başlat
        room.ended    = false;
        room.scores   = [0, 0];
        room.gameOver = [false, false];
        room.rematch  = [false, false];
        room.timeLeft = 90;
        startRoomGame(room);
      }
    }

    // ── ping ─────────────────────────────────────────────────────
    else if (data.type === 'ping') {
      wsSend(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    // Remove from queue if still waiting
    const qi = queue.findIndex(p => p.ws === ws);
    if (qi !== -1) { queue.splice(qi, 1); return; }

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
