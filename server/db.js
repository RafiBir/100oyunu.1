const fs   = require('fs');
const path = require('path');

const DB_FILES = {
  serbest: path.join(__dirname, 'scores.json'),
  surpriz: path.join(__dirname, 'scores_surpriz.json'),
};

function load(mode = 'serbest') {
  const file = DB_FILES[mode] || DB_FILES.serbest;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
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
  return load(mode)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, nickname: r.nickname, score: r.score, date: r.date }));
}

function getRank(score, mode = 'serbest') {
  const data   = load(mode);
  const better = data.filter(r => r.score > score).length;
  return { rank: better + 1, total: data.length };
}

function clearScores(mode = 'serbest') {
  save([], mode);
}

module.exports = { insertScore, getTopScores, getRank, clearScores };
