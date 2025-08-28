const db = require('../db');

db.serialize(() => {
  db.run('DELETE FROM transactions', function(err) {
    if (err) console.error('Error deleting transactions', err);
    else console.log('Deleted transactions');

    db.run('DELETE FROM stock', function(err2) {
      if (err2) console.error('Error deleting stock', err2);
      else console.log('Deleted stock');

      db.run('DELETE FROM parts', function(err3) {
        if (err3) console.error('Error deleting parts', err3);
        else console.log('Deleted parts');
        db.close();
      });
    });
  });
});
