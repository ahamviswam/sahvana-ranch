'use strict';
/*
 * Sahvana Ranch — booking tracker
 * Small Express server: one shared password, Postgres storage, contract PDF storage,
 * JSON backup/restore and an hourly Airbnb calendar (iCal) sync.
 */
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
if (!APP_PASSWORD) { console.error('APP_PASSWORD is not set. Add it in Railway → Variables.'); process.exit(1); }
if (!DATABASE_URL) { console.error('DATABASE_URL is not set. Add a Postgres database in Railway and reference it.'); process.exit(1); }

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('sahvana:' + APP_PASSWORD).digest('hex');
const PW_FINGERPRINT = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex').slice(0, 16); // changing the password signs everyone out
const COLLECTIONS = new Set(['bookings', 'properties', 'tours']);
const ID_RE = /^[A-Za-z0-9_.:@+~-]{1,120}$/;
const SESSION_DAYS = 180;
const ICAL_EVERY_MIN = Number(process.env.ICAL_SYNC_MINUTES || 60);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      collection text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id text PRIMARY KEY,
      name text NOT NULL,
      content_type text NOT NULL,
      size integer NOT NULL,
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
}

/* ---------- sessions (signed cookie, no server state) ---------- */
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const body = `${exp}.${PW_FINGERPRINT}`;
  return `${body}.${sign(body)}`;
}
function validToken(t) {
  if (!t) return false;
  const parts = String(t).split('.');
  if (parts.length !== 3) return false;
  const [exp, fp, sig] = parts;
  const want = sign(`${exp}.${fp}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  return fp === PW_FINGERPRINT && Number(exp) > Date.now();
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSession(res, req, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sr_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

/* simple login rate limit: 10 tries per 15 minutes per IP */
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), win = 15 * 60e3;
  const a = (attempts.get(ip) || []).filter((t) => now - t < win);
  attempts.set(ip, a);
  return a.length >= 10;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const pub = path.join(__dirname, 'public');
const OPEN = new Set(['/login', '/login.html', '/healthz', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']);

app.get('/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); }
});

app.get('/login', (req, res) => {
  if (validToken(getCookie(req, 'sr_session'))) return res.redirect('/');
  res.sendFile(path.join(pub, 'login.html'));
});
app.post('/login', express.urlencoded({ extended: false, limit: '10kb' }), express.json({ limit: '10kb' }), (req, res) => {
  const ip = req.ip || 'x';
  if (tooMany(ip)) return res.redirect('/login?e=wait');
  const given = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    attempts.get(ip).push(Date.now());
    return res.redirect('/login?e=1');
  }
  attempts.delete(ip);
  setSession(res, req, makeToken(), SESSION_DAYS * 86400);
  res.redirect('/');
});
app.get('/logout', (req, res) => { setSession(res, req, '', 0); res.redirect('/login'); });

// everything below needs a valid session
app.use((req, res, next) => {
  if (OPEN.has(req.path) || validToken(getCookie(req, 'sr_session'))) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return res.status(401).json({ error: 'signed_out' });
  return res.redirect('/login');
});

app.use(express.static(pub, { index: 'index.html', extensions: ['html'], maxAge: 0 }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'server_error' }); });

/* ---------- data API ---------- */
app.get('/api/data', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT collection, id, data FROM docs');
  const out = { bookings: [], properties: [], tours: [] };
  for (const r of rows) if (out[r.collection]) out[r.collection].push({ ...r.data, id: r.id });
  res.json({ ...out, ical: icalStatus, serverTime: new Date().toISOString() });
}));

function checkDoc(req, res) {
  const { collection, id } = req.params;
  if (!COLLECTIONS.has(collection) || !ID_RE.test(id)) { res.status(400).json({ error: 'bad_path' }); return false; }
  return true;
}
app.put('/api/docs/:collection/:id', express.json({ limit: '1mb' }), wrap(async (req, res) => {
  if (!checkDoc(req, res)) return;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_body' });
  delete body.id;
  await pool.query(
    `INSERT INTO docs (collection, id, data, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [req.params.collection, req.params.id, body]);
  res.json({ ok: true });
}));
app.delete('/api/docs/:collection/:id', wrap(async (req, res) => {
  if (!checkDoc(req, res)) return;
  await pool.query('DELETE FROM docs WHERE collection=$1 AND id=$2', [req.params.collection, req.params.id]);
  res.json({ ok: true });
}));

/* ---------- contract files ---------- */
const FILE_TYPES = /^(application\/pdf|image\/(png|jpe?g|heic|heif|webp|gif))$/i;
app.post('/api/files', express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!FILE_TYPES.test(type)) return res.status(400).json({ error: 'Only PDF or image files' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty file' });
  let name = 'contract';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'contract')).slice(0, 200); } catch {}
  const id = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO files (id, name, content_type, size, data) VALUES ($1,$2,$3,$4,$5)', [id, name, type, req.body.length, req.body]);
  res.json({ id, url: '/files/' + id });
}));
app.get('/files/:id', wrap(async (req, res) => {
  if (!/^[a-f0-9]{16,64}$/.test(req.params.id)) return res.status(404).end();
  const { rows } = await pool.query('SELECT name, content_type, data FROM files WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).send('Not found');
  const f = rows[0];
  res.setHeader('Content-Type', f.content_type);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(f.data);
}));
app.delete('/api/files/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM files WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- backup & restore ---------- */
app.get('/api/backup', wrap(async (_req, res) => {
  const docs = (await pool.query('SELECT collection, id, data FROM docs ORDER BY collection, id')).rows;
  const files = (await pool.query('SELECT id, name, content_type, data FROM files ORDER BY created_at')).rows
    .map((f) => ({ id: f.id, name: f.name, content_type: f.content_type, data: f.data.toString('base64') }));
  const day = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Chicago' });
  res.setHeader('Content-Disposition', `attachment; filename="sahvana-backup-${day}.json"`);
  res.json({ app: 'sahvana-ranch', version: 1, exportedAt: new Date().toISOString(), docs, files });
}));
app.post('/api/restore', express.json({ limit: '200mb' }), wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.docs)) return res.status(400).json({ error: 'Not a Sahvana Ranch backup file' });
  const client = await pool.connect();
  let d = 0, f = 0;
  try {
    await client.query('BEGIN');
    for (const doc of b.docs) {
      if (!COLLECTIONS.has(doc.collection) || !ID_RE.test(String(doc.id)) || !doc.data || typeof doc.data !== 'object') continue;
      const data = { ...doc.data }; delete data.id;
      await client.query(
        `INSERT INTO docs (collection, id, data, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [doc.collection, String(doc.id), data]);
      d++;
    }
    for (const file of Array.isArray(b.files) ? b.files : []) {
      if (!/^[a-f0-9]{16,64}$/.test(String(file.id)) || !FILE_TYPES.test(String(file.content_type))) continue;
      const buf = Buffer.from(String(file.data || ''), 'base64');
      if (!buf.length) continue;
      await client.query(
        `INSERT INTO files (id, name, content_type, size, data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, content_type=EXCLUDED.content_type, size=EXCLUDED.size, data=EXCLUDED.data`,
        [file.id, String(file.name || 'contract').slice(0, 200), file.content_type, buf.length, buf]);
      f++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ ok: true, docs: d, files: f });
}));

/* ---------- Airbnb calendar (iCal) sync ---------- */
let icalStatus = { lastRun: null, results: [] };
const icsDate = (v) => { const m = String(v || '').match(/(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
function parseIcs(text) {
  const out = [];
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const get = (k) => { const m = block.match(new RegExp('^' + k + '[^:\\n]*:(.*)$', 'm')); return m ? m[1].trim() : ''; };
    const start = icsDate(get('DTSTART')), end = icsDate(get('DTEND'));
    if (!start || !end || end <= start) continue;
    const summary = get('SUMMARY'), desc = get('DESCRIPTION').replace(/\\n/g, ' ');
    const code = (desc.match(/details\/([A-Z0-9]{6,})/) || [])[1] || '';
    out.push({ uid: get('UID') || `${start}_${end}`, start, end, reserved: /reserv/i.test(summary) || !!code, code });
  }
  return out;
}
async function syncIcal() {
  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  try {
    const { rows } = await pool.query("SELECT id, data FROM docs WHERE collection='properties'");
    for (const p of rows) {
      const url = String(p.data.icalUrl || '').trim();
      if (!/^https:\/\//i.test(url)) continue;
      const name = p.data.name || p.id;
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SahvanaRanch/1.0' } });
        clearTimeout(t);
        if (!r.ok) throw new Error('Airbnb returned ' + r.status);
        const text = await r.text();
        if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link is not a calendar (.ics) link');
        const events = parseIcs(text).filter((e) => e.end >= today);
        const all = (await pool.query("SELECT id, data FROM docs WHERE collection='bookings'")).rows;
        const manual = all.filter((b) => !b.data.icalSync && b.data.propertyId === p.id && b.data.status !== 'cancelled');
        const synced = all.filter((b) => b.data.icalSync && b.data.propertyId === p.id);
        const keep = new Set(); let added = 0, skipped = 0;
        for (const e of events) {
          // skip dates you already track yourself (your own bookings that you also blocked on Airbnb)
          if (manual.some((b) => b.data.checkIn < e.end && b.data.checkOut > e.start)) { skipped++; continue; }
          const id = 'ical-' + crypto.createHash('sha1').update(p.id + '|' + e.uid).digest('hex').slice(0, 20);
          keep.add(id);
          const data = {
            propertyId: p.id, status: 'blocked', source: 'Airbnb', icalSync: true,
            guest: e.reserved ? 'Airbnb reservation' : 'Blocked on Airbnb',
            checkIn: e.start, checkOut: e.end, payments: [], hallOn: false, hallDays: [],
            notes: 'Synced automatically from the Airbnb calendar' + (e.code ? ` · confirmation ${e.code}` : '') + '. Changes made here are replaced at the next sync.',
            created: today,
          };
          const prev = synced.find((b) => b.id === id);
          if (!prev || JSON.stringify({ ...prev.data, created: 0 }) !== JSON.stringify({ ...data, created: 0 })) {
            await pool.query(
              `INSERT INTO docs (collection, id, data, updated_at) VALUES ('bookings',$1,$2,now())
               ON CONFLICT (collection, id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [id, data]);
            if (!prev) added++;
          }
        }
        let removed = 0;
        for (const b of synced) {
          if (!keep.has(b.id) && b.data.checkOut >= today) { await pool.query("DELETE FROM docs WHERE collection='bookings' AND id=$1", [b.id]); removed++; }
        }
        results.push({ property: name, ok: true, events: events.length, added, removed, skipped });
      } catch (e) {
        results.push({ property: name, ok: false, error: e.name === 'AbortError' ? 'Airbnb did not answer in time' : String(e.message || e) });
      }
    }
  } catch (e) { console.error('ical sync failed', e); }
  icalStatus = { lastRun: new Date().toISOString(), results };
  return icalStatus;
}
app.post('/api/ical/sync', wrap(async (_req, res) => { res.json(await syncIcal()); }));

app.use((_req, res) => res.status(404).send('Not found'));

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Sahvana Ranch running on port ${PORT}`));
    setTimeout(syncIcal, 15000);
    setInterval(syncIcal, ICAL_EVERY_MIN * 60e3);
  })
  .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
