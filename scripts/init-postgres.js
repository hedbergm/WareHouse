// Initialize Postgres schema if not exists
const pg = require('../pgdb');

async function main(){
  if(!pg.enabled()){ console.log('Postgres not configured'); return; }
  const ddl = `
  CREATE TABLE IF NOT EXISTS parts(
    id SERIAL PRIMARY KEY,
    part_number TEXT UNIQUE NOT NULL,
    description TEXT,
    min_qty INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS locations(
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    barcode TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stock(
    id SERIAL PRIMARY KEY,
    part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL DEFAULT 0,
    UNIQUE(part_id, location_id)
  );
  CREATE TABLE IF NOT EXISTS transactions(
    id SERIAL PRIMARY KEY,
    part_id INTEGER NOT NULL REFERENCES parts(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    qty INTEGER NOT NULL,
    action TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );`;
  for(const stmt of ddl.split(/;\s*/)){ if(stmt.trim()) await pg.run(stmt); }
  console.log('Postgres schema ensured');
  process.exit(0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
