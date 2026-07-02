const fs = require('fs');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const storePath = process.env.STORE_PATH || path.join(__dirname, '..', 'data', 'store.json');
fs.mkdirSync(path.dirname(storePath), { recursive: true });

const adapter = new FileSync(storePath);
const db = low(adapter);

db.defaults({sentEvents: [], lastFetch: null}).write();

const normalizeEventId = (eventId) => String(eventId || '').trim();
const getSentEvents = () => db.get('sentEvents').value() || [];

module.exports = {
  hasSent: (eventId) => {
    const normalizedId = normalizeEventId(eventId);
    if (!normalizedId) return false;

    return getSentEvents().some((sentId) => normalizeEventId(sentId) === normalizedId);
  },
  markSent: (eventId) => {
    const normalizedId = normalizeEventId(eventId);
    if (!normalizedId || module.exports.hasSent(normalizedId)) return false;

    db.get('sentEvents').push(normalizedId).write();
    return true;
  },
  setLastFetch: (t) => db.set('lastFetch', t).write(),
  getLastFetch: () => db.get('lastFetch').value(),
};
