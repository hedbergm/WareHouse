require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bwipjs = require('bwip-js');
const nodemailer = require('nodemailer');
const dbSqlite = require('./db');
const pgdb = require('./pgdb');
const usePg = pgdb.enabled();
console.log('[DB MODE]', usePg ? 'Postgres' : 'SQLite');

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

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Root should show home.html (not index.html)
app.get('/', (req,res)=> res.sendFile(require('path').join(__dirname,'public','home.html')));

// Static files without automatic index so our custom '/' works
app.use(express.static('public', { index: false }));

const PORT = process.env.PORT || 3000; // ngrok fjernet

const os = require('os');

// Return first non-internal IPv4 address (LAN)
app.get('/api/network', (req, res) => {
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

// Mobile login removed (temporary open access per request)

// Nodemailer transporter placeholder - will use Office365 when env vars are present
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
} else {
  console.log('SMTP credentials not provided. Alerts will be logged to console only.');
}

function sendAlertEmail(part, totalQty) {
  const to = process.env.ALERT_EMAIL || 'mhe@holship.com';
  const subject = `Lav beholdning: ${part.part_number}`;
  const text = `Del ${part.part_number} (${part.description || ''}) har nå total beholdning ${totalQty} som er under min ${part.min_qty}.`;

  if (!transporter) {
    console.log('[ALERT - not sent, SMTP not configured] ', subject, text);
    return;
  }

  const msg = {
    from: process.env.SMTP_USER,
    to,
    subject,
    text
  };

  transporter.sendMail(msg, (err, info) => {
    if (err) console.error('Failed to send alert email', err);
    else console.log('Alert email sent', info.response);
  });
}

// Manual test endpoint for alert email
app.post('/api/debug/test-alert', async (req,res) => {
  try {
    const pn = (req.body && req.body.part_number) || req.query.part_number;
    if(!pn) return res.status(400).json({ error:'part_number required'});
    const part = await getPartByNumber(pn);
    if(!part) return res.status(404).json({ error:'part not found'});
    sendAlertEmail(part, await getTotalQty(part.id));
    res.json({ ok:true });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// Helpers
function qMarks(params){ return usePg ? params.map((_,i)=>'$'+(i+1)) : params.map(()=>'?'); }

function getPartByNumber(part_number) { return new Promise((res,rej)=> db.get(`SELECT * FROM parts WHERE part_number = ${qMarks([''])[0]}`, [part_number], (e,r)=> e?rej(e):res(r))); }
function getLocationByBarcode(barcode) { return new Promise((res,rej)=> db.get(`SELECT * FROM locations WHERE barcode = ${qMarks([''])[0]}`, [barcode], (e,r)=> e?rej(e):res(r))); }
function getTotalQty(part_id) { return new Promise((res,rej)=> db.get(`SELECT SUM(qty) as total FROM stock WHERE part_id = ${qMarks([''])[0]}`, [part_id], (e,r)=> e?rej(e):res(r? r.total:0))); }

// API
app.post('/api/locations', async (req, res) => {
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

app.get('/api/locations', (req, res) => {
  db.all('SELECT * FROM locations', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get stock contents for a location by its barcode
app.get('/api/locations/:barcode/stock', async (req, res) => {
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
app.put('/api/locations/:id', (req, res) => {
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
app.delete('/api/locations/:id', (req, res) => {
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

app.get('/api/locations/:id/barcode.png', (req, res) => {
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
app.get('/api/parts/:part_number/barcode.png', (req, res) => {
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

app.post('/api/parts', async (req, res) => {
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

app.get('/api/parts', (req, res) => {
  db.all('SELECT * FROM parts', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Update a part
app.put('/api/parts/:id', async (req, res) => {
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
app.delete('/api/parts/:id', (req, res) => {
  const id = req.params.id;
  db.serialize(() => {
  db.run(`DELETE FROM transactions WHERE part_id = ${qMarks([id])[0]}`, [id]);
  db.run(`DELETE FROM parts WHERE id = ${qMarks([id])[0]}`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  });
});

// Scan endpoint - scan a location barcode, provide part_number, qty and action (in/out)
app.post('/api/stock/scan', async (req, res) => {
  try {
    const { location_barcode, part_number, qty, action } = req.body;
    if (!location_barcode || !part_number || !qty || !action) return res.status(400).json({ error: 'location_barcode, part_number, qty and action required' });
    const q = parseInt(qty, 10);
    if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'qty must be a positive integer' });
    if (!['in', 'out'].includes(action)) return res.status(400).json({ error: 'action must be "in" or "out"' });

    const part = await getPartByNumber(part_number);
    if (!part) return res.status(404).json({ error: 'part not found' });
    const loc = await getLocationByBarcode(location_barcode);
    if (!loc) return res.status(404).json({ error: 'location not found' });

    if (part.default_location_id && String(part.default_location_id) !== String(loc.id)) {
      return res.status(400).json({ error: 'part has fixed location' });
    }

    db.serialize(async () => {
      // Ensure stock row exists (qty=0 if new)
      const ensureSql = usePg ? 'INSERT INTO stock (part_id, location_id, qty) VALUES ($1,$2,0) ON CONFLICT (part_id, location_id) DO NOTHING' : 'INSERT OR IGNORE INTO stock (part_id, location_id, qty) VALUES (?, ?, 0)';
      db.run(ensureSql, [part.id, loc.id]);

      if (action === 'in') {
        const updSql = usePg ? 'UPDATE stock SET qty = qty + $1 WHERE part_id = $2 AND location_id = $3' : 'UPDATE stock SET qty = qty + ? WHERE part_id = ? AND location_id = ?';
        db.run(updSql, [q, part.id, loc.id]);
        const totalAfter = await getTotalQty(part.id);
        console.log('[ALERT CHECK][IN]', { part: part.part_number, totalAfter, min: part.min_qty });
        if (totalAfter <= part.min_qty) {
          console.log('[ALERT TRIGGER][IN]', part.part_number, totalAfter, '<= min', part.min_qty);
          sendAlertEmail(part, totalAfter);
        }
        finalize();
      } else {
        const selSql = usePg ? 'SELECT qty FROM stock WHERE part_id = $1 AND location_id = $2' : 'SELECT qty FROM stock WHERE part_id = ? AND location_id = ?';
        db.get(selSql, [part.id, loc.id], async (err, row) => {
          if (err) return res.status(500).json({ error: err.message });
          const available = row ? row.qty : 0;
            if (available < q) return res.status(400).json({ error: `Not enough stock at location (available ${available})` });
          const updOut = usePg ? 'UPDATE stock SET qty = qty - $1 WHERE part_id = $2 AND location_id = $3' : 'UPDATE stock SET qty = qty - ? WHERE part_id = ? AND location_id = ?';
          db.run(updOut, [q, part.id, loc.id]);
          const totalAfter = await getTotalQty(part.id);
          console.log('[ALERT CHECK][OUT]', { part: part.part_number, totalAfter, min: part.min_qty });
          if (totalAfter <= part.min_qty) {
            console.log('[ALERT TRIGGER][OUT]', part.part_number, totalAfter, '<= min', part.min_qty);
            sendAlertEmail(part, totalAfter);
          }
          finalize();
        });
      }

      function finalize(){
        const txSql = usePg ? 'INSERT INTO transactions (part_id, location_id, qty, action) VALUES ($1,$2,$3,$4)' : 'INSERT INTO transactions (part_id, location_id, qty, action) VALUES (?,?,?,?)';
        db.run(txSql, [part.id, loc.id, q, action]);
        console.log('[STOCK SCAN]', { part: part.part_number, location: loc.barcode, action, qty: q });
        res.json({ ok: true, part: part.part_number, location: loc.barcode, qty: q, action });
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Debug endpoints (non-authenticated; consider protecting for production)
app.get('/api/debug/parts', (req,res) => {
  db.all('SELECT * FROM parts', (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});
app.get('/api/debug/locations', (req,res) => {
  db.all('SELECT * FROM locations', (e, rows) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});

// /api/debug/mobile-auth removed with mobile login

// Get stock for a part
app.get('/api/stock/:part_number', async (req, res) => {
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
app.get('/api/parts/resolve/:code', (req,res) => {
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

// Heuristikk-endpoint for å sjekke sannsynlig feiltolket Code128 (f.eks TAN-00623 lest som 51793111)
app.get('/api/parts/heuristic/map/:code', (req,res)=> {
  const raw = req.params.code.trim();
  // Hvis innkoden er kun tall og ingen direkte match finnes, forsøk å finne en part med bindestrek som har tilsvarende lengde
  if(!/^[0-9]+$/.test(raw)) return res.json({ passthrough: true });
  db.all('SELECT part_number FROM parts WHERE part_number LIKE %s', [], (e,rows)=>{
    // Simplified placeholder – can be expanded; returning passthrough
    return res.json({ passthrough: true });
  });
});

// Legg til alias strekkode for del
app.post('/api/parts/:id/barcodes', (req,res) => {
  const id = req.params.id; const { barcode } = req.body || {};
  if(!barcode) return res.status(400).json({ error: 'barcode required' });
  const sql = `INSERT INTO part_barcodes (part_id, barcode) VALUES (${qMarks([id, barcode]).join(', ')})`;
  db.run(sql, [id, barcode], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, part_id: id, barcode });
  });
});

// List alias strekkoder for del
app.get('/api/parts/:id/barcodes', (req,res) => {
  const id = req.params.id;
  db.all(`SELECT * FROM part_barcodes WHERE part_id = ${qMarks([id])[0]}`, [id], (e, rows) => {
    if(e) return res.status(500).json({ error: e.message });
    res.json(rows);
  });
});

// Slett alias
app.delete('/api/parts/:id/barcodes/:bid', (req,res) => {
  const bid = req.params.bid;
  db.run(`DELETE FROM part_barcodes WHERE id = ${qMarks([bid])[0]}`, [bid], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Debug status: counts + db mode
app.get('/api/debug/status', (req,res) => {
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

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
