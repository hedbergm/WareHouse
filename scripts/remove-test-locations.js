// Remove test locations LOC-A1 and LOC-B2 if present
const db = require('../db');

db.serialize(() => {
  db.run("DELETE FROM stock WHERE location_id IN (SELECT id FROM locations WHERE barcode IN ('LOC-A1','LOC-B2'))", function(err) {
    if (err) console.error('Error deleting stock', err);
    else console.log('Deleted stock rows for test locations');

    db.run("DELETE FROM locations WHERE barcode IN ('LOC-A1','LOC-B2')", function(err2) {
      if (err2) console.error('Error deleting locations', err2);
      else console.log('Deleted test locations');
      db.close();
    });
  });
});
