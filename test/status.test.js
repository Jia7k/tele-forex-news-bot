const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getStatusState,
  recordTelegramPollingError,
} = require('../src/status');

test('recordTelegramPollingError marks polling conflicts in status', () => {
  recordTelegramPollingError({
    code: 'ETELEGRAM',
    description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
  });

  const state = getStatusState();

  assert.equal(state.telegram.pollingConflict, true);
  assert.equal(state.telegram.lastPollingError.code, 'ETELEGRAM');
  assert.match(state.telegram.lastPollingError.description, /Conflict/);
});
