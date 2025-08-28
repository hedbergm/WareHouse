const db = require('../db');

const users = [
  ['tb','tb1'],
  ['mh','mh1']
];

let done = 0;
users.forEach(u => {
  db.run('INSERT OR IGNORE INTO users (username, password) VALUES (?,?)', u, function(err) {
    if (err) console.error('Failed to insert', u, err);
    else console.log('Inserted user', u[0]);
    done++;
    if (done === users.length) { db.close(); }
  });
});
