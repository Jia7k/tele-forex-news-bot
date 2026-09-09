const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const dotenv = mock.method(require('dotenv'), 'config', () => ({}));
const { sameOccurrence, occurrenceKey } = require('../src/qolService');
const { reconcileCalendar } = require('../src/calendarState');
dotenv.mock.restore();

const base = {
  id: '123', currency: 'USD', eventName: 'CPI m/m', dateStr: 'Wed Sep 9', year: 2026,
  timeText: '8:30pm', timestamp: 1788957000, impact: 'High',
  actual: '', forecast: '0.3%', previous: '0.2%',
};
const reconcile = (calendars, query, events, extra = {}, now = 1000) => reconcileCalendar(
  calendars, query, { ok: true, events, fetchedAt: now, ...extra },
  { now: () => now, sameOccurrence, occurrenceKey }
);

test('an older request completing later cannot roll back actual values across query caches', () => {
  const first = reconcile({}, 'sep9.2026', [{ ...base, actual: '0.5%' }], { requestStartedAt: 200 }, 300);
  const result = reconcile(first.calendars, 'sep10.2026', [{ ...base, actual: '0.4%' }], { requestStartedAt: 100 }, 400);
  assert.equal(result.calendars['sep9.2026'].events[0].actual, '0.5%');
  assert.equal(result.calendars['sep10.2026'].events[0].actual, '0.5%');
  assert.equal(result.calendars['sep10.2026'].events[0].observedAt, 300);
  assert.deepEqual(result.changes, []);
});

test('mixed stale feed and moved native HTML reconcile to one occurrence and one move', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const moved = { ...base, timestamp: base.timestamp + 3600, timeText: '9:30pm' };
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, id: 'feed:old' }, moved], { source: 'html+public-feed' }, 2000);
  assert.equal(result.calendars['sep9.2026'].events.length, 1);
  const event = result.calendars['sep9.2026'].events[0];
  assert.equal(event.id, '123');
  assert.equal(event.timestamp, 1788960600);
  assert.equal(event.occurrenceId, first.calendars['sep9.2026'].events[0].occurrenceId);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'moved');
  assert.equal(result.changes[0].previous.timestamp, 1788957000);
  assert.equal(result.changes[0].event.timestamp, 1788960600);
});

test('fetchedAt orders legacy snapshots when requestStartedAt is absent', () => {
  const first = reconcile({}, 'sep9.2026', [{ ...base, actual: '0.5%' }], {}, 300);
  const result = reconcile(first.calendars, 'sep10.2026', [{ ...base, actual: '0.4%' }], { fetchedAt: 200 }, 400);
  assert.equal(result.calendars['sep10.2026'].events[0].actual, '0.5%');
  assert.equal(result.calendars['sep10.2026'].events[0].observedAt, 300);
});

test('an older request still contributes unrelated events without overwriting newer ones', () => {
  const first = reconcile({}, 'sep9.2026', [{ ...base, actual: '0.5%' }], { requestStartedAt: 200 }, 300);
  const result = reconcile(first.calendars, 'sep9.2026', [
    { ...base, actual: '0.4%' }, { ...base, id: '456', eventName: 'PPI m/m', actual: '0.1%' },
  ], { requestStartedAt: 100 }, 400);
  assert.equal(result.calendars['sep9.2026'].fetchedAt, 300);
  assert.deepEqual(result.calendars['sep9.2026'].events.map((event) => event.actual), ['0.5%', '0.1%']);
});

test('retained rows keep their own request version rather than inheriting a newer query version', () => {
  const first = reconcile({}, 'sep9.2026', [{ ...base, actual: '0.4%' }], { requestStartedAt: 100 }, 150);
  const second = reconcile(first.calendars, 'sep9.2026', [{ ...base, id: '456', eventName: 'PPI m/m' }], { requestStartedAt: 300 }, 350);
  assert.equal(second.calendars['sep9.2026'].partial, true);
  assert.equal(second.calendars['sep9.2026'].retainedEventCount, 1);
  const result = reconcile(second.calendars, 'sep10.2026', [{ ...base, actual: '0.5%' }], { requestStartedAt: 200 }, 400);
  assert.equal(result.calendars['sep9.2026'].events[0].actual, '0.5%');
});

test('a public feed update keeps the native ID, values and immutable observation time', () => {
  const first = reconcile({}, 'sep9.2026', [{ ...base, actual: '0.4%', previous: '0.1%' }]);
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, id: 'feed:cpi' }], { source: 'public-feed' }, 2000);
  const event = result.calendars['sep9.2026'].events[0];
  assert.equal(event.id, '123');
  assert.equal(event.actual, '0.4%');
  assert.equal(event.previous, '0.1%');
  assert.equal(event.observedAt, 1000);
  assert.equal(event.occurrenceId, first.calendars['sep9.2026'].events[0].occurrenceId);
});

test('numeric IDs moved across midnight update every previously cached copy', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const second = reconcile(first.calendars, 'sep8.2026', [base], {}, 2000);
  const moved = { ...base, timestamp: base.timestamp + 86400, dateStr: 'Thu Sep 10' };
  const result = reconcile(second.calendars, 'sep10.2026', [moved], {}, 3000);
  for (const calendar of Object.values(result.calendars)) {
    assert.equal(calendar.events.length, 1);
    assert.equal(calendar.events[0].timestamp, 1789043400);
    assert.equal(calendar.events[0].occurrenceId, first.calendars['sep9.2026'].events[0].occurrenceId);
  }
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, 'moved');
  const repeat = reconcile(result.calendars, 'sep10.2026', [moved], {}, 4000);
  assert.deepEqual(repeat.changes, []);
});

test('failed snapshots retain rows and last-good fetchedAt without emitting schedule changes', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, timeText: 'Cancelled' }], { ok: false, error: 'Cloudflare' }, 2000);
  assert.deepEqual(result.calendars['sep9.2026'].events, first.calendars['sep9.2026'].events);
  assert.equal(result.calendars['sep9.2026'].fetchedAt, 1000);
  assert.equal(result.calendars['sep9.2026'].ok, false);
  assert.equal(result.calendars['sep9.2026'].stale, true);
  assert.deepEqual(result.changes, []);
  const empty = reconcile({}, 'sep9.2026', [], { ok: false }, 1000);
  assert.equal(empty.calendars['sep9.2026'].fetchedAt, null);
});

test('an older failed request does not invalidate a newer successful query', () => {
  const first = reconcile({}, 'sep9.2026', [base], { requestStartedAt: 200 }, 300);
  const result = reconcile(first.calendars, 'sep9.2026', [], { ok: false, requestStartedAt: 100 }, 400);
  assert.deepEqual(result.calendars, first.calendars);
});

test('a late successful response cannot clear the unavailable status of a newer failed request', () => {
  const first = reconcile({}, 'sep9.2026', [base], { requestStartedAt: 100 }, 150);
  const failed = reconcile(first.calendars, 'sep9.2026', [], { ok: false, requestStartedAt: 300 }, 350);
  const result = reconcile(failed.calendars, 'sep9.2026', [base], { requestStartedAt: 200 }, 400);
  assert.equal(result.calendars['sep9.2026'].ok, false);
  assert.equal(result.calendars['sep9.2026'].stale, true);
});

test('missing rows are retained and disclosed even on an otherwise successful complete response', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const result = reconcile(first.calendars, 'sep9.2026', [], {}, 2000);
  assert.equal(result.calendars['sep9.2026'].events.length, 1);
  assert.equal(result.calendars['sep9.2026'].retainedEventCount, 1);
  assert.equal(result.calendars['sep9.2026'].partial, true);
  assert.equal(result.calendars['sep9.2026'].stale, true);
  assert.deepEqual(result.changes, []);
  const complete = reconcile(result.calendars, 'sep9.2026', [base], {}, 3000);
  assert.equal(complete.calendars['sep9.2026'].retainedEventCount, 0);
  assert.equal(complete.calendars['sep9.2026'].partial, false);
});

test('explicit tentative and cancelled updates emit the complete change contract once', () => {
  let result = reconcile({}, 'sep9.2026', [base]);
  for (const [kind, update] of [['tentative', { tentative: true }], ['cancelled', { canceled: true }]]) {
    result = reconcile(result.calendars, 'sep9.2026', [{ ...base, ...update }], {}, 2000);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].kind, kind);
    assert.equal(result.changes[0].at, 2000);
    assert.match(result.changes[0].id, /^[a-f0-9]{24}$/);
    assert.deepEqual(result.changes[0].event, result.calendars['sep9.2026'].events[0]);
    const repeated = reconcile(result.calendars, 'sep9.2026', [{ ...base, ...update }], {}, 2001);
    assert.deepEqual(repeated.changes, []);
  }
});

test('a move with newly released values exposes the final observation time in the change record', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, timestamp: base.timestamp + 3600, actual: 0 }], {}, 2000);
  assert.equal(result.changes[0].event.observedAt, 2000);
  assert.deepEqual(result.changes[0].event, result.calendars['sep9.2026'].events[0]);
});

test('observation time changes for actual, forecast and previous corrections but not metadata or placeholders', () => {
  let result = reconcile({}, 'sep9.2026', [{ ...base, actual: 0 }]);
  const stableId = result.calendars['sep9.2026'].events[0].occurrenceId;
  for (const [field, value, at] of [['actual', '0.1%', 2000], ['forecast', '0.4%', 3000], ['previous', 0, 4000]]) {
    const event = { ...result.calendars['sep9.2026'].events[0], [field]: value };
    result = reconcile(result.calendars, 'sep9.2026', [event], {}, at);
    assert.equal(result.calendars['sep9.2026'].events[0].observedAt, at);
    assert.equal(result.calendars['sep9.2026'].events[0].occurrenceId, stableId);
  }
  const event = { ...result.calendars['sep9.2026'].events[0], actual: '--', forecast: '', previous: '-', impact: 'Low' };
  result = reconcile(result.calendars, 'sep9.2026', [event], {}, 5000);
  assert.equal(result.calendars['sep9.2026'].events[0].observedAt, 4000);
  assert.equal(result.calendars['sep9.2026'].events[0].actual, '0.1%');
  assert.equal(result.calendars['sep9.2026'].events[0].previous, 0);
});

test('ambiguous feed rows cannot replace multiple distinct native IDs at the same time', () => {
  const first = reconcile({}, 'sep9.2026', [base, { ...base, id: '456' }]);
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, id: 'feed:ambiguous' }], {}, 2000);
  assert.deepEqual(result.calendars['sep9.2026'].events.map((event) => event.id), ['123', '456', 'feed:ambiguous']);
  assert.equal(new Set(result.calendars['sep9.2026'].events.map((event) => event.occurrenceId)).size, 3);
  assert.deepEqual(result.changes, []);
});

test('ambiguous repeated feed names remain separate rather than guessing a move', () => {
  const first = reconcile({}, 'sep9.2026', [
    { ...base, id: 'feed:first' }, { ...base, id: 'feed:second', timestamp: base.timestamp + 3600, timeText: '9:30pm' },
  ]);
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, id: 'feed:third', timestamp: base.timestamp + 7200, timeText: '10:30pm' }], {}, 2000);
  assert.equal(result.calendars['sep9.2026'].events.length, 3);
  assert.deepEqual(result.changes, []);
  assert.equal(result.calendars['sep9.2026'].retainedEventCount, 2);
});

test('reconciliation never mutates its inputs or shares change-event objects with returned caches', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const saved = structuredClone(first.calendars);
  const snapshot = { ok: true, fetchedAt: 2000, events: [{ ...base, timeText: '9:30pm', timestamp: base.timestamp + 3600 }] };
  const original = structuredClone(snapshot);
  const result = reconcileCalendar(first.calendars, 'sep9.2026', snapshot, { now: 2000, sameOccurrence, occurrenceKey });
  assert.deepEqual(first.calendars, saved);
  assert.deepEqual(snapshot, original);
  result.changes[0].event.actual = 'different';
  assert.equal(result.calendars['sep9.2026'].events[0].actual, '');
});

test('mixed native and stale feed reconciliation is independent of row order', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const moved = { ...base, timestamp: base.timestamp + 3600, timeText: '9:30pm', actual: '0.5%' };
  for (const events of [[moved, { ...base, id: 'feed:old' }], [{ ...base, id: 'feed:old' }, moved]]) {
    const result = reconcile(first.calendars, 'sep9.2026', events, {}, 2000);
    assert.equal(result.calendars['sep9.2026'].events.length, 1);
    assert.equal(result.calendars['sep9.2026'].events[0].actual, '0.5%');
    assert.equal(result.changes.length, 1);
  }
});

test('native values win over a feed row when request timestamps tie', () => {
  const first = reconcile({}, 'sep9.2026', [{ ...base, actual: '0.5%' }], { requestStartedAt: 100 }, 200);
  const result = reconcile(first.calendars, 'sep10.2026', [{ ...base, id: 'feed:old', actual: '0.4%' }], { requestStartedAt: 100 }, 300);
  assert.equal(result.calendars['sep10.2026'].events[0].id, '123');
  assert.equal(result.calendars['sep10.2026'].events[0].actual, '0.5%');
  assert.equal(result.calendars['sep10.2026'].events[0].observedAt, 200);
});

test('stale responses cannot revive a cancellation or reverse a move', () => {
  for (const update of [{ timeText: 'Cancelled' }, { timestamp: base.timestamp + 86400, dateStr: 'Thu Sep 10' }]) {
    const first = reconcile({}, 'sep9.2026', [base], { requestStartedAt: 100 }, 200);
    const second = reconcile(first.calendars, 'sep10.2026', [{ ...base, ...update }], { requestStartedAt: 300 }, 400);
    const result = reconcile(second.calendars, 'sep9.2026', [base], { requestStartedAt: 200 }, 500);
    assert.deepEqual(result.calendars['sep9.2026'].events[0], second.calendars['sep10.2026'].events[0]);
    assert.deepEqual(result.changes, []);
  }
});

test('previously duplicated copies of one occurrence converge without dropping distinct native IDs', () => {
  const first = reconcile({}, 'sep9.2026', [base, { ...base, id: '456' }]);
  const event = first.calendars['sep9.2026'].events[0];
  first.calendars['sep9.2026'].events.push({ ...event, id: 'feed:old' });
  first.calendars['sep8.2026'] = structuredClone(first.calendars['sep9.2026']);
  const result = reconcile(first.calendars, 'sep9.2026', [{ ...base, timestamp: base.timestamp + 3600, timeText: '9:30pm' }], {}, 2000);
  for (const calendar of Object.values(result.calendars)) {
    assert.deepEqual(calendar.events.map((row) => row.id), ['123', '456']);
    assert.equal(calendar.events[0].timestamp, 1788960600);
  }
});

test('partial source metadata remains partial even when every old row was refreshed', () => {
  const first = reconcile({}, 'sep9.2026', [base]);
  const result = reconcile(first.calendars, 'sep9.2026', [base], { partial: true, source: 'html', authoritative: false }, 2000);
  assert.equal(result.calendars['sep9.2026'].retainedEventCount, 0);
  assert.equal(result.calendars['sep9.2026'].partial, true);
  assert.equal(result.calendars['sep9.2026'].stale, true);
  assert.equal(result.calendars['sep9.2026'].source, 'html');
});
