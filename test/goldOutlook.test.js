const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEventAlertBatches, formatEventMessage } = require('../src/utils');

const release = (overrides = {}) => ({
  currency: 'USD',
  eventName: 'CPI m/m',
  actual: '0.4%',
  forecast: '0.3%',
  previous: '0.2%',
  impact: 'High',
  timestamp: 1788957000,
  ...overrides,
});

test('matches the compact alert layout with Gold as the final tree line', () => {
  const message = formatEventMessage(release());
  assert.equal(message.slice(message.indexOf('├ Act:')), [
    '├ Act: <b>0.4%</b>',
    '├ Fcst: 0.3%',
    '├ Prev: 0.2%',
    '├ Surprise: Higher than forecast (+0.1%)',
    '└ Gold : <b>SHORT</b>',
    '',
  ].join('\n'));
  assert.doesNotMatch(message, /Gold outlook|Look for|Live market/);
});

test('cooler inflation produces a LONG data bias', () => {
  const message = formatEventMessage(release({ actual: '0.2%' }));
  assert.match(message, /└ Gold : <b>LONG<\/b>\n$/);
});

test('uses event-specific directions for US economic releases', () => {
  const cases = [
    ['Non-Farm Employment Change', '220K', '180K', 'SHORT'],
    ['ADP Non-Farm Employment Change', '140K', '180K', 'LONG'],
    ['Unemployment Rate', '4.3%', '4.1%', 'LONG'],
    ['Unemployment Claims', '210K', '230K', 'SHORT'],
    ['Continuing Jobless Claims', '1.9M', '1.8M', 'LONG'],
    ['Average Hourly Earnings m/m', '0.4%', '0.3%', 'SHORT'],
    ['Core PCE Price Index m/m', '0.2%', '0.3%', 'LONG'],
    ['Core PPI m/m', '0.4%', '0.3%', 'SHORT'],
    ['Advance GDP q/q', '2.0%', '2.5%', 'LONG'],
    ['Core Retail Sales m/m', '0.6%', '0.3%', 'SHORT'],
    ['ISM Services PMI', '54.2', '52.0', 'SHORT'],
    ['Federal Funds Rate', '4.00%', '4.25%', 'LONG'],
  ];
  for (const [eventName, actual, forecast, direction] of cases) {
    assert.match(formatEventMessage(release({ eventName, actual, forecast })),
      new RegExp(`Gold : <b>${direction}</b>\\n$`), eventName);
  }
});

test('does not confuse unit conversions, zero, or negative values', () => {
  assert.match(formatEventMessage(release({ eventName: 'Non-Farm Employment Change', actual: '0.2M', forecast: '180K' })), /Gold : <b>SHORT<\/b>/);
  assert.match(formatEventMessage(release({ actual: 0, forecast: 0.3 })), /Gold : <b>LONG<\/b>/);
  assert.match(formatEventMessage(release({ eventName: 'GDP q/q', actual: '-0.1%', forecast: '-0.5%' })), /Gold : <b>SHORT<\/b>/);
  assert.match(formatEventMessage(release({ eventName: 'Non-Farm Employment Change', actual: '1,200K', forecast: '1M' })), /Gold : <b>SHORT<\/b>/);
});

test('missing, malformed, or incompatible data never creates a directional recommendation', () => {
  const cases = [
    { actual: '--' }, { actual: 'N/A' }, { actual: null },
    { forecast: '', previous: '0.1%' }, { actual: '0.4', forecast: '0.3%' },
    { actual: '0.4|2.5' }, { actual: '1 < 2' }, { actual: '4.25-4.50%' },
    { actual: '1,2%' }, { actual: 'Infinity' },
  ];
  for (const values of cases) {
    const message = formatEventMessage(release(values));
    assert.match(message, /Gold : <b>WAIT<\/b>\n$/, JSON.stringify(values));
  }
});

test('in-line data does not create a trade bias, even after unit conversion', () => {
  for (const values of [{ actual: '0.3%' }, { actual: '0.18M', forecast: '180K' }]) {
    const message = formatEventMessage(release(values));
    assert.match(message, /Gold : <b>NEUTRAL<\/b>\n$/);
    assert.match(message, /in line with forecast/i);
  }
});

test('the French trade balance example stays NEUTRAL without a forced trade', () => {
  const message = formatEventMessage(release({ currency: 'EUR', eventName: 'French Trade Balance', actual: '-6.7B', forecast: '-6.0B', previous: '-5.8B', impact: 'Low' }));
  assert.match(message, /Gold : <b>NEUTRAL<\/b>\n$/);
  assert.match(message, /Lower than forecast/);
});

test('every other event still gets a footer, including speeches, holidays, and unfamiliar names', () => {
  for (const values of [
    { currency: 'NZD', eventName: 'Official Cash Rate' },
    { currency: 'CNY', eventName: 'CPI y/y' },
    { currency: 'All', eventName: 'G20 Meetings', actual: '' },
    { eventName: 'Bank Holiday', actual: '' },
    { eventName: 'Fed Chair Speaks About CPI', actual: '' },
    { eventName: 'FOMC Statement', actual: '' },
    { eventName: 'Crude Oil Inventories' },
    { eventName: '10-y Bond Auction', actual: '4.2|2.5' },
    { eventName: 'Unknown <indicator> & report' },
  ]) {
    const message = formatEventMessage(release(values));
    assert.match(message, /Gold : <b>NEUTRAL<\/b>\n$/, values.eventName);
  }
});

test('pre-release warnings show WAIT rather than a directional bias', () => {
  const message = formatEventMessage(release(), { phase: 'pre-release' });
  assert.match(message, /Gold : <b>WAIT<\/b>\n$/);
  const inverse = formatEventMessage(release({ eventName: 'Unemployment Rate' }), { phase: 'pre-release' });
  assert.match(inverse, /Gold : <b>WAIT<\/b>\n$/);
});

test('opposing simultaneous releases override standalone directions', () => {
  const payrolls = release({ eventName: 'Non-Farm Employment Change', actual: '220K', forecast: '180K' });
  const wages = release({ eventName: 'Average Hourly Earnings m/m', actual: '0.2%' });
  for (const ev of [payrolls, wages]) {
    const message = formatEventMessage(ev, { contextEvents: [payrolls, wages] });
    assert.match(message, /Gold : <b>NEUTRAL<\/b>\n$/);
  }
});

test('waits for missing simultaneous US data and reassesses once it arrives', () => {
  const headline = release();
  const core = release({ eventName: 'Core CPI m/m', actual: '--' });
  const waiting = formatEventMessage(headline, { contextEvents: [headline, core] });
  assert.match(waiting, /Gold : <b>WAIT<\/b>\n$/);
  const ready = formatEventMessage(headline, { contextEvents: [headline, { ...core, actual: '0.4%' }] });
  assert.match(ready, /Gold : <b>SHORT<\/b>\n$/);
});

test('other release times do not override the current event', () => {
  const current = release();
  const other = release({ actual: '0.1%', timestamp: current.timestamp - 3600 });
  assert.match(formatEventMessage(current, { contextEvents: [current, other] }), /Gold : <b>SHORT<\/b>\n$/);
});

test('same-time context works across timestamp and Singapore date-text sources', () => {
  const headline = release({ timestamp: Date.parse('2026-09-09T12:30:00Z') / 1000 });
  const core = release({ eventName: 'Core CPI m/m', actual: '0.2%', timestamp: undefined, dateStr: 'WedSep 9', timeText: '8:30pm', year: 2026 });
  for (const ev of [headline, core]) {
    const message = formatEventMessage(ev, { contextEvents: [headline, core] });
    assert.match(message, /Gold : <b>NEUTRAL<\/b>\n$/);
  }
  const textHeadline = { ...headline, timestamp: undefined, dateStr: 'Sep 9', timeText: '20:30', year: 2026 };
  assert.match(formatEventMessage(textHeadline, { contextEvents: [textHeadline, core] }), /Gold : <b>NEUTRAL<\/b>\n$/);
});

test('long release groups keep every event and its footer together within Telegram limits', () => {
  assert.equal(typeof buildEventAlertBatches, 'function');
  const events = Array.from({ length: 15 }, (_, index) => release({ id: String(index), eventName: `CPI m/m (series ${index})` }));
  const heading = '<b>News Released (8:30pm SGT):</b>\n';
  const batches = buildEventAlertBatches(events, { heading, maxLength: 1000 });
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap((batch) => batch.events), events);
  for (const batch of batches) {
    assert.ok(batch.text.length <= 1000);
    assert.ok(batch.text.startsWith(heading));
    assert.equal((batch.text.match(/└ Gold :/g) || []).length, batch.events.length);
    assert.equal((batch.text.match(/<b>/g) || []).length, (batch.text.match(/<\/b>/g) || []).length);
    for (const ev of batch.events) assert.ok(batch.text.includes(ev.eventName));
  }
});

test('filtered or previously delivered same-time events still inform the outlook', () => {
  assert.equal(typeof buildEventAlertBatches, 'function');
  const headline = release();
  const core = release({ eventName: 'Core CPI m/m', actual: '0.2%' });
  const [batch] = buildEventAlertBatches([headline], { heading: 'News Released', contextEvents: [headline, core] });
  assert.match(batch.text, /Gold : <b>NEUTRAL<\/b>\n$/);
  assert.deepEqual(batch.events, [headline]);
});

test('warning batches pass the pre-release phase to every footer', () => {
  assert.equal(typeof buildEventAlertBatches, 'function');
  const events = [release(), release({ eventName: 'Core CPI m/m' })];
  const [batch] = buildEventAlertBatches(events, { heading: '10 Minutes to Release', phase: 'pre-release' });
  assert.equal((batch.text.match(/Gold : <b>WAIT<\/b>/g) || []).length, 2);
  assert.deepEqual(buildEventAlertBatches([], { heading: 'News Released' }), []);
});

test('Gold is still the only final tree line when surprise data is unavailable', () => {
  const message = formatEventMessage(release({ actual: '--' }));
  assert.ok(message.endsWith('├ Prev: 0.2%\n└ Gold : <b>WAIT</b>\n'));
  assert.equal((message.match(/└/g) || []).length, 1);
  assert.doesNotMatch(message, /Surprise:/);
});
