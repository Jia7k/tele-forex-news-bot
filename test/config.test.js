const test = require('node:test');
const assert = require('node:assert/strict');

const { parseBoolean, parseChatIds, parseList, parseTelegramMode } = require('../src/config');

test('parseChatIds trims comma-separated chat ids', () => {
  assert.deepEqual(parseChatIds('123, -456,789 ,'), ['123', '-456', '789']);
});

test('parseList trims comma-separated filter values', () => {
  assert.deepEqual(parseList('USD, EUR, High ,'), ['USD', 'EUR', 'High']);
});

test('parseBoolean accepts common env-style boolean values', () => {
  process.env.TEST_BOOLEAN = 'off';
  assert.equal(parseBoolean('TEST_BOOLEAN', true), false);

  process.env.TEST_BOOLEAN = 'yes';
  assert.equal(parseBoolean('TEST_BOOLEAN', false), true);

  delete process.env.TEST_BOOLEAN;
  assert.equal(parseBoolean('TEST_BOOLEAN', true), true);
});

test('parseTelegramMode supports mode and polling compatibility flags', () => {
  const oldMode = process.env.TELEGRAM_MODE;
  const oldPolling = process.env.TELEGRAM_POLLING;

  process.env.TELEGRAM_MODE = 'webhook';
  assert.equal(parseTelegramMode(), 'webhook');

  delete process.env.TELEGRAM_MODE;
  process.env.TELEGRAM_POLLING = 'false';
  assert.equal(parseTelegramMode(), 'disabled');

  delete process.env.TELEGRAM_POLLING;
  assert.equal(parseTelegramMode(), 'polling');

  if (oldMode === undefined) delete process.env.TELEGRAM_MODE;
  else process.env.TELEGRAM_MODE = oldMode;

  if (oldPolling === undefined) delete process.env.TELEGRAM_POLLING;
  else process.env.TELEGRAM_POLLING = oldPolling;
});
