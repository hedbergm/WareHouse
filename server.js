require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const cors = require('cors');
const bwipjs = require('bwip-js');
const nodemailer = require('nodemailer');
const multer = require('multer');
const XLSX = require('xlsx');
const dbSqlite = require('./db');
const pgdb = require('./pgdb');
const usePg = pgdb.enabled();
console.log('[DB MODE]', usePg ? 'Postgres' : 'SQLite');
if(!usePg){
  console.warn('[WARN] Kjører med SQLite fallback. Data lagres i lokal fil og kan forsvinne ved ny container/deploy. Sett Postgres env-variabler (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT) for å bevare data.');
  if(process.env.NODE_ENV === 'production' && !process.env.ALLOW_SQLITE_PROD){
    console.error('[FATAL] NODE_ENV=production uten Postgres-konfig. Sett ALLOW_SQLITE_PROD=1 for å override (ikke anbefalt). Avslutter.');
    process.exit(1);
  }
}

// Ensure Postgres schema exists (idempotent) so redeploys don't show "missing" data due to absent tables
if (usePg) {
  (async () => {
    try {
      const ddl = `CREATE TABLE IF NOT EXISTS locations( id SERIAL PRIMARY KEY, name TEXT NOT NULL, barcode TEXT UNIQUE NOT NULL );
CREATE TABLE IF NOT EXISTS parts( id SERIAL PRIMARY KEY, part_number TEXT UNIQUE NOT NULL, description TEXT, min_qty INTEGER DEFAULT 0, default_location_id INTEGER REFERENCES locations(id) );
CREATE TABLE IF NOT EXISTS stock( id SERIAL PRIMARY KEY, part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE, location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE, qty INTEGER NOT NULL DEFAULT 0, UNIQUE(part_id, location_id) );
CREATE TABLE IF NOT EXISTS transactions( id SERIAL PRIMARY KEY, part_id INTEGER NOT NULL REFERENCES parts(id), location_id INTEGER NOT NULL REFERENCES locations(id), qty INTEGER NOT NULL, action TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW() );
CREATE TABLE IF NOT EXISTS users( id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL );
CREATE TABLE IF NOT EXISTS part_barcodes( id SERIAL PRIMARY KEY, part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE, barcode TEXT UNIQUE NOT NULL );`;
      for (const stmt of ddl.split(/;\s*/)) { if (stmt.trim()) await pgdb.run(stmt); }
      await pgdb.run('ALTER TABLE parts ADD COLUMN IF NOT EXISTS default_location_id INTEGER REFERENCES locations(id)');
  await pgdb.run('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)');
      console.log('[PG] Schema ensured at startup (default_location_id)');
    } catch (e) {
      console.error('[PG] Failed ensuring schema', e.message);
    }
  })();
} else {
  // Add column to SQLite if missing
  dbSqlite.all('PRAGMA table_info(parts)', [], (err, rows) => {
    if (!err && rows && !rows.find(r => r.name === 'default_location_id')) {
      dbSqlite.run('ALTER TABLE parts ADD COLUMN default_location_id INTEGER', [], e => { if(e) console.log('SQLite alter parts add default_location_id failed:', e.message); });
    }
  });
  // Add user_id to transactions if missing (SQLite)
  dbSqlite.all('PRAGMA table_info(transactions)', [], (err, rows) => {
    if(!err && rows && !rows.find(r => r.name === 'user_id')){
      dbSqlite.run('ALTER TABLE transactions ADD COLUMN user_id INTEGER', [], e => { if(e) console.log('SQLite alter transactions add user_id failed:', e.message); });
    }
  });
}

// Unified DB helper interface
const db = {
  run(sql, params, cb){
    if(!usePg) return dbSqlite.run(sql, params, cb);
    pgdb.run(sql, params).then(r=> cb && cb(null, r)).catch(e=> cb && cb(e));
  },
  get(sql, params, cb){
    if(!usePg) return dbSqlite.get(sql, params, cb);
    pgdb.get(sql, params).then(r=> cb && cb(null, r)).catch(e=> cb && cb(e));
  },
  all(sql, params, cb){
    if(!usePg) return dbSqlite.all(sql, params, cb);
    pgdb.all(sql, params).then(r=> cb && cb(null, r)).catch(e=> cb && cb(e));
  },
  serialize(fn){ if(!usePg) return dbSqlite.serialize(fn); fn(); }
};

const path = require('path');
const app = express();
// Expose db on app for utilities if needed elsewhere
app.set('db', db);
app.use(cors());
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*8 }
}));

// File upload (in-memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Auth middleware
function requireAuth(req,res,next){
  if(req.session && req.session.user) return next();
  if(req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  const wantsMobile = req.path.startsWith('/mobile');
  return res.redirect(wantsMobile ? '/mobile-login.html' : '/login.html');
}

// Root redirect to home
app.get('/', (req,res)=> res.redirect('/home.html'));

// Static serving with protection of html pages (except login)
app.use((req,res,next)=>{
  const open = ['/login.html','/mobile-login.html','/styles.css','/Holship_logo.png','/api/logo-base64'];
  if(open.includes(req.path) || req.path.startsWith('/api/')) return next();
  if(req.path.endsWith('.html')) return requireAuth(req,res,next);
  next();
});
app.use(express.static(path.join(__dirname,'public'), { index: false }));

// Explicit route for logo (troubleshooting 404 in some deploy contexts)
app.get('/Holship_logo.png', (req,res) => {
  res.sendFile(path.join(__dirname,'public','Holship_logo.png'));
});

// Fallback: return logo as data URL (base64) if static serving fails in certain environments
app.get('/api/logo-base64', (req,res) => {
  const fs = require('fs');
  const p = path.join(__dirname,'public','Holship_logo.png');
  fs.readFile(p, (err, buf) => {
    if(err) return res.status(404).json({ error: 'logo missing' });
    res.json({ data: 'data:image/png;base64,' + buf.toString('base64') });
  });
});

const PORT = process.env.PORT || 3000; // ngrok fjernet

const os = require('os');

// Return first non-internal IPv4 address (LAN)
app.get('/api/network', requireAuth, (req, res) => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return res.json({ ip: net.address });
      }
    }
  }
  res.status(404).json({ error: 'no-ip' });
});

// === Users & Auth setup ===
function seedIfNeeded(){
  if(usePg){
    (async ()=>{
      try {
        const rows = await pgdb.all('SELECT username FROM users');
        if(!rows.find(r=> r.username==='Tommy')) await seedPg();
      } catch(e){ console.error('Seed check failed (pg)', e.message); }
    })();
  } else {
    dbSqlite.all('SELECT username FROM users', [], async (e, rows)=>{
      if(e) return;
      if(!rows.find(r=> r.username==='Tommy')) await seedSqlite();
    });
  }
}

async function seedPg(){
  const users = [ ['Tommy','tob2025'], ['Slava','sl2025'], ['Elias','eli2025'], ['Admin','Admin!'] ];
  for(const [u,p] of users){
    try { const hash = await bcrypt.hash(p,10); await pgdb.run('INSERT INTO users (username,password) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING',[u,hash]); } catch(_){}
  }
}
async function seedSqlite(){
  const users = [ ['Tommy','tob2025'], ['Slava','sl2025'], ['Elias','eli2025'], ['Admin','Admin!'] ];
  for(const [u,p] of users){
    const hash = await bcrypt.hash(p,10);
    dbSqlite.run('INSERT OR IGNORE INTO users (username,password) VALUES (?,?)',[u,hash]);
  }
}
seedIfNeeded();

app.post('/api/login', (req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ error: 'username and password required' });
  const sql = usePg ? 'SELECT * FROM users WHERE username = $1' : 'SELECT * FROM users WHERE username = ?';
  db.get(sql, [username], async (err, user)=>{
    if(err) return res.status(500).json({ error: err.message });
    if(!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if(!ok) return res.status(401).json({ error: 'invalid credentials' });
    req.session.user = { id: user.id, username: user.username };
    res.json({ ok:true, user: { username: user.username } });
  });
});
app.post('/api/logout', (req,res)=>{ req.session.destroy(()=> res.json({ ok:true })); });
app.get('/api/me', (req,res)=>{ if(!req.session.user) return res.status(401).json({ error: 'unauthorized' }); res.json({ user: req.session.user }); });

// Mobile login removed earlier; replaced by unified login.

// Nodemailer transporter placeholder - will use Office365 when env vars are present
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { ciphers: 'SSLv3' }
  });
  // Verify transporter at startup for early feedback
  transporter.verify((err, success) => {
    if (err) {
      console.error('[SMTP VERIFY ERROR]', err.message);
    } else {
      console.log('[SMTP VERIFY OK]', success);
    }
  });
} else {
  console.log('[SMTP] credentials not provided. Alerts will be logged only (no email).');
}

function sendAlertEmail(part, totalQty, opts = {}) {
  const to = process.env.ALERT_EMAIL || process.env.SMTP_USER || 'mhe@holship.com';
  const subject = opts.subjectOverride || `Lav beholdning: ${part.part_number}`;
  const text = opts.textOverride || `Del ${part.part_number} (${part.description || ''}) har nå total beholdning ${totalQty} som er under min ${part.min_qty}.`; 

  if (!transporter) {
    console.log('[ALERT - NO SMTP]', { subject, to, text });
    return Promise.resolve({ simulated: true });
  }

  const msg = { from: process.env.SMTP_USER, to, subject, text }; 
  console.log('[ALERT - SENDING]', { to, subject, totalQty, part_id: part.id });
  return transporter.sendMail(msg)
    .then(info => {
      console.log('[ALERT - SENT]', info.response || info);
      return { ok: true, response: info.response };
    })
    .catch(err => {
      console.error('[ALERT - FAIL]', err && err.message);
      return { ok: false, error: err.message };
    });
}

// Alert state (in-memory). For persistens kunne dette vært egen tabell.
const alertState = {}; // part_id -> { lastSent:number }

// Manual test endpoint for alert email
app.post('/api/debug/test-alert', requireAuth, async (req,res) => {
  try {
    const pn = (req.body && req.body.part_number) || req.query.part_number;
    if(!pn) return res.status(400).json({ error:'part_number required'});
    const part = await getPartByNumber(pn);
    if(!part) return res.status(404).json({ error:'part not found'});
    const total = await getTotalQty(part.id);
    const result = await sendAlertEmail(part, total, { subjectOverride: 'TEST ALERT (manuell)', textOverride: `Test for del ${part.part_number}. Total=${total}` });
    res.json({ ok:true, result });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// Force alert ignoring threshold crossing / throttle (for debugging)
app.post('/api/debug/force-alert', requireAuth, async (req,res) => {
  try {
    const pn = (req.body && req.body.part_number) || req.query.part_number;
    if(!pn) return res.status(400).json({ error:'part_number required'});
    const part = await getPartByNumber(pn);
    if(!part) return res.status(404).json({ error:'part not found'});
    const total = await getTotalQty(part.id);
    const result = await sendAlertEmail(part, total, { subjectOverride: 'FORCE ALERT (debug)', textOverride: `Tvunget alert for ${part.part_number}. Total=${total}, Min=${part.min_qty}` });
    res.json({ ok:true, forced:true, result });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// Helpers
function qMarks(params){ return usePg ? params.map((_,i)=>'$'+(i+1)) : params.map(()=>'?'); }

function getPartByNumber(part_number) { return new Promise((res,rej)=> db.get(`SELECT * FROM parts WHERE part_number = ${qMarks([''])[0]}`, [part_number], (e,r)=> e?rej(e):res(r))); }
function getLocationByBarcode(barcode) { return new Promise((res,rej)=> db.get(`SELECT * FROM locations WHERE barcode = ${qMarks([''])[0]}`, [barcode], (e,r)=> e?rej(e):res(r))); }
function getTotalQty(part_id) { return new Promise((res,rej)=> db.get(`SELECT SUM(qty) as total FROM stock WHERE part_id = ${qMarks([''])[0]}`, [part_id], (e,r)=> e?rej(e):res(r? r.total:0))); }

// API
app.post('/api/locations', requireAuth, async (req, res) => {
  const { name, barcode } = req.body || {};
  if (!name || !barcode) return res.status(400).json({ error: 'name and barcode required' });
  try {
    if (usePg) {
      const row = await pgdb.get('INSERT INTO locations (name, barcode) VALUES ($1,$2) RETURNING id', [name, barcode]);
      const created = { id: row.id, name, barcode };
      console.log('[ADD LOCATION]', created);
      return res.json(created);
    } else {
      const sql = `INSERT INTO locations (name, barcode) VALUES (${qMarks([name,barcode]).join(', ')})`;
      db.run(sql, [name, barcode], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const created = { id: this.lastID, name, barcode };
        console.log('[ADD LOCATION]', created);
        res.json(created);
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/locations', requireAuth, (req, res) => {
  db.all('SELECT * FROM locations', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get stock contents for a location by its barcode
app.get('/api/locations/:barcode/stock', requireAuth, async (req, res) => {
  try {
    const barcode = req.params.barcode;
    const loc = await getLocationByBarcode(barcode);
    if(!loc) return res.status(404).json({ error: 'location not found' });
    const sql = `SELECT p.part_number, p.description, s.qty FROM stock s JOIN parts p ON s.part_id = p.id WHERE s.location_id = ${qMarks([loc.id])[0]}`;
    db.all(sql, [loc.id], (e, rows) => {
      if(e) return res.status(500).json({ error: e.message });
      res.json({ location: { id: loc.id, name: loc.name, barcode: loc.barcode }, items: rows });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update location
app.put('/api/locations/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const { name, barcode } = req.body;
  if (!name || !barcode) return res.status(400).json({ error: 'name and barcode required' });
  const sql = usePg ? 'UPDATE locations SET name = $1, barcode = $2 WHERE id = $3' : 'UPDATE locations SET name = ?, barcode = ? WHERE id = ?';
  db.run(sql, [name, barcode, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name, barcode });
  });
});

// Delete location (and related stock/transactions)
app.delete('/api/locations/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  db.serialize(() => {
  db.run(`DELETE FROM transactions WHERE location_id = ${qMarks([id])[0]}`, [id]);
  db.run(`DELETE FROM stock WHERE location_id = ${qMarks([id])[0]}`, [id]);
  db.run(`DELETE FROM locations WHERE id = ${qMarks([id])[0]}`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  });
});

app.get('/api/locations/:id/barcode.png', requireAuth, (req, res) => {
  const id = req.params.id;
  db.get(`SELECT * FROM locations WHERE id = ${qMarks([id])[0]}`, [id], (err, loc) => {
    if (err || !loc) return res.status(404).send('Not found');
    // Generate Code128 barcode image
    try {
      bwipjs.toBuffer({
        bcid: 'code128',
        text: loc.barcode,
        scale: 3,
        height: 10,
        includetext: true,
        textxalign: 'center'
      }, (e, png) => {
        if (e) return res.status(500).send('Barcode generation failed');
        res.set('Content-Type', 'image/png');
        res.send(png);
      });
    } catch (e) {
      res.status(500).send('Barcode generation error');
    }
  });
});

// Generate barcode PNG for a part number (can be used before part exists)
app.get('/api/parts/:part_number/barcode.png', requireAuth, (req, res) => {
  const part_number = decodeURIComponent(req.params.part_number);
  if (!part_number) return res.status(400).send('part_number required');
  try {
    bwipjs.toBuffer({
      bcid: 'code128',
      text: part_number,
  scale: 3,
  height: 12,
  includetext: true,
  textxalign: 'center',
  includetext: true,
  textfont: 'Inconsolata',
  textsize: 10,
  // Force subset B by disabling code128 auto optimization (bwip-js does auto; subset B suitable for mixed upper + digits + dash)
  parse: true
    }, (e, png) => {
      if (e) return res.status(500).send('Barcode generation failed');
      res.set('Content-Type', 'image/png');
      res.send(png);
    });
  } catch (e) {
    res.status(500).send('Barcode generation error');
  }
});

app.post('/api/parts', requireAuth, async (req, res) => {
  try {
    let { part_number, description, min_qty, default_location_barcode } = req.body || {};
    if (!part_number) return res.status(400).json({ error: 'part_number required' });
    part_number = String(part_number).trim();
    const minq = parseInt(min_qty || '0', 10);
    let defaultLocId = null;
    if (default_location_barcode) {
      const loc = await getLocationByBarcode(default_location_barcode);
      if(!loc) return res.status(400).json({ error: 'default location not found' });
      defaultLocId = loc.id;
    }
    if (usePg) {
      const row = await pgdb.get('INSERT INTO parts (part_number, description, min_qty, default_location_id) VALUES ($1,$2,$3,$4) RETURNING id', [part_number, description || '', minq, defaultLocId]);
      const created = { id: row.id, part_number, description, min_qty: minq, default_location_id: defaultLocId };
      console.log('[ADD PART]', created);
      if (defaultLocId) await pgdb.run('INSERT INTO stock (part_id, location_id, qty) VALUES ($1,$2,0) ON CONFLICT (part_id, location_id) DO NOTHING', [row.id, defaultLocId]);
      return res.json(created);
    } else {
      const base = [part_number, description || '', minq];
      let sql, params;
      if (defaultLocId) { sql = 'INSERT INTO parts (part_number, description, min_qty, default_location_id) VALUES (?,?,?,?)'; params = [...base, defaultLocId]; }
      else { sql = 'INSERT INTO parts (part_number, description, min_qty) VALUES (?,?,?)'; params = base; }
      db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const created = { id: this.lastID, part_number, description, min_qty: minq, default_location_id: defaultLocId };
        console.log('[ADD PART]', created);
        if (defaultLocId) db.run('INSERT OR IGNORE INTO stock (part_id, location_id, qty) VALUES (?,?,0)', [this.lastID, defaultLocId]);
        res.json(created);
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/parts', requireAuth, (req, res) => {
  const sql = `SELECT p.*, l.barcode AS default_location_barcode, l.name AS default_location_name
               FROM parts p
               LEFT JOIN locations l ON p.default_location_id = l.id`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Update a part
app.put('/api/parts/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { part_number, description, min_qty, default_location_barcode } = req.body;
  if (!part_number) return res.status(400).json({ error: 'part_number required' });
  const minq = parseInt(min_qty || '0', 10);
  let defaultLocId = null;
  if (default_location_barcode) {
    const loc = await getLocationByBarcode(default_location_barcode);
    if(!loc) return res.status(400).json({ error: 'default location not found' });
    defaultLocId = loc.id;
  }
  const sql = usePg ? 'UPDATE parts SET part_number = $1, description = $2, min_qty = $3, default_location_id = $4 WHERE id = $5' : 'UPDATE parts SET part_number = ?, description = ?, min_qty = ?, default_location_id = ? WHERE id = ?';
  db.run(sql, [part_number, description || '', minq, defaultLocId, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    // Ensure stock row exists for default location after update (e.g., when setting fixed location later)
    if (defaultLocId) {
      const ensureSql = usePg
        ? 'INSERT INTO stock (part_id, location_id, qty) VALUES ($1,$2,0) ON CONFLICT (part_id, location_id) DO NOTHING'
        : 'INSERT OR IGNORE INTO stock (part_id, location_id, qty) VALUES (?,?,0)';
      db.run(ensureSql, [id, defaultLocId]);
    }
    res.json({ id, part_number, description, min_qty: minq, default_location_id: defaultLocId });
  });
});

// Delete a part (and related transactions/stock)
app.delete('/api/parts/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  db.serialize(() => {
  db.run(`DELETE FROM transactions WHERE part_id = ${qMarks([id])[0]}`, [id]);
  db.run(`DELETE FROM parts WHERE id = ${qMarks([id])[0]}`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  });
});

// Scan endpoint - now location optional if part has fixed location
app.post('/api/stock/scan', requireAuth, async (req, res) => {
  try {
    const { location_barcode, part_number, qty, action } = req.body;
    if (!part_number || !qty || !action) return res.status(400).json({ error: 'part_number, qty and action required' });
    const q = parseInt(qty, 10);
    if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'qty must be a positive integer' });
    if (!['in', 'out'].includes(action)) return res.status(400).json({ error: 'action must be "in" or "out"' });

    const part = await getPartByNumber(part_number);
    if (!part) return res.status(404).json({ error: 'part not found' });

    let loc = null;
    if (location_barcode) {
      loc = await getLocationByBarcode(location_barcode);
      if (!loc) return res.status(404).json({ error: 'location not found' });
      if (part.default_location_id && String(part.default_location_id) !== String(loc.id)) {
        return res.status(400).json({ error: 'part has fixed location' });
      }
    } else {
      // infer from fixed location
      if (!part.default_location_id) return res.status(400).json({ error: 'location required (part has no fixed location)' });
      loc = await new Promise((resolve, reject) => db.get(`SELECT * FROM locations WHERE id = ${qMarks([part.default_location_id])[0]}`, [part.default_location_id], (e,r)=> e?reject(e):resolve(r)));
      if(!loc) return res.status(400).json({ error: 'fixed location missing' });
    }

    // New: If scanning IN and the part has no fixed location yet, set it to the scanned location (feature toggleable by env)
    try {
      const autoSet = (process.env.AUTO_SET_FIXED_LOC_ON_IN || '1') !== '0';
      if (autoSet && action === 'in' && !part.default_location_id && loc && loc.id) {
        const sql = usePg ? 'UPDATE parts SET default_location_id = $1 WHERE id = $2' : 'UPDATE parts SET default_location_id = ? WHERE id = ?';
        await new Promise((res,rej)=> db.run(sql, [loc.id, part.id], (e)=> e?rej(e):res()));
        // reflect change in memory copy for this request
        part.default_location_id = loc.id;
      }
    } catch(e) {
      console.error('[AUTO SET FIXED LOC] failed:', e.message);
    }

  const userId = req.session && req.session.user ? req.session.user.id : null;
  db.serialize(async () => {
      const ensureSql = usePg ? 'INSERT INTO stock (part_id, location_id, qty) VALUES ($1,$2,0) ON CONFLICT (part_id, location_id) DO NOTHING' : 'INSERT OR IGNORE INTO stock (part_id, location_id, qty) VALUES (?, ?, 0)';
      db.run(ensureSql, [part.id, loc.id]);

      let totalBefore = null; // total før endringen for å oppdage kryssing av min-grense
      if (action === 'in') {
        const updSql = usePg ? 'UPDATE stock SET qty = qty + $1 WHERE part_id = $2 AND location_id = $3' : 'UPDATE stock SET qty = qty + ? WHERE part_id = ? AND location_id = ?';
        db.run(updSql, [q, part.id, loc.id]);
        const totalAfter = await getTotalQty(part.id);
        totalBefore = totalAfter - q;
        finalize(totalAfter, totalBefore);
      } else {
        const selSql = usePg ? 'SELECT qty FROM stock WHERE part_id = $1 AND location_id = $2' : 'SELECT qty FROM stock WHERE part_id = ? AND location_id = ?';
        db.get(selSql, [part.id, loc.id], async (err, row) => {
          if (err) return res.status(500).json({ error: err.message });
          const available = row ? row.qty : 0;
          if (available < q) return res.status(400).json({ error: `Not enough stock at location (available ${available})` });
          const updOut = usePg ? 'UPDATE stock SET qty = qty - $1 WHERE part_id = $2 AND location_id = $3' : 'UPDATE stock SET qty = qty - ? WHERE part_id = ? AND location_id = ?';
          db.run(updOut, [q, part.id, loc.id]);
          const totalAfter = await getTotalQty(part.id);
          totalBefore = totalAfter + q;
          finalize(totalAfter, totalBefore);
        });
      }

  function finalize(totalAfter, totalBefore){
        // Alert: bare når vi krysser NED til <= min (ikke på INN eller ved gjentatte OUT under min)
        try {
          if (action === 'out' && part.min_qty > 0) {
            const crossed = totalAfter <= part.min_qty && totalBefore > part.min_qty;
            const throttleMin = parseInt(process.env.ALERT_THROTTLE_MINUTES || '30', 10);
            const throttleMs = throttleMin * 60000;
            const st = alertState[part.id] || {};
            if (crossed) {
              if (!st.lastSent || (Date.now() - st.lastSent) > throttleMs) {
                sendAlertEmail(part, totalAfter);
                alertState[part.id] = { lastSent: Date.now(), lastQty: totalAfter };
              } else if (process.env.ALERT_DEBUG) {
                console.log('[ALERT DEBUG] Skipped pga throttle', { part: part.part_number, lastSentAgoMs: Date.now() - st.lastSent });
              }
            } else if (process.env.ALERT_DEBUG) {
              console.log('[ALERT DEBUG] Ikke sendt - kriterier ikke oppfylt', { part: part.part_number, totalAfter, totalBefore, min: part.min_qty });
            }
          } else if (process.env.ALERT_DEBUG && action === 'out') {
            console.log('[ALERT DEBUG] min_qty=0 -> ingen alert', { part: part.part_number });
          }
        } catch(e){ console.error('alert logic failed', e.message); }
        const txSql = usePg
          ? 'INSERT INTO transactions (part_id, location_id, qty, action, user_id) VALUES ($1,$2,$3,$4,$5)'
          : 'INSERT INTO transactions (part_id, location_id, qty, action, user_id) VALUES (?,?,?,?,?)';
        db.run(txSql, [part.id, loc.id, q, action, userId]);
        res.json({ ok: true, part: part.part_number, location: loc.barcode, qty: q, action });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Set exact stock quantity at a specific location for a part (admin/edit use)
app.post('/api/stock/set', requireAuth, async (req, res) => {
  try {
    const { part_number, location_barcode, qty } = req.body || {};
    if(!part_number) return res.status(400).json({ error: 'part_number required' });
    if(location_barcode == null || location_barcode === '') return res.status(400).json({ error: 'location_barcode required' });
    const q = parseInt(qty,10);
    if(Number.isNaN(q) || q < 0) return res.status(400).json({ error: 'qty must be a non-negative integer' });
    const part = await getPartByNumber(part_number);
    if(!part) return res.status(404).json({ error: 'part not found' });
    const loc = await getLocationByBarcode(location_barcode);
    if(!loc) return res.status(404).json({ error: 'location not found' });
    // Get current qty to compute delta for transaction log
    const cur = await new Promise((res,rej)=> db.get(`SELECT qty FROM stock WHERE part_id = ${qMarks([''])[0]} AND location_id = ${qMarks([''])[0]}`, [part.id, loc.id], (e,r)=> e?rej(e):res(r)));
    const before = cur ? (parseInt(cur.qty,10)||0) : 0;
    const result = await setStockQty(part.id, loc.id, q);
    const after = result ? result.after : q;
    // Log a transaction with action 'set' and qty = delta for traceability
    const delta = after - before;
    const userId = req.session && req.session.user ? req.session.user.id : null;
    const txSql = usePg
      ? 'INSERT INTO transactions (part_id, location_id, qty, action, user_id) VALUES ($1,$2,$3,$4,$5)'
      : 'INSERT INTO transactions (part_id, location_id, qty, action, user_id) VALUES (?,?,?,?,?)';
    db.run(txSql, [part.id, loc.id, delta, 'set', userId]);
    res.json({ ok:true, part: part.part_number, location: loc.barcode, before, after });
  } catch(e){
    console.error('stock set failed', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// Debug endpoints (non-authenticated; consider protecting for production)
app.get('/api/debug/parts', requireAuth, (req,res) => {
  db.all('SELECT * FROM parts', (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});
app.get('/api/debug/locations', requireAuth, (req,res) => {
  db.all('SELECT * FROM locations', (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});

// /api/debug/mobile-auth removed with mobile login

// Get stock for a part (includes fixed location with qty 0 if no stock yet)
app.get('/api/stock/:part_number', requireAuth, async (req, res) => {
  const part_number = req.params.part_number;
  const part = await getPartByNumber(part_number);
  if (!part) return res.status(404).json({ error: 'part not found' });
  db.all(`SELECT l.id as location_id, l.name as location_name, l.barcode, s.qty FROM stock s JOIN locations l ON s.location_id = l.id WHERE s.part_id = ${qMarks([part.id])[0]}`, [part.id], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      // If part has a fixed location but no stock row yet, include it with qty 0
      if (part.default_location_id && !rows.find(r => String(r.location_id) === String(part.default_location_id))) {
        const loc = await new Promise((resolve, reject) => {
          db.get(`SELECT * FROM locations WHERE id = ${qMarks([part.default_location_id])[0]}`, [part.default_location_id], (e, r) => e ? reject(e) : resolve(r));
        });
        if (loc) {
          rows.push({ location_id: loc.id, location_name: loc.name, barcode: loc.barcode, qty: 0 });
        }
      }
    } catch (e2) {
      console.error('augment fixed location failed', e2.message);
    }
    const total = await getTotalQty(part.id);
    res.json({ part, total, locations: rows });
  });
});

// Resolve a skannet strekkode til part_number (sjekker parts.part_number først, deretter alias i part_barcodes)
app.get('/api/parts/resolve/:code', requireAuth, (req,res) => {
  const code = req.params.code.trim();
  if(!code) return res.status(400).json({ error: 'code required' });
  // First try direct match
  db.get(`SELECT * FROM parts WHERE part_number = ${qMarks([code])[0]}`, [code], (e,row) => {
    if(e) return res.status(500).json({ error: e.message });
    if(row) return res.json({ part_number: row.part_number, id: row.id, direct: true });
    // try alias
    const sql = `SELECT p.id, p.part_number FROM part_barcodes pb JOIN parts p ON pb.part_id = p.id WHERE pb.barcode = ${qMarks([code])[0]}`;
    db.get(sql, [code], (e2,r2) => {
      if(e2) return res.status(500).json({ error: e2.message });
      if(!r2) return res.status(404).json({ error: 'not found' });
      res.json({ part_number: r2.part_number, id: r2.id, direct: false });
    });
  });
});

// Generic search (part_number, description, or location barcode/name)
app.get('/api/search', requireAuth, async (req,res) => {
  const term = (req.query.term || '').trim();
  if(!term) return res.json([]);
  const like = usePg ? 'ILIKE' : 'LIKE';
  const wild = `%${term}%`;
  function allP(sql, params){
    return new Promise((resolve,reject)=> db.all(sql, params, (e,r)=> e?reject(e):resolve(r)));
  }
  try {
    // Direkte treff på parts (delenummer eller beskrivelse)
    const partSql = usePg
      ? `SELECT * FROM parts WHERE part_number ${like} $1 OR description ${like} $2`
      : `SELECT * FROM parts WHERE part_number ${like} ? OR description ${like} ?`;
    const directParts = await allP(partSql, [wild, wild]);

    // Lokasjoner som matcher navn eller barcode
    const locSql = usePg
      ? `SELECT id FROM locations WHERE name ${like} $1 OR barcode ${like} $2`
      : `SELECT id FROM locations WHERE name ${like} ? OR barcode ${like} ?`;
    const locRows = await allP(locSql, [wild, wild]);
    const locIds = locRows.map(r=> r.id);

    // Parts som finnes på en matchende lokasjon
    let locParts = [];
    if(locIds.length){
      if(usePg){
        const placeholders = locIds.map((_,i)=> '$'+(i+1)).join(',');
        const sql = `SELECT DISTINCT p.* FROM stock s JOIN parts p ON s.part_id = p.id WHERE s.location_id IN (${placeholders})`;
        locParts = await allP(sql, locIds);
      } else {
        const placeholders = locIds.map(()=> '?').join(',');
        const sql = `SELECT DISTINCT p.* FROM stock s JOIN parts p ON s.part_id = p.id WHERE s.location_id IN (${placeholders})`;
        locParts = await allP(sql, locIds);
      }
    }
    const allPartsMap = new Map();
    [...directParts, ...locParts].forEach(p => { allPartsMap.set(p.id, p); });
    const finalParts = [...allPartsMap.values()];
    if(!finalParts.length) return res.json([]);

    // Hent lokasjoner + total for hver part
    const results = [];
    for(const p of finalParts){
      const locs = await allP(`SELECT l.name, l.barcode, s.qty FROM stock s JOIN locations l ON s.location_id = l.id WHERE s.part_id ${usePg? '=':'='} ${usePg?'$1':'?'}`, [p.id]);
      const total = await getTotalQty(p.id);
      results.push({ part_number: p.part_number, description: p.description, total, locations: locs });
    }
    res.json(results);
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// Transactions log endpoint
app.get('/api/transactions', requireAuth, async (req,res) => {
  try {
    const partFilter = (req.query.part||'').trim();
    const locFilter = (req.query.loc||'').trim();
  const userFilter = (req.query.user||'').trim();
    let limit = parseInt(req.query.limit||'50',10); if(isNaN(limit)||limit<1) limit=50; if(limit>500) limit=500;
    const like = usePg ? 'ILIKE' : 'LIKE';
    const params = [];
    function ph(){ return usePg ? '$'+(params.length+1) : '?'; }
    let where = ' WHERE 1=1';
    if(partFilter){ params.push('%'+partFilter+'%'); where += ` AND p.part_number ${like} ${ph()}`; }
  if(locFilter){ params.push('%'+locFilter+'%'); where += ` AND l.barcode ${like} ${ph()}`; }
  if(userFilter){ params.push('%'+userFilter+'%'); where += ` AND u.username ${like} ${ph()}`; }
    // Order newest first
  const sql = `SELECT t.id, t.qty, t.action, t.created_at, t.user_id, u.username, p.part_number, p.description, l.barcode as location_barcode, l.name as location_name
         FROM transactions t
         JOIN parts p ON t.part_id = p.id
         JOIN locations l ON t.location_id = l.id
         LEFT JOIN users u ON t.user_id = u.id
                 ${where}
                 ORDER BY t.created_at DESC, t.id DESC
                 ${usePg? 'LIMIT '+( '$'+(params.length+1) ) : 'LIMIT '+ph()}`;
    params.push(limit);
    db.all(sql, params, (e, rows) => {
      if(e) return res.status(500).json({ error: e.message });
      res.json(rows);
    });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// Heuristikk-endpoint for å sjekke sannsynlig feiltolket Code128 (f.eks TAN-00623 lest som 51793111)
app.get('/api/parts/heuristic/map/:code', requireAuth, (req,res)=> {
  const raw = req.params.code.trim();
  // Hvis innkoden er kun tall og ingen direkte match finnes, forsøk å finne en part med bindestrek som har tilsvarende lengde
  if(!/^[0-9]+$/.test(raw)) return res.json({ passthrough: true });
  db.all('SELECT part_number FROM parts WHERE part_number LIKE %s', [], (e,rows)=>{
    // Simplified placeholder – can be expanded; returning passthrough
    return res.json({ passthrough: true });
  });
});

// Legg til alias strekkode for del
app.post('/api/parts/:id/barcodes', requireAuth, (req,res) => {
  const id = req.params.id; const { barcode } = req.body || {};
  if(!barcode) return res.status(400).json({ error: 'barcode required' });
  const sql = `INSERT INTO part_barcodes (part_id, barcode) VALUES (${qMarks([id, barcode]).join(', ')})`;
  db.run(sql, [id, barcode], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, part_id: id, barcode });
  });
});

// List alias strekkoder for del
app.get('/api/parts/:id/barcodes', requireAuth, (req,res) => {
  const id = req.params.id;
  db.all(`SELECT * FROM part_barcodes WHERE part_id = ${qMarks([id])[0]}`, [id], (e, rows) => {
    if(e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});

// Slett alias
app.delete('/api/parts/:id/barcodes/:bid', requireAuth, (req,res) => {
  const bid = req.params.bid;
  db.run(`DELETE FROM part_barcodes WHERE id = ${qMarks([bid])[0]}`, [bid], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Debug status: counts + db mode
app.get('/api/debug/status', requireAuth, (req,res) => {
  const status = { dbMode: usePg ? 'Postgres' : 'SQLite' };
  const queries = [
    ['parts','SELECT COUNT(*) as c FROM parts'],
    ['locations','SELECT COUNT(*) as c FROM locations'],
    ['stock','SELECT COUNT(*) as c FROM stock'],
    ['transactions','SELECT COUNT(*) as c FROM transactions']
  ];
  let remaining = queries.length;
  queries.forEach(([key, sql]) => {
    db.get(sql, [], (e,row)=>{
      status[key] = e ? 'err' : row.c;
      if(--remaining===0) res.json(status);
    });
  });
});

// === Excel import av lager (Delenummer, Beskrivelse, Min Antall, Antall, Fast Lokasjon) ===
function normalizeKey(k){ return String(k||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
const COLS = {
  part: ['delenummer','delenr','part','partno','part_number','varenr','artnr','sku','del'],
  desc: ['beskrivelse','description','desc','tekst','navn','name'],
  min:  ['minantall','min_qty','minqty','minquantity','minlager','min','minant'],
  qty:  ['antall','qty','quantity','onhand','on_hand','beholdning','stock'],
  loc:  ['fastlokasjon','fastlok','defaultlocation','default_location','lokasjon','location','plass','hylle','barcode']
};

function guessCol(keys, candidates){
  const norm = keys.map(k=> ({ raw:k, n: normalizeKey(k) }));
  const cset = new Set(candidates.map(normalizeKey));
  const hit = norm.find(k=> cset.has(k.n));
  return hit ? hit.raw : null;
}

async function getOrCreateLocationByCode(code){
  const codeStr = String(code||'').trim(); if(!codeStr) return null;
  let loc = await new Promise((res,rej)=> db.get(`SELECT * FROM locations WHERE barcode = ${qMarks([''])[0]} OR name = ${qMarks([''])[0]}`,[codeStr, codeStr],(e,r)=> e?rej(e):res(r)));
  if(loc) return loc;
  // Create with name=barcode when missing
  if(usePg){
    try {
      const row = await pgdb.get('INSERT INTO locations (name, barcode) VALUES ($1,$2) RETURNING id, name, barcode', [codeStr, codeStr]);
      return row;
    } catch(e){
      // Race: try read again
      loc = await new Promise((res,rej)=> db.get(`SELECT * FROM locations WHERE barcode = ${qMarks([''])[0]}`,[codeStr],(er,rr)=> er?rej(er):res(rr)));
      return loc;
    }
  } else {
    await new Promise((resolve,reject)=> db.run('INSERT OR IGNORE INTO locations (name, barcode) VALUES (?,?)',[codeStr, codeStr], (err)=> err?reject(err):resolve()));
    loc = await new Promise((res,rej)=> db.get('SELECT * FROM locations WHERE barcode = ?',[codeStr],(e,r)=> e?rej(e):res(r)));
    return loc;
  }
}

async function upsertPartPartial({ pn, description, min_qty, defaultLocId }){
  const part_number = String(pn||'').trim(); if(!part_number) return null;
  let part = await getPartByNumber(part_number);
  if(part){
    // Build dynamic UPDATE only for provided fields
    const sets = []; const params = [];
    if(typeof description === 'string') { sets.push('description = ' + (usePg? '$'+(params.length+1) : '?')); params.push(description); }
    if(min_qty !== undefined && min_qty !== null && !Number.isNaN(parseInt(min_qty,10))) {
      sets.push('min_qty = ' + (usePg? '$'+(params.length+1) : '?')); params.push(parseInt(min_qty,10));
    }
    if(defaultLocId !== undefined) { // allow explicit null to clear if caller really passes null
      sets.push('default_location_id = ' + (usePg? '$'+(params.length+1) : '?')); params.push(defaultLocId);
    }
    if(sets.length){
      const sql = `UPDATE parts SET ${sets.join(', ')} WHERE id = ${usePg? '$'+(params.length+1) : '?'}`;
      params.push(part.id);
      await new Promise((res,rej)=> db.run(sql, params, (e)=> e?rej(e):res()));
      part = await getPartByNumber(part_number);
    }
    return part;
  }
  // Insert new part; use defaults when fields missing
  const insDesc = typeof description === 'string' ? description : '';
  const insMin = (min_qty !== undefined && min_qty !== null && !Number.isNaN(parseInt(min_qty,10))) ? parseInt(min_qty,10) : 0;
  const insLoc = (defaultLocId !== undefined) ? defaultLocId : null;
  if(usePg){
    const row = await pgdb.get('INSERT INTO parts (part_number, description, min_qty, default_location_id) VALUES ($1,$2,$3,$4) RETURNING id, part_number, description, min_qty, default_location_id', [part_number, insDesc, insMin, insLoc]);
    return row;
  } else {
    await new Promise((resolve,reject)=> db.run('INSERT INTO parts (part_number, description, min_qty, default_location_id) VALUES (?,?,?,?)',[part_number, insDesc, insMin, insLoc], (e)=> e?reject(e):resolve()));
    const p = await getPartByNumber(part_number);
    return p;
  }
}

async function setStockQty(partId, locId, qty){
  const q = Math.max(0, parseInt(qty||'0',10)||0);
  const existing = await new Promise((res,rej)=> db.get(`SELECT id, qty FROM stock WHERE part_id = ${qMarks([''])[0]} AND location_id = ${qMarks([''])[0]}`, [partId, locId], (e,r)=> e?rej(e):res(r)));
  if(existing){
    const sql = usePg ? 'UPDATE stock SET qty = $1 WHERE id = $2' : 'UPDATE stock SET qty = ? WHERE id = ?';
    await new Promise((res,rej)=> db.run(sql,[q, existing.id], (e)=> e?rej(e):res()));
    return { updated:true, inserted:false, before: existing.qty, after: q };
  } else {
    if(usePg){
      await pgdb.run('INSERT INTO stock (part_id, location_id, qty) VALUES ($1,$2,$3)', [partId, locId, q]);
    } else {
      await new Promise((res,rej)=> db.run('INSERT OR IGNORE INTO stock (part_id, location_id, qty) VALUES (?,?,?)', [partId, locId, q], (e)=> e?rej(e):res()));
    }
    return { updated:false, inserted:true, before: 0, after: q };
  }
}

app.post('/api/inventory/import-excel', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ ok:false, error:'Mangler fil (felt: file)' });
    const apply = req.query.apply === '1';
    const wb = XLSX.read(req.file.buffer, { type:'buffer' });
    const sheetName = wb.SheetNames[0];
    if(!sheetName) return res.status(400).json({ ok:false, error:'Tom arbeidsbok' });
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
    if(!rows.length) return res.status(400).json({ ok:false, error:'Ingen rader i første ark' });
    const keys = Object.keys(rows[0]||{});
    let colPart = guessCol(keys, COLS.part);
    const colDesc = guessCol(keys, COLS.desc);
    const colMin  = guessCol(keys, COLS.min);
    const colQty  = guessCol(keys, COLS.qty);
    const colLoc  = guessCol(keys, COLS.loc);
    if(!colPart){
      // Fallback: anta første to kolonner = (Delenummer, Beskrivelse)
      const aoa = XLSX.utils.sheet_to_json(sheet, { header:1, raw:false, defval:'' });
      const items = [];
      for(const r of aoa){
        const part = String((r && r[0]) || '').trim();
        if(!part || ['delenummer','part','varenr','artnr','sku'].includes(normalizeKey(part))) continue;
        const desc = String((r && r[1]) || '').trim();
        items.push({ part_number: part, description: desc || undefined });
      }
      if(items.length){
        if(apply){
          let applied = 0; const results = [];
          for(const it of items){
            try{ const part = await upsertPartPartial({ pn: it.part_number, description: it.description }); applied++; results.push({ ok:true, part_number: part.part_number }); }
            catch(e){ results.push({ ok:false, error:e.message, part_number: it.part_number }); }
          }
          return res.json({ ok:true, sheet: sheetName, count: items.length, applied, results });
        } else {
          return res.json({ ok:true, sheet: sheetName, count: items.length, applied:0, items: items.slice(0,100) });
        }
      }
      return res.status(400).json({ ok:false, error:'Mangler påkrevd kolonne for delenummer', need:{ part:COLS.part }, have: keys });
    }
    const srcRows = rows;
    const items = [];
    for(const r of srcRows){
      const part = String(r[colPart]||'').trim();
      if(!part) continue;
  const desc = colDesc ? String(r[colDesc]??'').trim() : undefined;
      const minRaw = colMin ? String(r[colMin]??'').trim() : undefined;
      const qtyRaw = colQty ? String(r[colQty]??'').trim() : undefined;
      const minv = (minRaw===undefined || minRaw==='') ? undefined : (parseInt(minRaw.replace(/,/g,'.'),10));
      const qtyv = (qtyRaw===undefined || qtyRaw==='') ? undefined : (parseInt(qtyRaw.replace(/,/g,'.'),10));
  const loc  = colLoc ? String(r[colLoc]??'').trim() : undefined;
      items.push({ part_number: part, description: desc, min_qty: (minv==null||Number.isNaN(minv))? undefined : Math.max(0,minv), qty: (qtyv==null||Number.isNaN(qtyv))? undefined : Math.max(0,qtyv), location_code: (loc && loc.length? loc: undefined) });
    }
    if(!items.length) return res.status(400).json({ ok:false, error:'Ingen gyldige rader' });

    const results = [];
    let applied = 0;
    if(apply){
      for(const it of items){
        try{
          let loc = null;
          let defaultLocIdParam;
          if(it.location_code){
            loc = await getOrCreateLocationByCode(it.location_code);
            defaultLocIdParam = loc ? loc.id : null; // explicit set when provided
          }
          const existing = await getPartByNumber(it.part_number);
          const part = await upsertPartPartial({ pn: it.part_number, description: it.description, min_qty: it.min_qty, defaultLocId: (defaultLocIdParam !== undefined ? defaultLocIdParam : undefined) });
          // Only set stock if qty provided in file; use explicit loc if provided, else use part's default
          let stockRes = null;
          if(it.qty !== undefined){
            const locId = (defaultLocIdParam !== undefined ? defaultLocIdParam : (part && part.default_location_id ? part.default_location_id : null));
            if(locId){ stockRes = await setStockQty(part.id, locId, it.qty); }
          }
          applied++;
          results.push({ ok:true, part_number: part.part_number, default_location_id: part.default_location_id||null, stock: stockRes, min_qty: part.min_qty });
        } catch(e){
          results.push({ ok:false, error: e.message, part_number: it.part_number });
        }
      }
    }

    res.json({ ok:true, sheet: sheetName, count: items.length, applied: apply ? applied : 0, items: apply ? undefined : items.slice(0, 100), results: apply ? results : undefined });
  } catch(e){
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Debug endpoint for alert state (in-memory)
app.get('/api/debug/alert-state', requireAuth, (req,res)=> {
  res.json({ alertState });
});

// === Excel import for locations (Navn/Name + Barcode) ===
const LOC_COLS = {
  name: ['navn','name','lokasjon','location','plass','hylle'],
  barcode: ['barcode','strekkode','kode','code','locbarcode']
};

app.post('/api/locations/import-excel', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ ok:false, error:'Mangler fil (felt: file)' });
    const apply = req.query.apply === '1';
    const wb = XLSX.read(req.file.buffer, { type:'buffer' });
    const sheetName = wb.SheetNames[0];
    if(!sheetName) return res.status(400).json({ ok:false, error:'Tom arbeidsbok' });
    const sheet = wb.Sheets[sheetName];
    let rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
    if(!rows.length){
      return res.status(400).json({ ok:false, error:'Ingen rader i første ark' });
    }
    let keys = Object.keys(rows[0]||{});
    let colName = guessCol(keys, LOC_COLS.name);
    let colBarcode = guessCol(keys, LOC_COLS.barcode);

    let items = [];
    if(colName && colBarcode){
      for(const r of rows){
        const name = String(r[colName]||'').trim();
        const barcode = String(r[colBarcode]||'').trim();
        if(!name && !barcode) continue;
        items.push({ name, barcode });
      }
    } else {
      // Headerless fallback: anta to første kolonner = Navn, Barcode
      const aoa = XLSX.utils.sheet_to_json(sheet, { header:1, raw:false, defval:'' });
      for(const r of aoa){
        const c0 = (r && r[0]) ? String(r[0]).trim() : '';
        const c1 = (r && r[1]) ? String(r[1]).trim() : '';
        if(!c0 && !c1) continue;
        // hopp over header-rad
        const n0 = normalizeKey(c0);
        const n1 = normalizeKey(c1);
        if(['navn','name','lokasjon','location'].includes(n0) || ['barcode','strekkode','kode','code'].includes(n1)) continue;
        items.push({ name: c0, barcode: c1 });
      }
    }
    // Rens og dedupliser på barcode (siste vinner)
    const map = new Map();
    for(const it of items){
      const name = String(it.name||'').trim();
      const barcode = String(it.barcode||'').trim();
      if(!barcode) continue; // barcode kreves for oppretting/oppdatering
      map.set(barcode, { name, barcode });
    }
    items = [...map.values()];
    if(!items.length){
      return res.status(400).json({ ok:false, error:'Ingen gyldige rader (krever Barcode, Navn anbefales)' });
    }

    if(!apply){
      return res.json({ ok:true, sheet: sheetName, count: items.length, applied:0, items: items.slice(0, 200) });
    }

    const results = [];
    let appliedCount = 0;
    for(const it of items){
      try {
        // Finn eksisterende etter barcode
        const existing = await new Promise((resv,rej)=> db.get(`SELECT * FROM locations WHERE barcode = ${qMarks([''])[0]}`, [it.barcode], (e,r)=> e?rej(e):resv(r)));
        if(existing){
          const newName = it.name || existing.name;
          const sql = usePg ? 'UPDATE locations SET name = $1 WHERE id = $2' : 'UPDATE locations SET name = ? WHERE id = ?';
          await new Promise((resv,rej)=> db.run(sql, [newName, existing.id], (e)=> e?rej(e):resv()));
          results.push({ ok:true, action:'update', id: existing.id, name: newName, barcode: existing.barcode });
        } else {
          if(!it.name){
            // name mangler – bruk barcode som name som fallback
            it.name = it.barcode;
          }
          if(usePg){
            const row = await pgdb.get('INSERT INTO locations (name, barcode) VALUES ($1,$2) RETURNING id', [it.name, it.barcode]);
            results.push({ ok:true, action:'insert', id: row.id, name: it.name, barcode: it.barcode });
          } else {
            await new Promise((resv,rej)=> db.run('INSERT INTO locations (name, barcode) VALUES (?,?)', [it.name, it.barcode], function(e){ return e?rej(e):resv(this.lastID); }));
            results.push({ ok:true, action:'insert', name: it.name, barcode: it.barcode });
          }
        }
        appliedCount++;
      } catch(e){
        results.push({ ok:false, error: e.message, name: it.name, barcode: it.barcode });
      }
    }

    return res.json({ ok:true, sheet: sheetName, count: items.length, applied: appliedCount, results });
  } catch(e){
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// --- WebSocket (Zebra DataWedge) støtte ---
// DataWedge kan konfigureres til å sende Intents til en liten Android WebView wrapper
// men enklere er å bruke DataWedge WF (IP) Plugin eller en mellom-app som videresender
// skann til denne serveren via WebSocket. For ren PWA bruker vi en enkel WS kanal.
// Klienten åpner ws://HOST:PORT/scan og mottar JSON { type:'scan', data:'<kode>' } hvis
// server (eller annet system) pusher. Vi støtter også at klient selv sender { scan:"CODE" }.
let wss = null; let wsClients = new Set();
try {
  const httpServer = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  const { Server: WSServer } = require('ws');
  wss = new WSServer({ server: httpServer, path: '/scan' });
  wss.on('connection', (ws, req) => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type:'hello', msg:'WS tilkoblet' }));
    ws.on('message', msg => {
      try {
        const data = JSON.parse(msg.toString());
        // Hvis klient sender { scan:"CODE" } broadcast til alle andre (echo til debug)
        if(data && data.scan){
          const payload = JSON.stringify({ type:'scan', data: String(data.scan) });
          wsClients.forEach(c => { if(c.readyState===1) c.send(payload); });
        }
      } catch(e){ /* ignore */ }
    });
    ws.on('close', ()=> wsClients.delete(ws));
  });
  // Enkel HTTP endpoint for å sende en testskann (for integrasjon eller curl)
  app.post('/api/debug/push-scan', (req,res)=> {
    const code = (req.body && req.body.code)|| (req.query && req.query.code);
    if(!code) return res.status(400).json({ error:'code required'});
    const payload = JSON.stringify({ type:'scan', data: String(code) });
    let sent = 0; wsClients.forEach(c=> { if(c.readyState===1){ c.send(payload); sent++; } });
    res.json({ ok:true, sent });
  });
} catch(e){
  console.error('[WS INIT FAILED]', e.message);
  app.listen(PORT, () => console.log(`Server listening on port ${PORT} (uten WebSocket)`));
}
