const fs = require('fs');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const storePath = process.env.STORE_PATH || path.join(__dirname, '..', 'data', 'store.json');
fs.mkdirSync(path.dirname(storePath), { recursive: true });

const adapter = new FileSync(storePath);
const db = low(adapter);

db.defaults({ sentEvents: [], lastFetch: null }).write();

const normalizeEventId = (eventId) => (
  eventId === null || eventId === undefined ? '' : String(eventId)
).trim();
const getSentEvents = () => db.get('sentEvents').value() || [];
const getSentEventId = (entry) => normalizeEventId(
  typeof entry === 'object' && entry !== null ? entry.id : entry
);
const getSentEventTime = (entry) => (
  typeof entry === 'object' && entry !== null ? entry.sentAt : null
);

module.exports = {
  hasSent: (eventId) => {
    const normalizedId = normalizeEventId(eventId);
    if (!normalizedId) return false;

    return getSentEvents().some((entry) => getSentEventId(entry) === normalizedId);
  },
  markSent: (eventId) => {
    const normalizedId = normalizeEventId(eventId);
    if (!normalizedId || module.exports.hasSent(normalizedId)) return false;

    db.get('sentEvents').push({
      id: normalizedId,
      sentAt: new Date().toISOString(),
    }).write();
    return true;
  },
  cleanupSentEvents: (ttlDays) => {
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return 0;

    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    const originalEvents = getSentEvents();
    const keptEvents = originalEvents.filter((entry) => {
      const sentAt = getSentEventTime(entry);
      if (!sentAt) return true;

      const timestamp = Date.parse(sentAt);
      return Number.isNaN(timestamp) || timestamp >= cutoff;
    });

    db.set('sentEvents', keptEvents).write();
    return originalEvents.length - keptEvents.length;
  },
  getSentEventCount: () => getSentEvents().length,
  setLastFetch: (t) => db.set('lastFetch', t).write(),
  getLastFetch: () => db.get('lastFetch').value(),
};
