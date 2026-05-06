const fs   = require('fs');
const path = require('path');

const DB_FILES = {
  serbest: path.join(__dirname, 'scores.json'),
  surpriz: path.join(__dirname, 'scores_surpriz.json'),
};

// ── PostgreSQL (Railway) ─────────────────────────────────────────────────────
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id       SERIAL PRIMARY KEY,
      nickname TEXT    NOT NULL,
      score    INTEGER NOT NULL,
      date     TEXT    NOT NULL,
      mode     TEXT    NOT NULL DEFAULT 'serbest'
    )
  `).catch(console.error);

  async function insertScore(nickname, score, date, mode = 'serbest') {
    await pool.query(
      'INSERT INTO scores (nickname, score, date, mode) VALUES ($1, $2, $3, $4)',
      [nickname, score, date, mode]
    );
  }

  async function getTopScores(limit = 20, mode = 'serbest') {
    // RANK() = competition ranking (1,2,2,4) — tied scores share a rank, next rank skips
    const r = await pool.query(
      `SELECT nickname, score, date, RANK() OVER (ORDER BY score DESC) AS rank
       FROM scores WHERE mode = $1 ORDER BY score DESC LIMIT $2`,
      [mode, limit]
    );
    return r.rows.map(row => ({ rank: parseInt(row.rank), nickname: row.nickname, score: row.score, date: row.date }));
  }

  async function getRank(score, mode = 'serbest') {
    const better = await pool.query(
      'SELECT COUNT(*) FROM scores WHERE mode = $1 AND score > $2',
      [mode, score]
    );
    const total = await pool.query(
      'SELECT COUNT(*) FROM scores WHERE mode = $1',
      [mode]
    );
    return {
      rank:  parseInt(better.rows[0].count) + 1,
      total: parseInt(total.rows[0].count),
    };
  }

  async function clearScores(mode) {
    if (mode) await pool.query('DELETE FROM scores WHERE mode = $1', [mode]);
    else      await pool.query('DELETE FROM scores');
  }

  module.exports = { insertScore, getTopScores, getRank, clearScores };

// ── JSON fallback (lokal geliştirme) ────────────────────────────────────────
} else {
  function load(mode = 'serbest') {
    const file = DB_FILES[mode] || DB_FILES.serbest;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }

  function save(data, mode = 'serbest') {
    const file = DB_FILES[mode] || DB_FILES.serbest;
    fs.writeFileSync(file, JSON.stringify(data));
  }

  function insertScore(nickname, score, date, mode = 'serbest') {
    const data = load(mode);
    data.push({ nickname, score, date });
    save(data, mode);
  }

  function getTopScores(limit = 20, mode = 'serbest') {
    // Competition ranking (1,2,2,4) — compute rank over full sorted list, then slice
    const sorted = load(mode).sort((a, b) => b.score - a.score);
    let prevScore = null, prevRank = 0;
    const ranked = sorted.map((r, i) => {
      if (r.score !== prevScore) { prevRank = i + 1; prevScore = r.score; }
      return { rank: prevRank, nickname: r.nickname, score: r.score, date: r.date };
    });
    return ranked.slice(0, limit);
  }

  function getRank(score, mode = 'serbest') {
    const data   = load(mode);
    const better = data.filter(r => r.score > score).length;
    return { rank: better + 1, total: data.length };
  }

  function clearScores(mode) {
    if (mode) save([], mode);
    else Object.keys(DB_FILES).forEach(m => save([], m));
  }

  module.exports = { insertScore, getTopScores, getRank, clearScores };
}
