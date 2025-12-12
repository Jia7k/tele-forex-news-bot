const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('./data/store.json');
const db = low(adapter);

// defaults
db.defaults({sentEvents: [], lastFetch: null}).write();

module.exports = {
  hasSent: (eventId) => db.get('sentEvents').includes(eventId).value(),
  markSent: (eventId) => db.get('sentEvents').push(eventId).write(),
  setLastFetch: (t) => db.set('lastFetch', t).write(),
  getLastFetch: () => db.get('lastFetch').value(),
};
