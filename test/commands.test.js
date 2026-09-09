const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommandController } = require('../src/commands');

function harness(extra = {}) {
  const sent = [], edited = [], answered = [];
  const controller = createCommandController({
    isAllowed: (id) => String(id) === '1', notificationChatId: '1',
    send: async (text, chatId, options) => { sent.push({ text, chatId, options }); return { message_id: sent.length }; },
    edit: async (text, chatId, id, options) => { edited.push({ text, chatId, id, options }); return true; },
    answer: async (id, options) => { answered.push({ id, options }); return true; },
    editMarkup: async () => true,
    qol: { getPreferences: () => ({}), getCalendars: () => ({}), getRecord: () => null },
    getHealth: () => ({ telegramMode: 'disabled', telegram: {}, scheduledJobs: { nextJobs: [] }, pendingResults: {}, filters: {} }),
    getCheckTarget: () => ({ query: 'sep9.2026', title: '09 Sep' }),
    buildReport: (events) => events.map((ev) => ev.eventName).join('\n') || 'No events',
    gateway: { cached: () => null, refresh: async () => ({ events: [], ok: true }) },
    ...extra,
  });
  return { controller, sent, edited, answered };
}

test('check acknowledges and shows cached calendar before source completes; repeated taps share work', async () => {
  let resolve;
  let calls = 0;
  const h = harness({ gateway: {
    cached: () => ({ events: [{ eventName: 'Cached CPI' }], fetchedAt: 1 }),
    refresh: () => { calls++; return new Promise((r) => { resolve = r; }); },
  } });
  const a = h.controller.onMessage({ chat: { id: 1 }, text: '/check' });
  const b = h.controller.onMessage({ chat: { id: 1 }, text: 'check' });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.match(h.sent[0].text, /Refreshing/);
  assert.match(h.sent[0].text, /Cached CPI/);
  resolve({ ok: true, events: [{ eventName: 'Fresh CPI' }], fetchedAt: Date.now() });
  await Promise.all([a, b]);
  assert.match(h.edited[0].text, /Fresh CPI/);
});

test('unauthorized commands and callbacks cannot change preferences or expose records', async () => {
  const h = harness();
  await h.controller.onMessage({ chat: { id: 2 }, text: '/pause 1h' });
  await h.controller.onCallback({ id: 'x', message: { chat: { id: 2 } }, data: 'why:abc' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.answered.length, 1);
  assert.match(h.answered[0].options.text, /authorized/i);
});

test('expired buttons are acknowledged and never explain another event', async () => {
  const h = harness();
  await h.controller.onCallback({ id: 'x', message: { chat: { id: 1 } }, data: 'why:missing' });
  assert.match(h.answered.at(-1).options.text, /expired/i);
  assert.equal(h.sent.length, 0);
});

test('failed edit falls back to a fresh message and a failed source is not reported as no events', async () => {
  const h = harness({ edit: async () => null, gateway: { cached: () => null, refresh: async () => ({ ok: false, events: [], error: 'blocked' }) } });
  await h.controller.onMessage({ chat: { id: 1 }, text: '/check' });
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /unavailable/i);
  assert.doesNotMatch(h.sent[1].text, /No events/);
});

test('pause and noise controls are restricted to the notification chat even for allowed readers', async () => {
  const h = harness({ isAllowed: () => true });
  await h.controller.onMessage({ chat: { id: 2 }, text: '/noise low' });
  assert.match(h.sent[0].text, /notification chat/i);
});

test('next ignores missing cache timestamps rather than displaying the Unix epoch', async () => {
  const h = harness({ now: () => Date.parse('2026-09-09T12:00:00Z'), qol: { getCalendars: () => ({
    failed: { events: [], fetchedAt: null, stale: true },
    today: { events: [{ currency: 'USD', eventName: 'CPI', timestamp: 1788957000 }], fetchedAt: Date.parse('2026-09-09T11:59:00Z') },
  }) } });
  await h.controller.onMessage({ chat: { id: 1 }, text: '/next' });
  assert.doesNotMatch(h.sent[0].text, /1970/);
  assert.match(h.sent[0].text, /CPI/);
});
