// Seed example data
require('dotenv').config();
const db = require('./db');

function run(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function seed() {
  try {
  // Example part only; locations and stock removed so seed won't recreate test locations
  await run('INSERT OR IGNORE INTO parts (id, part_number, description, min_qty) VALUES (1, "TAN-000623", "Eksempel del", 5)');
    console.log('Seed completed');
    process.exit(0);
  } catch (e) {
    console.error('Seed failed', e);
    process.exit(1);
  }
}

seed();
