process.env.TARGET_TZ = 'Asia/Singapore';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatEventMessage, formatEventTime, parseDateText, parseTimeText } = require('../src/utils');

test('parseTimeText parses current Forex Factory date formats', () => {
  assert.equal(
    parseTimeText('Thu Jul 2', '8:30am', 2026).toISOString(),
    '2026-07-02T00:30:00.000Z'
  );
  assert.equal(
    parseTimeText('ThuJul 2', '8:30am', 2026).toISOString(),
    '2026-07-02T00:30:00.000Z'
  );
  assert.equal(
    parseTimeText('Thu Jul 2Thu Jul 2', '3:15am', 2026).toISOString(),
    '2026-07-01T19:15:00.000Z'
  );
  assert.equal(
    parseTimeText('Jul 2', 'All Day', 2026).toISOString(),
    '2026-07-01T16:00:00.000Z'
  );
});

test('parseTimeText ignores tentative events', () => {
  assert.equal(parseTimeText('Thu Jul 2', 'Tentative', 2026), null);
});

test('parseDateText keeps tentative events on the Singapore report date', () => {
  assert.equal(
    parseDateText('Thu Jul 2', 2026).toISOString(),
    '2026-07-01T16:00:00.000Z'
  );
});

test('formatEventTime labels output in Singapore time', () => {
  assert.equal(
    formatEventTime({ dateStr: 'Thu Jul 2', timeText: '8:30pm', year: 2026 }),
    '8:30pm SGT'
  );
  assert.equal(
    formatEventTime({ dateStr: 'Thu Jul 2', timeText: 'Tentative', year: 2026 }),
    'Tentative'
  );
});

test('formatEventMessage escapes Telegram HTML values', () => {
  const message = formatEventMessage({
    impact: 'High',
    currency: 'USD',
    eventName: 'A & B <Test>',
    actual: '1 < 2',
    forecast: 'A&B',
    previous: '',
  });

  assert.match(message, /USD - A &amp; B &lt;Test&gt;/);
  assert.match(message, /<b>1 &lt; 2<\/b>/);
  assert.match(message, /A&amp;B/);
});
