const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telebot-store-'));
process.env.STORE_PATH = path.join(storeDir, 'store.json');

const store = require('../src/store');

test('store normalizes sent event ids and avoids duplicates', () => {
  assert.equal(store.hasSent(123), false);
  assert.equal(store.markSent(123), true);
  assert.equal(store.hasSent('123'), true);
  assert.equal(store.markSent('123'), false);

  const persisted = JSON.parse(fs.readFileSync(process.env.STORE_PATH, 'utf8'));
  assert.equal(persisted.sentEvents.length, 1);
  assert.equal(persisted.sentEvents[0].id, '123');
  assert.match(persisted.sentEvents[0].sentAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('store cleans up timestamped sent event ids but keeps legacy ids', () => {
  const RealDate = Date;
  const oldTimestamp = '2026-01-01T00:00:00.000Z';
  const currentTimestamp = '2026-02-01T00:00:00.000Z';

  try {
    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length > 0) return new RealDate(...args);
        return new RealDate(oldTimestamp);
      }

      static now() {
        return new RealDate(oldTimestamp).getTime();
      }

      static parse(value) {
        return RealDate.parse(value);
      }

      static UTC(...args) {
        return RealDate.UTC(...args);
      }
    };

    assert.equal(store.markSent('old'), true);

    global.Date = class extends RealDate {
      constructor(...args) {
        if (args.length > 0) return new RealDate(...args);
        return new RealDate(currentTimestamp);
      }

      static now() {
        return new RealDate(currentTimestamp).getTime();
      }

      static parse(value) {
        return RealDate.parse(value);
      }

      static UTC(...args) {
        return RealDate.UTC(...args);
      }
    };

    assert.equal(store.markSent('fresh'), true);
    assert.equal(store.cleanupSentEvents(14), 1);
    assert.equal(store.hasSent('old'), false);
    assert.equal(store.hasSent('fresh'), true);
  } finally {
    global.Date = RealDate;
  }
});
