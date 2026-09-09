const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarGateway } = require('../src/calendarGateway');

test('concurrent refreshes share a request and stale data is retained on failure', async () => {
  let calls = 0;
  let resolve;
  let snapshot;
  const gateway = createCalendarGateway({
    fetchSnapshot: () => { calls++; return new Promise((r) => { resolve = r; }); },
    qol: {
      getCalendar: () => snapshot,
      observeCalendar: (query, result) => { snapshot = result.ok ? result : { ...snapshot, ok: false, stale: true, error: result.error }; },
    },
  });
  const a = gateway.refresh('sep9.2026');
  const b = gateway.refresh('sep9.2026');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ ok: true, events: [{ eventName: 'CPI' }], fetchedAt: 1 });
  assert.equal((await a).events.length, 1);
  assert.equal((await b).events.length, 1);
  const failed = gateway.refresh('sep9.2026');
  await Promise.resolve();
  resolve({ ok: false, events: [], error: 'Cloudflare' });
  const result = await failed;
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.events[0].eventName, 'CPI');
});

test('a rejected source request clears the in-flight lock and reports failure', async () => {
  let calls = 0;
  const gateway = createCalendarGateway({ fetchSnapshot: async () => { calls++; throw new Error('offline'); }, qol: { observeCalendar() {}, getCalendar: () => null } });
  assert.equal((await gateway.refresh('today')).ok, false);
  assert.equal((await gateway.refresh('today')).ok, false);
  assert.equal(calls, 2);
});

test('gateway does not label rejected older metadata as a fresh successful refresh', async () => {
  const gateway = createCalendarGateway({ fetchSnapshot: async () => ({ ok: true, fetchedAt: 100, events: [] }),
    qol: { observeCalendar() {}, getCalendar: () => ({ ok: false, stale: true, fetchedAt: 200, error: 'newer request failed', events: [{ eventName: 'CPI' }] }) } });
  const result = await gateway.refresh('sep9.2026');
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
  assert.equal(result.error, 'newer request failed');
});
