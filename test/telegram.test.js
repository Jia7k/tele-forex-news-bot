const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTelegramBotOptions } = require('../src/telegramOptions');
const { createPollingErrorHandler } = require('../src/telegramPollingErrors');

test('buildTelegramBotOptions configures slower polling retries', () => {
  assert.deepEqual(
    buildTelegramBotOptions({
      polling: true,
      pollingIntervalMs: 5000,
      pollingTimeoutSeconds: 30,
    }),
    {
      polling: {
        interval: 5000,
        params: {
          timeout: 30,
        },
      },
      request: {
        agentOptions: {
          family: 4,
        },
      },
    }
  );
});

test('buildTelegramBotOptions keeps disabled mode from starting polling', () => {
  assert.equal(
    buildTelegramBotOptions({
      polling: false,
      pollingIntervalMs: 5000,
      pollingTimeoutSeconds: 30,
    }).polling,
    false
  );
});

test('polling error handler throttles transient Bad Gateway logs', () => {
  const records = [];
  const logs = [];
  let currentTime = 1_000;
  const error = {
    code: 'ETELEGRAM',
    response: {
      statusCode: 502,
      body: {
        description: 'Bad Gateway',
      },
    },
  };
  const handler = createPollingErrorHandler({
    logThrottleMs: 60_000,
    now: () => currentTime,
    record: (details) => records.push(details),
    logger: {
      error: (...args) => logs.push(['error', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
    },
  });

  handler(error);
  currentTime += 1_000;
  handler(error);
  currentTime += 60_000;
  handler(error);

  assert.equal(records.length, 3);
  assert.equal(logs.length, 2);
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /transient/i);
  assert.equal(logs[1][0], 'warn');
  assert.match(logs[1][1], /1 similar polling error suppressed/);
});
