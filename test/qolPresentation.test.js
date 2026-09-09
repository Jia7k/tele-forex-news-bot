const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

test('Why uses the same saved tentative-sibling interpretation as the alert renderer', () => {
  const { formatEventMessage } = require('../src/utils');
  const { buildWhyMessage } = require('../src/qolPresentation');
  const ev = { currency: 'USD', eventName: 'CPI m/m', timeText: '8:30pm', timestamp: 1788957000, actual: '0.4%', forecast: '0.3%' };
  const contextEvents = [ev, { ...ev, eventName: 'Core CPI m/m', timeText: 'Tentative', actual: '' }];
  assert.match(formatEventMessage(ev, { contextEvents }), /Gold : <b>WAIT/);
  assert.match(buildWhyMessage({ event: ev, contextEvents, phase: 'release' }), /Gold: <b>WAIT/);
});

test('status details use the same persistent delivery failure as compact status', () => {
  const { buildDetailedStatus } = require('../src/qolPresentation');
  const message = buildDetailedStatus({ telegramMode: 'polling', notifications: { lastDelivery: { at: '2026-09-09T12:00:00Z', ok: false } } });
  assert.match(message, /Failed \(last send\)/);
  assert.match(message, /Last delivery: 09 Sep 2026 20:00:00 SGT/);
});

test('Why retains the stored interpretation when rules have changed since the alert', () => {
  const { buildWhyMessage } = require('../src/qolPresentation');
  const message = buildWhyMessage({ event: { currency: 'USD', eventName: 'CPI', actual: '0.4%', forecast: '0.3%' },
    outlook: { bias: 'wait', reason: 'Saved simultaneous-data context.', action: 'Wait for the missing release.' } });
  assert.match(message, /Gold: <b>WAIT/);
  assert.match(message, /Saved simultaneous-data context/);
});

// Exercise the real config and utilities without reading local secrets.
const dotenv = mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
const presentation = require('../src/qolPresentation');
dotenv.mock.restore();

const NOW = Date.parse('2026-09-09T12:00:00Z');
const RELEASE = Date.parse('2026-09-09T12:30:00Z');
const event = (overrides = {}) => ({
  currency: 'USD', eventName: 'CPI m/m', impact: 'High',
  dateStr: 'WedSep 9', timeText: '8:30pm', year: 2026,
  actual: '0.4%', forecast: '0.3%', previous: '0.2%',
  ...overrides,
});

test('eventTimeMs normalizes seconds, milliseconds and calendar text without mutation', () => {
  for (const timestamp of [RELEASE / 1000, String(RELEASE / 1000), RELEASE, String(RELEASE)]) {
    const input = Object.freeze(event({ timestamp }));
    assert.equal(presentation.eventTimeMs(input), RELEASE);
  }
  assert.equal(presentation.eventTimeMs(event()), RELEASE);
  assert.equal(presentation.eventTimeMs({ timestamp: RELEASE }), RELEASE);
  assert.equal(presentation.eventTimeMs(event({ timestamp: 0 })), RELEASE);
  assert.equal(presentation.eventTimeMs(event({ timestamp: 'bad', timeText: '20:30' })), RELEASE);
});

test('eventTimeMs rejects untimed and cancelled rows even with a numeric timestamp', () => {
  for (const timeText of ['Tentative', 'All Day', 'All-day', 'Cancelled', 'Canceled']) {
    assert.equal(presentation.eventTimeMs(event({ timestamp: RELEASE, timeText })), null);
  }
  for (const overrides of [{ status: 'cancelled' }, { cancelled: true }, { canceled: true }, { tentative: true }, { allDay: true }]) {
    assert.equal(presentation.eventTimeMs(event({ timestamp: RELEASE, ...overrides })), null);
  }
  for (const input of [null, undefined, {}, event({ year: undefined }), event({ dateStr: 'Feb 30' }), { timestamp: Infinity }]) {
    assert.equal(presentation.eventTimeMs(input), null);
  }
});

test('formatSgtTime includes the date, configured zone and relative time', () => {
  for (const value of [RELEASE, RELEASE / 1000, String(RELEASE), new Date(RELEASE), '2026-09-09T12:30:00Z']) {
    assert.equal(presentation.formatSgtTime(value, NOW), '09 Sep 2026 20:30:00 SGT (in 30m)');
  }
  assert.match(presentation.formatSgtTime(NOW - 90000, NOW), /19:58:30 SGT \(1m 30s ago\)/);
  assert.match(presentation.formatSgtTime(NOW, NOW), /SGT \(now\)/);
  assert.match(presentation.formatSgtTime('2026-12-31T16:01:00Z', Date.parse('2026-12-31T15:59:00Z')), /^01 Jan 2027 00:01:00 SGT \(in 2m\)$/);
});

test('formatSgtTime distinguishes missing values from the valid Unix epoch', () => {
  for (const value of [null, undefined, '', ' ', false, NaN, Infinity, 'invalid', new Date(NaN), '2026-02-30T00:00:00Z']) {
    assert.equal(presentation.formatSgtTime(value, NOW), 'Unknown');
  }
  assert.match(presentation.formatSgtTime(0, NOW), /^01 Jan 1970 07:30:00 SGT /);
  assert.equal(presentation.formatSgtTime(RELEASE, null), '09 Sep 2026 20:30:00 SGT');
});

test('buildNextMessage includes every earliest same-time event regardless of impact', () => {
  const events = Object.freeze([
    Object.freeze(event({ timestamp: RELEASE + 60000, eventName: 'Later' })),
    Object.freeze(event({ timestamp: NOW - 1000, eventName: 'Past' })),
    Object.freeze(event({ timestamp: NOW, eventName: 'At now' })),
    Object.freeze(event({ timestamp: NOW + 1000, eventName: 'Untimed', timeText: 'All Day' })),
    Object.freeze(event({ timestamp: RELEASE / 1000, eventName: 'CPI <flash> & core' })),
    Object.freeze(event({ impact: 'Low', eventName: 'Low impact' })),
    Object.freeze(event({ timestamp: RELEASE, currency: 'EUR', impact: 'Medium', eventName: 'Medium impact' })),
  ]);
  const text = presentation.buildNextMessage(events, { now: NOW, fetchedAt: NOW - 120000, stale: true });
  assert.match(text, /09 Sep 2026 20:30:00 SGT \(in 30m\)/);
  assert.match(text, /CPI &lt;flash&gt; &amp; core/);
  assert.match(text, /Low impact/);
  assert.match(text, /EUR.*Medium impact/);
  assert.match(text, /[Cc]ach/);
  assert.match(text, /2m ago/);
  assert.match(text, /STALE/);
  assert.doesNotMatch(text, /Later|Past|At now|Untimed|<flash>/);
});

test('buildNextMessage handles no future events without inventing a cache age', () => {
  const text = presentation.buildNextMessage([event({ timestamp: NOW - 1 })], { now: NOW });
  assert.match(text, /No upcoming timed events/);
  assert.match(text, /[Cc]ach.*Unknown/);
  assert.doesNotMatch(text, /1970|NaN|Invalid/);
  assert.match(presentation.buildNextMessage([], { now: NOW, fetchedAt: NOW - 60000, stale: true }), /STALE/);
});

test('buildLateNotice treats five minutes as late and shows original and observation times', () => {
  assert.equal(presentation.buildLateNotice(event(), { now: RELEASE + 299999 }), '');
  const text = presentation.buildLateNotice(event(), { now: RELEASE + 300000 });
  assert.match(text, /<b>LATE<\/b>/);
  assert.match(text, /Release: 09 Sep 2026 20:30:00 SGT/);
  assert.match(text, /Observed: 09 Sep 2026 20:35:00 SGT/);
  assert.match(text, /5m ago/);
});

test('buildLateNotice detects delayed delivery without replacing the observation time', () => {
  const text = presentation.buildLateNotice(event(), { now: RELEASE + 600000, observedAt: RELEASE + 60000 });
  assert.match(text, /LATE/);
  assert.match(text, /Observed: 09 Sep 2026 20:31:00 SGT/);
  assert.match(text, /Release: 09 Sep 2026 20:30:00 SGT/);
  assert.equal(presentation.buildLateNotice(event({ timeText: 'Tentative' }), { now: RELEASE + 600000 }), '');
  assert.equal(presentation.buildLateNotice(event(), { now: NOW }), '');
  assert.equal(presentation.buildLateNotice(event(), { now: RELEASE + 600000, lateAfterMs: 900000 }), '');
});

const iso = (time) => new Date(time).toISOString();
const pendingGroup = (overrides = {}) => ({
  groupKey: 'cpi', timeLabel: '8:30pm SGT', updatedAt: iso(NOW - 60000),
  attempt: 1, dateQueries: ['sep9.2026'], nextRetryAt: iso(NOW + 30000),
  pendingEvents: [event({ actual: '', eventName: 'CPI <core> & wages' })],
  ...overrides,
});
const health = (overrides = {}) => ({
  status: 'ok', startedAt: iso(NOW - 3600000), telegramMode: 'polling',
  telegram: {
    mode: 'polling', polling: true, pollingConflict: false, lastPollingError: null,
    lastDelivery: { ok: true, at: iso(NOW - 60000), error: null },
  },
  lastFetch: iso(NOW - 120000),
  lastScrape: { at: iso(NOW - 120000), ok: true, source: 'html', capturedEventCount: 4, expectedEventCount: 4, mismatch: false, error: null },
  lastReleaseCheck: { at: iso(NOW - 60000), groupKey: 'cpi', attempt: 1, pendingEvents: [event()], sentEvents: [], nextRetryAt: iso(NOW + 30000) },
  lastFallbackLookup: { at: iso(NOW - 45000), provider: 'tradingeconomics', ok: false, fetchedCount: 0, matchedCount: 0, error: 'Lookup <failed> & stopped' },
  pendingResults: { cpi: pendingGroup() }, pendingResultCount: 1, scrapeWarningCount: 2,
  scheduledJobs: { managedJobs: 3, warningJobs: 1, resultJobs: 2, totalJobs: 4, nextJobs: [{ name: 'result-<cpi>', nextRunAt: iso(RELEASE) }] },
  lastScheduleRefresh: { at: iso(NOW - 180000), scheduledWarningJobs: 1, scheduledResultJobs: 2, managedJobCount: 3 },
  activeResultChecks: 1, sentEventCount: 9,
  filters: { summary: { currencies: [], impacts: [] }, alerts: { currencies: ['USD', 'EUR'], impacts: ['High', 'Low'] } },
  release: { retryAttempts: 60, retryDelaySeconds: 30, scrapeDelaySeconds: 5, catchupMinutes: 60, sentEventTtlDays: 14 },
  fallback: { provider: 'tradingeconomics', matchWindowMinutes: 180 },
  ...overrides,
});

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

test('buildCompactStatus separates available calendar, pending results and verified delivery', () => {
  const input = deepFreeze(health());
  const text = presentation.buildCompactStatus(input, { now: NOW, prefs: { noise: 'low', pausedUntil: NOW + 3600000 } });
  assert.match(text, /Calendar: Available/);
  assert.match(text, /Pending: 1 group/);
  assert.match(text, /Delivery: Last send succeeded/);
  assert.match(text, /Notifications: Paused until .*21:00:00 SGT \(in 1h\)/);
  assert.match(text, /Noise: low/);
  assert.ok(text.length < 700);
});

test('buildCompactStatus never treats disabled, unknown or failed delivery as healthy', () => {
  const cases = [
    [health({ telegramMode: 'disabled' }), /Delivery: Disabled/],
    [health({ telegramMode: undefined, telegram: {} }), /Delivery: Unknown/],
    [health({ telegram: { mode: 'polling' } }), /Delivery: Unknown/],
    [health({ telegram: { mode: 'polling', lastDelivery: { ok: false, at: iso(NOW), error: '<blocked> & denied' } } }), /Delivery: Failed/],
    [health({ telegram: { mode: 'polling', pollingConflict: true } }), /Delivery:.*polling conflict/i],
    [health({ telegram: { mode: 'polling', lastPollingError: { at: iso(NOW), description: 'Disconnected' } } }), /Delivery:.*polling error/i],
  ];
  for (const [input, expected] of cases) {
    const text = presentation.buildCompactStatus(input, { now: NOW });
    assert.match(text, expected);
    assert.doesNotMatch(text, /healthy|Status: ok|Delivery: (OK|Last send succeeded)/i);
  }
});

test('buildCompactStatus reports failed and unknown calendars independently of delivery', () => {
  const failed = presentation.buildCompactStatus(health({ lastScrape: { ok: false, at: iso(NOW), error: '<offline>' } }), { now: NOW });
  assert.match(failed, /Calendar: Unavailable/);
  assert.match(failed, /cached/i);
  assert.match(failed, /Delivery: Last send succeeded/);
  const partial = presentation.buildCompactStatus(health({ lastScrape: { ok: true, mismatch: true } }), { now: NOW });
  assert.match(partial, /Calendar: Partial/);
  const unknown = presentation.buildCompactStatus({}, { now: NOW });
  assert.match(unknown, /Calendar: Unknown/);
  assert.match(unknown, /Pending: Unknown/);
  assert.match(unknown, /Delivery: Unknown/);
});

test('buildCompactStatus expires pauses and escapes notification preferences', () => {
  const text = presentation.buildCompactStatus(health(), { now: NOW, prefs: { pausedUntil: NOW, noise: '<low> & normal' } });
  assert.match(text, /Notifications: Active/);
  assert.match(text, /Noise: &lt;low&gt; &amp; normal/);
  assert.doesNotMatch(text, /Paused/);
});

test('buildCompactStatus consumes durable service pauseUntil and lastDelivery preferences', () => {
  const text = presentation.buildCompactStatus(health(), { now: NOW, prefs: {
    pauseUntil: NOW + 3600000, noise: 'normal',
    lastDelivery: { at: NOW - 1000, ok: false },
  } });
  assert.match(text, /Notifications: Paused until .*21:00:00 SGT/);
  assert.match(text, /Delivery: Failed/);
});

test('buildCompactStatus does not call queued catch-up delivery active after a pause expires', () => {
  const text = presentation.buildCompactStatus(health(), { now: NOW, prefs: {
    pauseUntil: NOW - 60000, resumePending: true, noise: 'normal',
  } });
  assert.match(text, /Notifications: Catch-up pending/);
  assert.doesNotMatch(text, /Notifications: Active/);
});

test('buildDetailedStatus converts diagnostic ISO times and includes jobs, filters and errors', () => {
  const input = deepFreeze(health({
    telegram: {
      mode: 'polling', lastDelivery: { ok: false, at: iso(NOW - 10000), error: 'Send <failed> & denied' },
      lastPollingError: { at: iso(NOW - 15000), code: 'ETELEGRAM', statusCode: 409, description: 'Conflict <poll>' },
    },
  }));
  const text = presentation.buildDetailedStatus(input, { now: NOW });
  assert.match(text, /Started: 09 Sep 2026 19:00:00 SGT/);
  assert.match(text, /Last fetch: 09 Sep 2026 19:58:00 SGT/);
  assert.match(text, /3 managed/);
  assert.match(text, /result-&lt;cpi&gt;.*20:30:00 SGT/);
  assert.match(text, /Summary filters:.*All/);
  assert.match(text, /Alert filters:.*USD, EUR.*High, Low/);
  assert.match(text, /Conflict &lt;poll&gt;/);
  assert.match(text, /Send &lt;failed&gt; &amp; denied/);
  assert.match(text, /Lookup &lt;failed&gt; &amp; stopped/);
  assert.match(text, /Schedule refreshed: 09 Sep 2026 19:57:00 SGT/);
  assert.match(text, /Last release check:.*19:59:00 SGT/);
  assert.match(text, /Next retry:.*20:00:30 SGT/);
  assert.match(text, /Updated:.*19:59:00 SGT/);
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:\d\d/);
  assert.ok(text.length < 3800);
});

test('buildPendingMessage sorts retries, escapes values and distinguishes unscheduled retries', () => {
  const input = deepFreeze(health({ pendingResults: {
    unscheduled: pendingGroup({ groupKey: 'unscheduled', timeLabel: '<Unscheduled>', nextRetryAt: null }),
    later: pendingGroup({ groupKey: 'later', timeLabel: 'Later', nextRetryAt: iso(NOW + 90000) }),
    first: pendingGroup({ groupKey: 'first', timeLabel: 'First', nextRetryAt: iso(NOW + 30000) }),
  } }));
  const text = presentation.buildPendingMessage(input, { now: NOW });
  assert.ok(text.indexOf('First') < text.indexOf('Later'));
  assert.ok(text.indexOf('Later') < text.indexOf('&lt;Unscheduled&gt;'));
  assert.match(text, /Attempt: 2\/61/);
  assert.match(text, /Next retry: 09 Sep 2026 20:00:30 SGT \(in 30s\)/);
  assert.match(text, /Next retry: Not scheduled/);
  assert.match(text, /CPI &lt;core&gt; &amp; wages/);
  assert.match(text, /Fcst: 0.3%.*Prev: 0.2%/);
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:\d\d/);
});

test('buildPendingMessage distinguishes known empty, missing state and truncated group lists', () => {
  assert.match(presentation.buildPendingMessage({ pendingResults: {} }, { now: NOW }), /No release values are pending/);
  assert.match(presentation.buildPendingMessage({}, { now: NOW }), /unknown/i);
  const groups = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, pendingGroup()]));
  assert.match(presentation.buildPendingMessage({ pendingResults: groups }, { now: NOW }), /Showing 10 of 11/);
});

test('buildWhyMessage preserves immutable mixed-source context and explains conflicting signals', () => {
  const record = deepFreeze({
    event: event({ timestamp: RELEASE / 1000, eventName: 'CPI <flash> & headline' }),
    contextEvents: [event({ actual: '0.2%', eventName: 'Core CPI m/m', impact: 'Low' })],
    phase: 'release', observedAt: RELEASE + 60000,
  });
  const text = presentation.buildWhyMessage(record);
  assert.match(text, /Gold: <b>NEUTRAL<\/b>/);
  assert.match(text, /Same-time US releases give conflicting gold signals/);
  assert.match(text, /CPI &lt;flash&gt; &amp; headline/);
  assert.match(text, /Observed: 09 Sep 2026 20:31:00 SGT/);
  assert.match(text, /[Rr]ules-based/);
  assert.match(text, /not price confirmation/i);
  assert.equal(record.event.timestamp, RELEASE / 1000);
  assert.equal(record.contextEvents[0].timestamp, undefined);
});

test('buildWhyMessage uses the snapshot phase and actual values rather than current time', () => {
  const record = deepFreeze({ event: event({ actual: '<missing>' }), contextEvents: [], phase: 'pre-release', observedAt: NOW });
  const text = presentation.buildWhyMessage(record);
  assert.match(text, /Gold: <b>WAIT<\/b>/);
  assert.match(text, /Above forecast: potential downside/);
  assert.match(text, /Act: &lt;missing&gt;/);
  const clock = mock.method(Date, 'now', () => NOW + 86400000);
  try {
    assert.equal(presentation.buildWhyMessage(record), text);
  } finally {
    clock.mock.restore();
  }
  assert.match(presentation.buildWhyMessage(null), /No saved alert snapshot/);
});

test('buildNextMessage never truncates a large simultaneous release group', () => {
  const events = Array.from({ length: 20 }, (_, index) => event({ eventName: `Release ${index}`, impact: index % 2 ? 'Low' : 'High' }));
  const text = presentation.buildNextMessage(events, { now: NOW });
  assert.equal((text.match(/- USD - Release \d+ /g) || []).length, 20);
});

test('diagnostics also convert ISO timestamps embedded in job labels and errors', () => {
  const text = presentation.buildDetailedStatus(health({
    lastScrape: { ok: false, error: `Fetch failed at ${iso(NOW)} <retry>` },
    scheduledJobs: { nextJobs: [{ name: `result-${iso(RELEASE)}`, nextRunAt: iso(RELEASE) }] },
  }), { now: NOW });
  assert.match(text, /Fetch failed at 09 Sep 2026 20:00:00 SGT \(now\) &lt;retry&gt;/);
  assert.match(text, /result-09 Sep 2026 20:30:00 SGT/);
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:\d\d/);
});

test('all message builders return safe HTML for missing data and hostile content', () => {
  const hostile = '<b>fake</b> & <script>x</script>';
  const messages = [
    presentation.formatSgtTime(NOW + 1, NOW),
    presentation.buildNextMessage([event({ currency: hostile, eventName: hostile, impact: hostile })], { now: NOW }),
    presentation.buildLateNotice(event(), { now: RELEASE + 300000 }),
    presentation.buildCompactStatus(null, { now: NOW }),
    presentation.buildDetailedStatus(null, { now: NOW }),
    presentation.buildPendingMessage(null, { now: NOW }),
    presentation.buildWhyMessage({ event: event({ actual: hostile, forecast: hostile, previous: hostile }), phase: hostile }),
  ];
  assert.match(messages[0], /in &lt;1s/);
  for (const text of messages) {
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text.replace(/<\/?[bi]>/g, ''), /[<>]|&(?!amp;|lt;|gt;)/);
    assert.doesNotMatch(text, /NaN|Invalid date/);
  }
});
