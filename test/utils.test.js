process.env.TARGET_TZ = 'Asia/Singapore';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatEventMessage,
  formatEventTime,
  getSurpriseText,
  parseDateText,
  parseMetricValue,
  parseTimeText,
} = require('../src/utils');

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

test('parseMetricValue handles suffix multipliers', () => {
  assert.equal(parseMetricValue('42K').value, 42000);
  assert.equal(parseMetricValue('-1.5B').value, -1500000000);
  assert.equal(parseMetricValue('0.4%').value, 0.4);
});

test('getSurpriseText compares actual and forecast', () => {
  const surprise = getSurpriseText({
    actual: '256K',
    forecast: '180K',
  });

  assert.match(surprise, /Higher than forecast/);
  assert.match(surprise, /\+76K/);
});
