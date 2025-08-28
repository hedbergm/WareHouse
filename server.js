require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bwipjs = require('bwip-js');
const nodemailer = require('nodemailer');
const db = require('./db');

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

// Optional simple mobile pass validation endpoint (demo only)
app.get('/api/mobile/validate', (req, res) => {
  const pass = req.query.pass || '';
  if (!process.env.MOBILE_PASS) return res.status(400).json({ error: 'MOBILE_PASS not configured' });
  if (pass === process.env.MOBILE_PASS) return res.json({ ok: true });
  res.status(401).json({ error: 'invalid' });
});

// Simple mobile login using users table
app.post('/api/mobile/login', (req, res) => {
  const { username, password } = req.body || {};
  // Fallback: allow simple password-only auth via MOBILE_PASS (optional)
  if (process.env.MOBILE_PASS && password === process.env.MOBILE_PASS) {
    const user = username && username.trim() ? username.trim() : 'mobile';
    const token = Buffer.from(`${user}:${password}`).toString('base64');
    return res.json({ ok: true, token, username: user, mode: 'env-pass' });
  }
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(401).json({ error: 'invalid' });
    // Return simple token (for demo): base64(username:password)
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    res.json({ ok: true, token, username });
  });
});

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

// Helpers
function getPartByNumber(part_number) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM parts WHERE part_number = ?', [part_number], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getLocationByBarcode(barcode) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM locations WHERE barcode = ?', [barcode], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getTotalQty(part_id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT SUM(qty) as total FROM stock WHERE part_id = ?', [part_id], (err, row) => {
      if (err) return reject(err);
      resolve(row && row.total ? row.total : 0);
    });
  });
}

// API
app.post('/api/locations', (req, res) => {
  const { name, barcode } = req.body;
  if (!name || !barcode) return res.status(400).json({ error: 'name and barcode required' });
  db.run('INSERT INTO locations (name, barcode) VALUES (?, ?)', [name, barcode], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name, barcode });
  });
});

app.get('/api/locations', (req, res) => {
  db.all('SELECT * FROM locations', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Update location
app.put('/api/locations/:id', (req, res) => {
  const id = req.params.id;
  const { name, barcode } = req.body;
  if (!name || !barcode) return res.status(400).json({ error: 'name and barcode required' });
  db.run('UPDATE locations SET name = ?, barcode = ? WHERE id = ?', [name, barcode, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name, barcode });
  });
});

// Delete location (and related stock/transactions)
app.delete('/api/locations/:id', (req, res) => {
  const id = req.params.id;
  db.serialize(() => {
    db.run('DELETE FROM transactions WHERE location_id = ?', [id]);
    db.run('DELETE FROM stock WHERE location_id = ?', [id]);
    db.run('DELETE FROM locations WHERE id = ?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  });
});

app.get('/api/locations/:id/barcode.png', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM locations WHERE id = ?', [id], (err, loc) => {
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

app.post('/api/parts', (req, res) => {
  const { part_number, description, min_qty } = req.body;
  if (!part_number) return res.status(400).json({ error: 'part_number required' });
  const minq = parseInt(min_qty || '0', 10);
  db.run('INSERT INTO parts (part_number, description, min_qty) VALUES (?, ?, ?)', [part_number, description || '', minq], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, part_number, description, min_qty: minq });
  });
});

app.get('/api/parts', (req, res) => {
  db.all('SELECT * FROM parts', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Update a part
app.put('/api/parts/:id', (req, res) => {
  const id = req.params.id;
  const { part_number, description, min_qty } = req.body;
  if (!part_number) return res.status(400).json({ error: 'part_number required' });
  const minq = parseInt(min_qty || '0', 10);
  db.run('UPDATE parts SET part_number = ?, description = ?, min_qty = ? WHERE id = ?', [part_number, description || '', minq, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, part_number, description, min_qty: minq });
  });
});

// Delete a part (and related transactions/stock)
app.delete('/api/parts/:id', (req, res) => {
  const id = req.params.id;
  db.serialize(() => {
    db.run('DELETE FROM transactions WHERE part_id = ?', [id]);
    db.run('DELETE FROM parts WHERE id = ?', [id], function(err) {
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

    db.serialize(async () => {
      // Ensure stock row exists
      db.run(`INSERT OR IGNORE INTO stock (part_id, location_id, qty) VALUES (?, ?, 0)`, [part.id, loc.id]);

      if (action === 'in') {
        db.run(`UPDATE stock SET qty = qty + ? WHERE part_id = ? AND location_id = ?`, [q, part.id, loc.id]);
      } else {
        // Check available at location
        db.get('SELECT qty FROM stock WHERE part_id = ? AND location_id = ?', [part.id, loc.id], async (err, row) => {
          const available = row ? row.qty : 0;
          if (available < q) return res.status(400).json({ error: `Not enough stock at location (available ${available})` });
          db.run(`UPDATE stock SET qty = qty - ? WHERE part_id = ? AND location_id = ?`, [q, part.id, loc.id]);

          // After update check total
          const total = await getTotalQty(part.id);
          const newTotal = total - q; // because getTotalQty was read before update in this branch
          if (newTotal < part.min_qty) {
            sendAlertEmail(part, newTotal);
          }
        });
      }

      // Log transaction
      db.run(`INSERT INTO transactions (part_id, location_id, qty, action) VALUES (?, ?, ?, ?)`, [part.id, loc.id, q, action]);

      res.json({ ok: true });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Get stock for a part
app.get('/api/stock/:part_number', async (req, res) => {
  const part_number = req.params.part_number;
  const part = await getPartByNumber(part_number);
  if (!part) return res.status(404).json({ error: 'part not found' });
  db.all(`SELECT l.id as location_id, l.name as location_name, l.barcode, s.qty FROM stock s JOIN locations l ON s.location_id = l.id WHERE s.part_id = ?`, [part.id], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const total = await getTotalQty(part.id);
    res.json({ part, total, locations: rows });
  });
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
