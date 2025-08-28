const { Pool } = require('pg');
require('dotenv').config();

const required = ['PGHOST','PGUSER','PGPASSWORD','PGDATABASE','PGPORT'];
const hasPg = required.every(v => process.env[v]);

let pool = null;
if (hasPg) {
  pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: parseInt(process.env.PGPORT||'5432',10),
    ssl: process.env.PGSSLMODE ? { rejectUnauthorized:false } : false,
    max: 10
  });
  pool.on('error', err => console.error('[PG POOL ERROR]', err));
  console.log('[PG] Pool initialised');
}

async function query(sql, params) {
  if (!pool) throw new Error('Postgres not configured');
  const res = await pool.query(sql, params);
  return res;
}

module.exports = {
  enabled: () => !!pool,
  query,
  async run(sql, params) { await query(sql, params); return { ok:true }; },
  async get(sql, params) { const r = await query(sql, params); return r.rows[0]||null; },
  async all(sql, params) { const r = await query(sql, params); return r.rows; },
  async close(){ if(pool) await pool.end(); }
};
