import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ storage: multer.memoryStorage() });
const env = loadEnv(path.join(__dirname, '.env'));
const PORT = Number(env.PORT || 3000);
const APP_TITLE = env.APP_TITLE || 'AMET - Control de Votación';
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || '';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server);
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const db = new Database(path.join(__dirname, 'data', 'votacion.sqlite'));

initDb();
seedIfEmpty();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, title: APP_TITLE, telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
});

app.get('/api/summary', (_req, res) => {
  const total = scalar('SELECT COUNT(*) FROM voters');
  const voted = scalar('SELECT COUNT(*) FROM voters WHERE voted = 1');
  const pending = total - voted;
  res.json({ ok: true, total, voted, pending });
});

app.get('/api/voters', (req, res) => {
  const q = normalize(req.query.q || '');
  const escuela = String(req.query.escuela || '').trim();
  const mesa = String(req.query.mesa || '').trim();

  let sql = 'SELECT * FROM voters WHERE 1=1';
  const params = [];

  if (escuela) {
    sql += ' AND escuela = ?';
    params.push(escuela);
  }
  if (mesa) {
    sql += ' AND mesa = ?';
    params.push(mesa);
  }

  let rows = db.prepare(sql + ' ORDER BY full_name COLLATE NOCASE ASC').all(...params);
  if (q) {
    rows = rows.filter((row) => normalize(`${row.dni} ${row.full_name} ${row.escuela} ${row.mesa} ${row.hoja}`).includes(q));
  }
  res.json({ ok: true, rows });
});

app.get('/api/filters', (_req, res) => {
  const escuelas = db.prepare('SELECT DISTINCT escuela FROM voters WHERE escuela <> "" ORDER BY escuela').all().map(r => r.escuela);
  const mesas = db.prepare('SELECT DISTINCT mesa FROM voters WHERE mesa <> "" ORDER BY CAST(mesa AS INTEGER), mesa').all().map(r => r.mesa);
  res.json({ ok: true, escuelas, mesas });
});

app.post('/api/import/default', (_req, res) => {
  importSeedJson(path.join(__dirname, 'data', 'padron_amet_seed.json'));
  emitRefresh();
  res.json({ ok: true, message: 'Padrón AMET cargado desde el archivo base incluido.' });
});

app.post('/api/import/excel', upload.single('excel'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Falta el archivo Excel.' });
  const rows = parseExcelBuffer(req.file.buffer);
  replaceAllVoters(rows);
  emitRefresh();
  res.json({ ok: true, imported: rows.length });
});

app.post('/api/voters/:id/toggle', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const row = db.prepare('SELECT * FROM voters WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'No se encontró el votante.' });

  const nextVoted = row.voted ? 0 : 1;
  const votedAt = nextVoted ? new Date().toISOString() : '';
  const updatedAt = new Date().toISOString();

  db.prepare('UPDATE voters SET voted = ?, voted_at = ?, updated_at = ? WHERE id = ?').run(nextVoted, votedAt, updatedAt, id);
  const updated = db.prepare('SELECT * FROM voters WHERE id = ?').get(id);

  emitRefresh();

  if (nextVoted) {
    try {
      await sendTelegram(updated);
    } catch (error) {
      console.error('Telegram error:', error.message);
    }
  }

  res.json({ ok: true, row: updated });
});

app.post('/api/reset-votes', (_req, res) => {
  db.prepare('UPDATE voters SET voted = 0, voted_at = "", updated_at = ""').run();
  emitRefresh();
  res.json({ ok: true });
});

app.get('/api/export.xlsx', (_req, res) => {
  const rows = db.prepare('SELECT * FROM voters ORDER BY CAST(mesa AS INTEGER), full_name COLLATE NOCASE').all();
  const data = rows.map((r) => ({
    DNI: r.dni,
    'Apellido y nombre': r.full_name,
    Escuela: r.escuela,
    Mesa: r.mesa,
    Hoja: r.hoja,
    'N° en padrón': r.padron_numero,
    Estado: r.voted ? 'VOTÓ' : 'PENDIENTE',
    'Hora de voto': formatDate(r.voted_at)
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Control');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="control_votacion_actualizado.xlsx"');
  res.send(buffer);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('sync', { ts: Date.now() });
});

server.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voters (
      id TEXT PRIMARY KEY,
      dni TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      escuela TEXT NOT NULL DEFAULT '',
      mesa TEXT NOT NULL DEFAULT '',
      hoja TEXT NOT NULL DEFAULT '',
      padron_numero TEXT NOT NULL DEFAULT '',
      fila_hoja TEXT NOT NULL DEFAULT '',
      voted INTEGER NOT NULL DEFAULT 0,
      voted_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
}

function seedIfEmpty() {
  const count = scalar('SELECT COUNT(*) FROM voters');
  if (!count) {
    importSeedJson(path.join(__dirname, 'data', 'padron_amet_seed.json'));
  }
}

function importSeedJson(filePath) {
  const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  replaceAllVoters(rows);
}

function replaceAllVoters(rows) {
  const trx = db.transaction((items) => {
    db.prepare('DELETE FROM voters').run();
    const stmt = db.prepare(`
      INSERT INTO voters (
        id, dni, full_name, escuela, mesa, hoja, padron_numero, fila_hoja, voted, voted_at, updated_at
      ) VALUES (
        @id, @dni, @full_name, @escuela, @mesa, @hoja, @padron_numero, @fila_hoja, @voted, @voted_at, @updated_at
      )
    `);
    for (const item of items) stmt.run(item);
  });
  trx(rows.map(cleanVoter));
}

function parseExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const baseSheetName = workbook.SheetNames.find(name => normalize(name) === 'base');
  if (baseSheetName) {
    const sheet = workbook.Sheets[baseSheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return json.map((row, index) => ({
      id: String(row['DNI'] || row['DNI_NORM'] || `${row['Apellido y Nombre'] || 'sin-dni'}-${index}`).trim(),
      dni: String(row['DNI'] || row['DNI_NORM'] || '').trim(),
      fullName: String(row['Apellido y Nombre'] || '').trim(),
      escuela: String(row['Escuela / Mesa'] || '').trim(),
      mesa: String(row['Mesa'] || '').trim(),
      hoja: String(row['Hoja'] || '').trim(),
      padronNumero: String(row['N° en padrón'] || '').trim(),
      filaHoja: String(row['Fila en hoja'] || '').trim(),
      voted: false,
      votedAt: '',
      updatedAt: ''
    })).filter(row => row.fullName || row.dni);
  }

  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  return json.map((row, index) => ({
    id: String(row['DNI'] || `${row['Apellido y nombre'] || row['Apellido y Nombre'] || 'sin-dni'}-${index}`).trim(),
    dni: String(row['DNI'] || '').trim(),
    fullName: String(row['Apellido y nombre'] || row['Apellido y Nombre'] || '').trim(),
    escuela: String(row['Escuela'] || '').trim(),
    mesa: String(row['Mesa'] || '').trim(),
    hoja: String(row['Hoja'] || '').trim(),
    padronNumero: String(row['N° en padrón'] || '').trim(),
    filaHoja: String(row['Fila en hoja'] || '').trim(),
    voted: false,
    votedAt: '',
    updatedAt: ''
  })).filter(row => row.fullName || row.dni);
}

function cleanVoter(item) {
  return {
    id: String(item.id || item.dni || cryptoRandom()).trim(),
    dni: String(item.dni || '').trim(),
    full_name: String(item.fullName || item.full_name || '').trim(),
    escuela: String(item.escuela || '').trim(),
    mesa: String(item.mesa || '').trim(),
    hoja: String(item.hoja || '').trim(),
    padron_numero: String(item.padronNumero || item.padron_numero || '').trim(),
    fila_hoja: String(item.filaHoja || item.fila_hoja || '').trim(),
    voted: item.voted ? 1 : 0,
    voted_at: String(item.votedAt || item.voted_at || '').trim(),
    updated_at: String(item.updatedAt || item.updated_at || '').trim()
  };
}

async function sendTelegram(voter) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const lines = [
    '✅ <b>Ya votó</b>',
    voter.full_name ? `👤 <b>Nombre:</b> ${escapeHtml(voter.full_name)}` : '',
    voter.dni ? `🪪 <b>DNI:</b> ${escapeHtml(voter.dni)}` : '',
    voter.escuela ? `🏫 <b>Escuela:</b> ${escapeHtml(voter.escuela)}` : '',
    voter.mesa ? `🗳️ <b>Mesa:</b> ${escapeHtml(voter.mesa)}` : '',
    voter.voted_at ? `⏰ <b>Hora:</b> ${escapeHtml(formatDate(voter.voted_at))}` : ''
  ].filter(Boolean).join('\n');

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: lines,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const data = await response.json();
  if (!data.ok) throw new Error(data.description || 'No se pudo enviar a Telegram');
}

function emitRefresh() {
  io.emit('sync', { ts: Date.now() });
}

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(Object.values(row)[0] || 0);
}

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('es-AR');
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function cryptoRandom() {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// AMET PRO FINAL CONFIGURADO
