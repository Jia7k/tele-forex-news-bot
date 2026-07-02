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
  assert.deepEqual(persisted.sentEvents, ['123']);
});
