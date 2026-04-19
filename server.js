import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

const upload = multer({ storage: multer.memoryStorage() });
const env = loadEnv(path.join(__dirname, '.env'));

const PORT = Number(env.PORT || 3000);
const APP_TITLE = env.APP_TITLE || 'AMET - Control de Votación';
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || '';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = path.join(DATA_DIR, 'votacion.sqlite');
const SEED_PATH = path.join(DATA_DIR, 'padron_amet_seed.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

ensureDir(DATA_DIR);
ensureDir(BACKUP_DIR);
ensureDir(PUBLIC_DIR);

const db = new Database(DB_PATH);

initDb();
seedIfEmpty();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    title: APP_TITLE,
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
  });
});

app.get('/api/summary', (_req, res) => {
  try {
    const total = scalar('SELECT COUNT(*) FROM voters');
    const voted = scalar('SELECT COUNT(*) FROM voters WHERE voted = 1');
    const pending = total - voted;

    res.json({ ok: true, total, voted, pending });
  } catch (error) {
    console.error('Error /api/summary:', error);
    res.status(500).json({ ok: false, error: 'No se pudo obtener el resumen.' });
  }
});

app.get('/api/voters', (req, res) => {
  try {
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

    let rows = db
      .prepare(sql + ' ORDER BY full_name COLLATE NOCASE ASC')
      .all(...params);

    if (q) {
      rows = rows.filter((row) =>
        normalize(
          ${row.dni} ${row.full_name} ${row.escuela} ${row.mesa} ${row.hoja} ${row.padron_numero}
        ).includes(q)
      );
    }

    res.json({ ok: true, rows });
  } catch (error) {
    console.error('Error /api/voters:', error);
    res.status(500).json({ ok: false, error: 'No se pudo obtener el padrón.' });
  }
});

app.get('/api/filters', (_req, res) => {
  try {
    const escuelas = db
      .prepare(
        'SELECT DISTINCT escuela FROM voters WHERE TRIM(escuela) <> "" ORDER BY escuela COLLATE NOCASE'
      )
      .all()
      .map((r) => r.escuela);

    const mesas = db
      .prepare(
        `
        SELECT DISTINCT mesa
        FROM voters
        WHERE TRIM(mesa) <> ""
        ORDER BY
          CASE
            WHEN mesa GLOB '[0-9]*' THEN CAST(mesa AS INTEGER)
            ELSE 999999999
          END,
          mesa
        `
      )
      .all()
      .map((r) => r.mesa);

    res.json({ ok: true, escuelas, mesas });
  } catch (error) {
    console.error('Error /api/filters:', error);
    res.status(500).json({ ok: false, error: 'No se pudieron obtener los filtros.' });
  }
});

app.post('/api/import/default', (_req, res) => {
  try {
    if (!fs.existsSync(SEED_PATH)) {
      return res.status(404).json({
        ok: false,
        error: 'No existe el archivo base padron_amet_seed.json'
      });
    }

    importSeedJson(SEED_PATH);
    emitRefresh();

    res.json({
      ok: true,
      message: 'Padrón AMET cargado desde el archivo base incluido.'
    });
  } catch (error) {
    console.error('Error /api/import/default:', error);
    res.status(500).json({ ok: false, error: 'No se pudo cargar el padrón base.' });
  }
});

app.post('/api/import/excel', upload.single('excel'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Falta el archivo Excel.' });
    }

    const rows = parseExcelBuffer(req.file.buffer);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: 'El archivo no contiene registros válidos.'
      });
    }

    createBackup();
    replaceAllVoters(rows);
    emitRefresh();

    res.json({ ok: true, imported: rows.length });
  } catch (error) {
    console.error('Error /api/import/excel:', error);
    res.status(500).json({
      ok: false,
      error: 'No se pudo importar el archivo Excel.'
    });
  }
});

app.post('/api/voters/:id/toggle', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();

    if (!id) {
      return res.status(400).json({ ok: false, error: 'ID inválido.' });
    }

    const row = db.prepare('SELECT * FROM voters WHERE id = ?').get(id);

    if (!row) {
      return res.status(404).json({ ok: false, error: 'No se encontró el votante.' });
    }

    const nextVoted = row.voted ? 0 : 1;
    const now = new Date().toISOString();
    const votedAt = nextVoted ? now : '';
    const updatedAt = now;

    db.prepare(
      'UPDATE voters SET voted = ?, voted_at = ?, updated_at = ? WHERE id = ?'
    ).run(nextVoted, votedAt, updatedAt, id);

    const updated = db.prepare('SELECT * FROM voters WHERE id = ?').get(id);

    emitRefresh();

    if (nextVoted) {
      try {
        await sendTelegram(updated);
      } catch (error) {
        console.error('Telegram error:', error?.message || error);
      }
    }

    res.json({ ok: true, row: updated });
  } catch (error) {
    console.error('Error /api/voters/:id/toggle:', error);
    res.status(500).json({ ok: false, error: 'No se pudo actualizar el votante.' });
  }
});

app.post('/api/reset-votes', (_req, res) => {
  try {
    db.prepare('UPDATE voters SET voted = 0, voted_at = "", updated_at = ?').run(
      new Date().toISOString()
    );

    emitRefresh();
    res.json({ ok: true });
  } catch (error) {
    console.error('Error /api/reset-votes:', error);
    res.status(500).json({ ok: false, error: 'No se pudieron reiniciar los votos.' });
  }
});

app.get('/api/export.xlsx', (_req, res) => {
  try {
    const rows = db
      .prepare(
        `
        SELECT *
        FROM voters
        ORDER BY
          CASE
            WHEN mesa GLOB '[0-9]*' THEN CAST(mesa AS INTEGER)
            ELSE 999999999
          END,
          full_name COLLATE NOCASE
        `
      )
      .all();

    const data = rows.map((r) => ({
      DNI: r.dni,
      'Apellido y nombre': r.full_name,
      Escuela: r.escuela,
      Mesa: r.mesa,
      Hoja: r.hoja,
      'N° en padrón': r.padron_numero,
      'Fila en hoja': r.fila_hoja,
      Estado: r.voted ? 'VOTÓ' : 'PENDIENTE',
      'Hora de voto': formatDate(r.voted_at)
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, ws, 'Control');

    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx'
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="control_votacion_actualizado.xlsx"'
    );

    res.send(buffer);
  } catch (error) {
    console.error('Error /api/export.xlsx:', error);
    res.status(500).json({ ok: false, error: 'No se pudo exportar el Excel.' });
  }
});

io.on('connection', (socket) => {
  socket.emit('sync', { ts: Date.now() });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    ok: false,
    error: 'Error interno del servidor.'
  });
});

server.listen(PORT, () => {
  console.log(Servidor listo en http://localhost:${PORT});
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

    CREATE INDEX IF NOT EXISTS idx_voters_dni ON voters(dni);
    CREATE INDEX IF NOT EXISTS idx_voters_name ON voters(full_name);
    CREATE INDEX IF NOT EXISTS idx_voters_escuela ON voters(escuela);
    CREATE INDEX IF NOT EXISTS idx_voters_mesa ON voters(mesa);
    CREATE INDEX IF NOT EXISTS idx_voters_voted ON voters(voted);
  `);
}

function seedIfEmpty() {
  const count = scalar('SELECT COUNT(*) FROM voters');

  if (!count && fs.existsSync(SEED_PATH)) {
    try {
      importSeedJson(SEED_PATH);
      console.log('Seed cargado correctamente.');
    } catch (error) {
      console.error('No se pudo cargar el seed inicial:', error);
    }
  }
}

function importSeedJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = JSON.parse(raw);

  if (!Array.isArray(rows)) {
    throw new Error('El archivo seed no contiene un array válido.');
  }

  replaceAllVoters(rows);
}

function replaceAllVoters(rows) {
  const cleanRows = rows.map(cleanVoter).filter((row) => row.full_name || row.dni);

  const trx = db.transaction((items) => {
    db.prepare('DELETE FROM voters').run();

    const stmt = db.prepare(`
      INSERT INTO voters (
        id,
        dni,
        full_name,
        escuela,
        mesa,
        hoja,
        padron_numero,
        fila_hoja,
        voted,
        voted_at,
        updated_at
      ) VALUES (
        @id,
        @dni,
        @full_name,
        @escuela,
        @mesa,
        @hoja,
        @padron_numero,
        @fila_hoja,
        @voted,
        @voted_at,
        @updated_at
      )
    `);

    for (const item of items) {
      stmt.run(item);
    }
  });

  trx(cleanRows);
}

function parseExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  if (!workbook.SheetNames.length) {
    throw new Error('El archivo Excel no contiene hojas.');
  }

  const preferredSheetName = workbook.SheetNames.find(
    (name) => normalize(name) === 'base'
  );

  const sheetName = preferredSheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return json
    .map((row, index) => {
      const dni = pickCell(row, [
        'DNI',
        'DNI_NORM',
        'Documento',
        'Nro Documento',
        'N° Documento'
      ]);

      const fullName = pickCell(row, [
        'Apellido y nombre',
        'Apellido y Nombre',
        'APELLIDO Y NOMBRE',
        'Nombre y Apellido',
        'Nombre completo'
      ]);

      const escuela = pickCell(row, [
        'Escuela',
        'Escuela / Mesa',
        'ESCUELA',
        'Establecimiento'
      ]);

      const mesa = pickCell(row, ['Mesa', 'MESA']);
      const hoja = pickCell(row, ['Hoja', 'HOJA']);
      const padronNumero = pickCell(row, [
        'N° en padrón',
        'Nº en padrón',
        'Numero en padron',
        'Número en padrón',
        'Padrón',
        'Padron'
      ]);
      const filaHoja = pickCell(row, [
        'Fila en hoja',
        'Fila',
        'FILA EN HOJA'
      ]);

      return {
        id: String(dni || ${fullName || 'sin-dni'}-${index}).trim(),
        dni: String(dni || '').trim(),
        fullName: String(fullName || '').trim(),
        escuela: String(escuela || '').trim(),
        mesa: String(mesa || '').trim(),
        hoja: String(hoja || '').trim(),
        padronNumero: String(padronNumero || '').trim(),
        filaHoja: String(filaHoja || '').trim(),
        voted: false,
        votedAt: '',
        updatedAt: ''
      };
    })
    .filter((row) => row.fullName || row.dni);
}

function cleanVoter(item) {
  const fullName = String(item.fullName || item.full_name || '').trim();
  const dni = String(item.dni || '').trim();

  return {
    id: String(item.id || dni || safeRandomId()).trim(),
    dni,
    full_name: fullName,
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
    voter.full_name ? 👤 <b>Nombre:</b> ${escapeHtml(voter.full_name)} : '',
    voter.dni ? 🪪 <b>DNI:</b> ${escapeHtml(voter.dni)} : '',
    voter.escuela ? 🏫 <b>Escuela:</b> ${escapeHtml(voter.escuela)} : '',
    voter.mesa ? 🗳️ <b>Mesa:</b> ${escapeHtml(voter.mesa)} : '',
    voter.voted_at ? ⏰ <b>Hora:</b> ${escapeHtml(formatDate(voter.voted_at))} : ''
  ]
    .filter(Boolean)
    .join('\n');

  const response = await fetch(
    https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: lines,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    }
  );

  if (!response.ok) {
    throw new Error(HTTP ${response.status} al enviar Telegram.);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || 'No se pudo enviar a Telegram.');
  }
}

function emitRefresh() {
  io.emit('sync', { ts: Date.now() });
}

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  if (!row) return 0;
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
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'medium'
  });
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};

  const envData = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();

    if (!line || line.startsWith('#') || !line.includes('=')) continue;

    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    envData[key] = value;
  }

  return envData;
}

function safeRandomId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return id-${Date.now()}-${Math.random().toString(36).slice(2, 10)};
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function createBackup() {
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, votacion-${stamp}.sqlite);

    fs.copyFileSync(DB_PATH, backupFile);
  } catch (error) {
    console.error('No se pudo crear backup:', error);
  }
}

function pickCell(row, possibleKeys) {
  for (const key of possibleKeys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return row[key];
    }
  }
  return '';
}
