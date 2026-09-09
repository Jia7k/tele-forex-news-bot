const test = require('node:test');
const assert = require('node:assert/strict');
const { createQolService } = require('../src/qolService');

const base = { id: 'feed:cpi', currency: 'USD', eventName: 'CPI m/m', dateStr: 'Wed Sep 9', year: 2026, timeText: '8:30pm', timestamp: 1788957000, impact: 'High', forecast: '0.3%', previous: '0.2%', actual: '' };
function setup(saved) {
  let time = Date.parse('2026-09-09T12:32:00Z');
  let state = saved || {};
  const sent = [];
  const store = { getQolState: () => structuredClone(state), saveQolState: (s) => { state = structuredClone(s); } };
  let fail = false;
  const service = createQolService({ store, now: () => time, send: async (text, chat, options) => {
    if (fail) return null;
    const message = { message_id: sent.length + 1, chat: { id: chat } };
    sent.push({ text, chat, options, ...message });
    return message;
  } });
  return { service, sent, store, setTime: (t) => { time = t; }, fail: (v) => { fail = v; } };
}

test('results reply to their warning; corrections reply to result; duplicate retries send nothing', async () => {
  const { service, sent } = setup();
  await service.deliverEvent(base, { chatId: '1', phase: 'pre-release', contextEvents: [base] });
  const released = { ...base, id: '123', actual: '0.4%' };
  await service.deliverEvent(released, { chatId: '1', contextEvents: [released] });
  assert.equal(sent[1].options.reply_parameters.message_id, 1);
  await service.deliverEvent(released, { chatId: '1' });
  assert.equal(sent.length, 2);
  await service.deliverEvent({ ...released, actual: '0.5%' }, { chatId: '1' });
  assert.equal(sent[2].options.reply_parameters.message_id, 2);
  assert.match(sent[2].text, /Correction/);
  assert.match(sent[2].text, /0.4%/);
});

test('saved explanations are immutable and scoped to the chat and exact alert', async () => {
  const { service, sent } = setup();
  const released = { ...base, actual: '0.4%' };
  await service.deliverEvent(released, { chatId: '1', contextEvents: [released] });
  const data = sent[0].options.reply_markup.inline_keyboard[0][0].callback_data;
  const id = data.split(':')[1];
  released.actual = '0.1%';
  assert.equal(service.getRecord(id, '1').event.actual, '0.4%');
  assert.equal(service.getRecord(id, '2'), null);
  assert.ok(Buffer.byteLength(data) <= 64);
});

test('pauses survive restart and failed catchup remains queued until successfully sent', async () => {
  const h = setup();
  const until = h.service.pause('1', '1h');
  assert.equal(until, Date.parse('2026-09-09T13:32:00Z'));
  const result = await h.service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' });
  assert.equal(result.accepted, true);
  assert.equal(result.delivered, false);
  assert.equal(h.sent.length, 0);
  const next = setup(h.store.getQolState());
  next.setTime(until + 1);
  next.fail(true);
  await next.service.flushDue();
  assert.equal(next.service.getDeferredCount('1'), 1);
  next.fail(false);
  await next.service.flushDue();
  assert.equal(next.service.getDeferredCount('1'), 0);
  assert.match(next.sent[0].text, /Catch-up/);
  assert.match(next.sent[0].text, /0.4%/);
  await next.service.flushDue();
  assert.equal(next.sent.length, 1);
});

test('silent low-impact mode and per-event mute preserve event delivery', async () => {
  const { service, sent } = setup();
  service.setNoise('1', 'low');
  await service.deliverEvent({ ...base, impact: 'Low', actual: '0.4%' }, { chatId: '1' });
  assert.equal(sent[0].options.disable_notification, true);
  const id = sent[0].options.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
  assert.equal(service.toggleMute(id, '1'), true);
  await service.deliverEvent({ ...base, actual: '0.5%' }, { chatId: '1' });
  assert.equal(sent[1].options.disable_notification, true);
  assert.equal(service.toggleMute(id, '2'), null);
  assert.throws(() => service.pause('1', 'forever'));
  assert.throws(() => service.pause('1', '25h'));
});

test('failed sends remain retryable and overlapping deliveries are serialized', async () => {
  const h = setup();
  h.fail(true);
  assert.equal((await h.service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' })).accepted, false);
  h.fail(false);
  await Promise.all([
    h.service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' }),
    h.service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' }),
  ]);
  assert.equal(h.sent.length, 1);
});

test('calendar changes keep missing rows; explicit changes require a fresh successful snapshot', () => {
  const { service } = setup();
  const initial = { ...base, id: '123' };
  service.observeCalendar('sep9.2026', { events: [initial], ok: true, fetchedAt: 1 });
  assert.deepEqual(service.observeCalendar('sep9.2026', { events: [], ok: false }), []);
  assert.equal(service.getCalendar('sep9.2026').events.length, 1);
  const moved = { ...initial, timestamp: base.timestamp + 3600, timeText: '9:30pm' };
  const changes = service.observeCalendar('sep9.2026', { events: [moved], ok: true, fetchedAt: 2 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'moved');
  assert.equal(service.getCalendar('sep9.2026').events.length, 1);
  service.observeCalendar('sep9.2026', { events: [], ok: true });
  assert.equal(service.getCalendar('sep9.2026').events.length, 1);
  assert.equal(service.getCalendar('sep9.2026').partial, true);
  assert.equal(service.observeCalendar('sep9.2026', { events: [{ ...moved, timeText: 'Tentative' }], ok: true })[0].kind, 'tentative');
  assert.equal(service.observeCalendar('sep9.2026', { events: [{ ...moved, cancelled: true }], ok: true })[0].kind, 'cancelled');
});

test('first failed refresh is persisted as unavailable, and actual observation time survives a feed fallback', () => {
  const { service, setTime } = setup();
  service.observeCalendar('sep9.2026', { ok: false, events: [], error: 'blocked' });
  assert.equal(service.getCalendar('sep9.2026').stale, true);
  const first = Date.parse('2026-09-09T12:32:00Z');
  service.observeCalendar('sep9.2026', { ok: true, events: [{ ...base, actual: '0.4%' }], fetchedAt: first });
  setTime(first + 600000);
  service.observeCalendar('sep9.2026', { ok: true, events: [base], fetchedAt: first + 600000, source: 'public-feed' });
  const event = service.getCalendar('sep9.2026').events[0];
  assert.equal(event.actual, '0.4%');
  assert.equal(event.observedAt, first);
});

test('moving a numeric-id event across midnight updates previously cached copies', () => {
  const { service } = setup();
  service.observeCalendar('sep9.2026', { ok: true, events: [{ ...base, id: '123' }] });
  const moved = { ...base, id: '123', dateStr: 'Thu Sep 10', timestamp: base.timestamp + 86400 };
  const changes = service.observeCalendar('sep10.2026', { ok: true, events: [moved] });
  assert.equal(changes[0].kind, 'moved');
  assert.equal(service.getCalendar('sep9.2026').events[0].timestamp, moved.timestamp);
});

test('pause also holds daily summaries and schedule notices in durable catch-up', async () => {
  const h = setup();
  h.service.pause('1', '1h');
  await h.service.deliverNotice('daily:sep9', '<b>Daily summary</b>\nCPI later', '1');
  await h.service.deliverNotice('move:123', '<b>Schedule changed</b>\nCPI moved', '1');
  assert.equal(h.sent.length, 0);
  await h.service.resume('1');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Daily summary/);
  assert.match(h.sent[0].text, /Schedule changed/);
  await h.service.deliverNotice('move:123', 'Duplicate', '1');
  assert.equal(h.sent.length, 1);
});

test('catch-up combines held warning and result, retains Gold and warns that data is not fresh', async () => {
  const h = setup();
  h.service.pause('1', '1h');
  await h.service.deliverEvent(base, { chatId: '1', phase: 'pre-release' });
  await h.service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' });
  h.setTime(Date.parse('2026-09-09T13:40:00Z'));
  await h.service.flushDue();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text.match(/CPI m\/m/g).length, 1);
  assert.match(h.sent[0].text, /Gold : <b>SHORT/);
  assert.match(h.sent[0].text, /LATE/);
  assert.equal(h.service.getDeferredCount('1'), 0);
});

test('calendar-only fallback cannot manufacture a correction from stale forecast/previous fields', () => {
  const h = setup();
  h.service.observeCalendar('sep9.2026', { ok: true, source: 'html', events: [{ ...base, actual: '0.4%', previous: '0.1%' }] });
  h.service.observeCalendar('sep9.2026', { ok: true, source: 'public-feed', events: [base] });
  assert.equal(h.service.getCalendar('sep9.2026').events[0].previous, '0.1%');
});

test('a correction returning to an earlier actual value still notifies and links the latest result', async () => {
  const h = setup();
  for (const actual of ['0.4%', '0.5%', '0.4%']) {
    await h.service.deliverEvent({ ...base, actual }, { chatId: '1' });
  }
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].options.reply_parameters.message_id, 2);
});

test('distinct source IDs with the same title on one day do not suppress a later occurrence', async () => {
  const h = setup();
  await h.service.deliverEvent({ ...base, id: '101', actual: '0.4%' }, { chatId: '1' });
  await h.service.deliverEvent({ ...base, id: '102', timestamp: base.timestamp + 3600, actual: '0.4%' }, { chatId: '1' });
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].options.reply_parameters, undefined);
});

test('out-of-order snapshots cannot roll newer values back across query caches', () => {
  const h = setup();
  h.service.observeCalendar('sep9.2026', { ok: true, fetchedAt: 200, events: [{ ...base, id: '123', actual: '0.5%' }] });
  h.service.observeCalendar('sep10.2026', { ok: true, fetchedAt: 100, events: [{ ...base, id: '123', actual: '0.4%' }] });
  assert.equal(h.service.getCalendar('sep9.2026').events[0].actual, '0.5%');
  assert.equal(h.service.getCalendar('sep10.2026').events[0].actual, '0.5%');
});

test('HTML native IDs survive calendar-only feed merges and a moved row notifies only once', () => {
  const h = setup();
  h.service.observeCalendar('sep9.2026', { ok: true, events: [{ ...base, id: '123' }] });
  h.service.observeCalendar('sep9.2026', { ok: true, source: 'public-feed', events: [base] });
  assert.equal(h.service.getCalendar('sep9.2026').events[0].id, '123');
  const changes = h.service.observeCalendar('sep9.2026', { ok: true, events: [base, { ...base, id: '123', timestamp: base.timestamp + 3600, timeText: '9:30pm' }] });
  assert.equal(changes.filter((c) => c.kind === 'moved').length, 1);
  assert.equal(h.service.getCalendar('sep9.2026').events.length, 1);
});

test('existing legacy release dedupe suppresses upgrade duplicates but allows later corrections', async () => {
  const h = setup();
  h.store.hasSent = () => true;
  const service = createQolService({ store: h.store, send: async () => { throw new Error('must not send legacy duplicate'); } });
  const result = await service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' });
  assert.equal(result.accepted, true);
  const next = setup(h.store.getQolState());
  await next.service.deliverEvent({ ...base, actual: '0.5%' }, { chatId: '1' });
  assert.equal(next.sent.length, 1);
  assert.match(next.sent[0].text, /Correction/);
});

test('catch-up preserves silent mode and scoped event controls', async () => {
  const h = setup();
  h.service.setNoise('1', 'low');
  h.service.pause('1', '1h');
  await h.service.deliverEvent({ ...base, impact: 'Low', actual: '0.4%' }, { chatId: '1' });
  await h.service.resume('1');
  assert.equal(h.sent[0].options.disable_notification, true);
  const button = h.sent[0].options.reply_markup.inline_keyboard[0][0];
  assert.ok(h.service.getRecord(button.callback_data.split(':')[1], '1'));
});

test('saved alerts retain their computed outlook and link fallback values to the fallback provider', async () => {
  const h = setup();
  await h.service.deliverEvent({ ...base, actual: '0.4%', valueSource: 'Trading Economics' }, { chatId: '1' });
  const controls = h.sent[0].options.reply_markup.inline_keyboard[0];
  const record = h.service.getRecord(controls[0].callback_data.split(':')[1], '1');
  assert.equal(record.outlook.bias, 'short');
  assert.match(controls[1].url, /^https:\/\/tradingeconomics.com\//);
});

test('muting one catch-up event preserves every other event control row', async () => {
  const h = setup();
  h.service.pause('1', '1h');
  await h.service.deliverEvent({ ...base, actual: '0.4%' }, { chatId: '1' });
  await h.service.deliverEvent({ ...base, id: 'other', currency: 'EUR', eventName: 'Trade Balance', actual: '2B' }, { chatId: '1' });
  await h.service.resume('1');
  const rows = h.sent[0].options.reply_markup.inline_keyboard;
  assert.equal(rows.length, 2);
  const id = rows[0][0].callback_data.split(':')[1];
  h.service.toggleMute(id, '1');
  const updated = h.service.keyboardFor(id, '1').inline_keyboard;
  assert.equal(updated.length, 2);
  assert.deepEqual(updated[1], rows[1]);
  assert.equal(updated[0][2].text, 'Unmute event');
});
