// One-time migration from SQLite to Postgres
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const pg = require('../pgdb');

async function main(){
  if(!pg.enabled()){ console.error('Postgres not configured'); process.exit(1); }
  const dbFile = process.env.DB_FILE || path.join(__dirname,'..','partstore.db');
  const sdb = new sqlite3.Database(dbFile);

  function all(db, sql, params=[]) { return new Promise((res,rej)=> db.all(sql, params, (e,r)=> e?rej(e):res(r))); }

  const parts = await all(sdb,'SELECT * FROM parts');
  const locations = await all(sdb,'SELECT * FROM locations');
  const stock = await all(sdb,'SELECT * FROM stock');
  const transactions = await all(sdb,'SELECT * FROM transactions');
  const users = await all(sdb,'SELECT * FROM users');

  console.log('Migrating', { parts: parts.length, locations: locations.length, stock: stock.length, transactions: transactions.length, users: users.length });

  for(const p of parts){
    await pg.run('INSERT INTO parts (part_number, description, min_qty) VALUES ($1,$2,$3) ON CONFLICT (part_number) DO NOTHING', [p.part_number, p.description, p.min_qty]);
  }
  const locIdMap = {}; // map old id -> new id (need lookup by barcode)
  for(const l of locations){
    await pg.run('INSERT INTO locations (name, barcode) VALUES ($1,$2) ON CONFLICT (barcode) DO NOTHING', [l.name, l.barcode]);
    locIdMap[l.id] = l.barcode;
  }
  // Build part id map via part_number later if needed
  // Stock: need to translate part_id/location_id using lookups
  // We'll rely on part_number + barcode via additional queries
  async function getPartId(pn){ const r = await pg.get('SELECT id FROM parts WHERE part_number=$1',[pn]); return r && r.id; }
  async function getLocId(bc){ const r = await pg.get('SELECT id FROM locations WHERE barcode=$1',[bc]); return r && r.id; }

  for(const st of stock){
    const partRow = await all(sdb,'SELECT part_number FROM parts WHERE id=?',[st.part_id]).then(r=>r[0]);
    const locRow = await all(sdb,'SELECT barcode FROM locations WHERE id=?',[st.location_id]).then(r=>r[0]);
    if(!partRow || !locRow) continue;
    const pid = await getPartId(partRow.part_number); const lid = await getLocId(locRow.barcode);
    if(pid && lid){
      await pg.run('INSERT INTO stock (part_id, location_id, qty) VALUES ($1,$2,$3) ON CONFLICT (part_id,location_id) DO UPDATE SET qty=EXCLUDED.qty',[pid,lid,st.qty]);
    }
  }
  for(const tr of transactions){
    const partRow = await all(sdb,'SELECT part_number FROM parts WHERE id=?',[tr.part_id]).then(r=>r[0]);
    const locRow = await all(sdb,'SELECT barcode FROM locations WHERE id=?',[tr.location_id]).then(r=>r[0]);
    if(!partRow || !locRow) continue;
    const pid = await getPartId(partRow.part_number); const lid = await getLocId(locRow.barcode);
    if(pid && lid){
      await pg.run('INSERT INTO transactions (part_id, location_id, qty, action, created_at) VALUES ($1,$2,$3,$4,$5)', [pid,lid,tr.qty,tr.action,tr.created_at]);
    }
  }
  for(const u of users){
    await pg.run('INSERT INTO users (username, password) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING',[u.username,u.password]);
  }
  console.log('Migration complete');
  process.exit(0);
}

main().catch(e=> { console.error(e); process.exit(1); });
