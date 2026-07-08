process.env.TARGET_TZ = 'Asia/Singapore';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findFallbackMatch,
  formatFallbackValue,
  normalizeForMatch,
} = require('../src/fallback');

test('normalizeForMatch removes noisy event qualifiers', () => {
  assert.equal(
    normalizeForMatch('Final Wholesale Inventories m/m'),
    'wholesale inventories month over month'
  );
});

test('formatFallbackValue appends unit only when needed', () => {
  assert.equal(formatFallbackValue('2.25', '%'), '2.25%');
  assert.equal(formatFallbackValue('2.25%', '%'), '2.25%');
  assert.equal(formatFallbackValue('-1.5B', 'B'), '-1.5B');
  assert.equal(formatFallbackValue(0, '%'), '0%');
});

test('findFallbackMatch matches by country time and event name', () => {
  const targetEvent = {
    dateStr: 'Wed Jul 8',
    timeText: '10:00pm',
    year: 2026,
    currency: 'USD',
    eventName: 'Final Wholesale Inventories m/m',
    actual: '',
    forecast: '0.3%',
    previous: '0.3%',
  };
  const rows = [{
    Country: 'United States',
    Event: 'Wholesale Inventories MoM',
    Date: '2026-07-08T14:00:00',
    Actual: '0.3%',
    Forecast: '0.3%',
    Previous: '0.3%',
    Unit: '%',
  }];

  const match = findFallbackMatch(targetEvent, rows);
  assert.equal(match, rows[0]);
});

test('findFallbackMatch accepts numeric zero actual values', () => {
  const targetEvent = {
    dateStr: 'Wed Jul 8',
    timeText: '10:00pm',
    year: 2026,
    currency: 'USD',
    eventName: 'Wholesale Inventories m/m',
    actual: '',
    forecast: '0.3%',
    previous: '0.3%',
  };
  const rows = [{
    Country: 'United States',
    Event: 'Wholesale Inventories MoM',
    Date: '2026-07-08T14:00:00',
    Actual: 0,
    Forecast: '0.3%',
    Previous: '0.3%',
    Unit: '%',
  }];

  const match = findFallbackMatch(targetEvent, rows);
  assert.equal(match, rows[0]);
});
