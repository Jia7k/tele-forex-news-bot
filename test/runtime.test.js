const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const moment = require('moment-timezone');
const { config } = require('../src/config');

const indexPath = path.join(__dirname, '../src/index.js');
const localRequire = createRequire(indexPath);
const event = { id: '123', currency: 'USD', eventName: 'CPI m/m', dateStr: 'Wed Sep 9', year: 2026, timeText: '8:30pm', timestamp: 1788957000, impact: 'High', forecast: '0.3%', previous: '0.2%', actual: '' };

function runtime(t, initialEvents = [event]) {
  let now = Date.parse('2026-09-09T12:00:00Z');
  let events = initialEvents;
  let fail = false;
  let block = null;
  let sendBlock = null;
  let state = {};
  let lastFetch = null;
  const sent = [], handlers = {}, intervals = [], jobs = {}, recurring = [];
  const originalNow = moment.now;
  moment.now = () => now;
  t.after(() => { moment.now = originalNow; });
  const fakeConfig = { ...config, rescheduleIntervalMinutes: 30, telegram: { ...config.telegram, mode: 'disabled', polling: false, chatId: '1' } };
  const store = { getQolState: () => structuredClone(state), saveQolState: (value) => { state = structuredClone(value); }, cleanupSentEvents: () => 0,
    getLastFetch: () => lastFetch, setLastFetch: (value) => { lastFetch = value; }, getSentEventCount: () => 0, markSent: () => true };
  const app = { use() {}, get() {}, listen: () => ({ close() {} }) };
  const express = Object.assign(() => app, { json: () => ({}) });
  const schedule = { scheduledJobs: jobs, RecurrenceRule: class {}, gracefulShutdown() {}, scheduleJob: (name, when, task) => {
    if (typeof name !== 'string') { recurring.push({ rule: name, task: when }); return {}; }
    const job = { task, when, cancel: () => { delete jobs[name]; }, nextInvocation: () => when };
    jobs[name] = job; return job;
  } };
  const send = async (text, chatId, options = {}) => {
    if (sendBlock) { const gate = sendBlock; sendBlock = null; await gate; }
    const message = { message_id: sent.length + 1, chat: { id: chatId }, text }; sent.push({ ...message, options }); return [message];
  };
  const telegram = { bot: { on: (name, handler) => { handlers[name] = handler; } }, registerTelegramWebhook: async () => {}, sendTelegramChunks: send,
    sendTelegramMessage: async (...args) => Boolean(await send(...args)), editTelegramMessage: async () => true, editTelegramReplyMarkup: async () => true, answerTelegramCallback: async () => true };
  const module = { exports: {} };
  const FakeDate = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  vm.runInNewContext(fs.readFileSync(indexPath, 'utf8'), { module, exports: module.exports, Date: FakeDate,
    require: (id) => {
      if (id === 'dotenv') return { config() {} };
      if (id === 'express') return express;
      if (id === 'node-schedule') return schedule;
      if (id === './config') return { config: fakeConfig, validateConfig() {}, isAllowedChatId: (id) => String(id) === '1' };
      if (id === './store') return store;
      if (id === './telegram') return telegram;
      if (id === './scraper') return { fetchCalendarSnapshot: async (query) => { if (block) await block;
        return { events: fail ? [] : structuredClone(typeof events === 'function' ? events(query) : events), ok: !fail, error: fail ? 'Cloudflare' : null, fetchedAt: now, source: 'html', authoritative: !fail }; } };
      if (id === './fallback') return { applyFallbackValues: async (rows) => rows };
      return localRequire(id);
    }, process: { on() {}, exit() {} }, console, setTimeout: (fn) => { fn(); }, setInterval: (fn) => { intervals.push(fn); return intervals.length; },
  }, { filename: indexPath });
  return { ...module.exports, jobs, sent, handlers, intervals, recurring, getState: () => state,
    setTime: (value) => { now = value; }, setEvents: (value) => { events = value; }, setFail: (value) => { fail = value; },
    setBlock: (value) => { block = value; }, setSendBlock: (value) => { sendBlock = value; }, setFilters: (value) => { fakeConfig.alertFilters = value; } };
}

test('runtime sends warning then actual result with a reply and callback controls', async (t) => {
  const h = runtime(t);
  await h.ready;
  assert.equal(typeof h.handlers.message, 'function');
  assert.equal(typeof h.handlers.callback_query, 'function');
  await h.jobs['warning-2026-09-09T12:30:00.000Z'].task();
  assert.match(h.sent[0].text, /Minutes to Release/);
  h.setTime(Date.parse('2026-09-09T12:32:00Z'));
  h.setEvents([{ ...event, actual: '0.4%' }]);
  await h.jobs['result-2026-09-09T12:30:00.000Z'].task();
  assert.match(h.sent[1].text, /0.4%/);
  assert.match(h.sent[1].text, /Gold : <b>SHORT/);
  assert.equal(h.sent[1].options.reply_parameters.message_id, h.sent[0].message_id);
  assert.equal(h.sent[1].options.reply_markup.inline_keyboard[0].length, 3);
  assert.equal(h.getHealthPayload().pendingResultCount, 0);
});

test('schedule changes replace reminders and source failures keep existing event jobs', async (t) => {
  const h = runtime(t);
  await h.ready;
  h.setFail(true);
  await h.refreshSchedule();
  assert.ok(h.jobs['warning-2026-09-09T12:30:00.000Z']);
  assert.equal(h.sent.length, 0);
  h.setFail(false);
  h.setEvents([{ ...event, timestamp: event.timestamp + 3600, timeText: '9:30pm' }]);
  await h.refreshSchedule();
  assert.equal(h.jobs['warning-2026-09-09T12:30:00.000Z'], undefined);
  assert.ok(h.jobs['warning-2026-09-09T13:30:00.000Z']);
  assert.match(h.sent[0].text, /Schedule changed/);
  h.setEvents([{ ...event, timeText: 'Cancelled' }]);
  await h.refreshSchedule();
  assert.equal(Object.keys(h.jobs).filter((name) => name.startsWith('warning-')).length, 0);
});

test('a release moved while its result check refreshes is not sent under the old job', async (t) => {
  const h = runtime(t);
  await h.ready;
  h.setTime(Date.parse('2026-09-09T12:32:00Z'));
  h.setEvents([{ ...event, timestamp: event.timestamp + 3600, timeText: '9:30pm', actual: '0.4%' }]);
  await h.jobs['result-2026-09-09T12:30:00.000Z'].task();
  assert.equal(h.sent.length, 0);
});

test('paused runtime holds its daily summary and schedule-change notifications', async (t) => {
  const h = runtime(t);
  await h.ready;
  await h.handlers.message({ chat: { id: '1' }, text: '/pause 1h' });
  const baseline = h.sent.length;
  await h.recurring[0].task();
  assert.equal(h.sent.length, baseline);
  h.setEvents([{ ...event, timeText: '9:30pm', timestamp: event.timestamp + 3600 }]);
  await h.refreshSchedule();
  assert.equal(h.sent.length, baseline);
  await h.handlers.message({ chat: { id: '1' }, text: '/resume' });
  assert.match(h.sent.at(-1).text, /Catch-up/);
  assert.match(h.sent.at(-1).text, /Schedule changed/);
});

test('health reflects calendar request failure and persistent delivery state', async (t) => {
  const h = runtime(t);
  await h.ready;
  h.setFail(true);
  await h.refreshSchedule();
  assert.equal(h.getHealthPayload().lastScrape.ok, false);
  assert.equal(h.getHealthPayload().status, 'degraded');
  h.setFail(false);
  await h.refreshSchedule();
  await h.jobs['warning-2026-09-09T12:30:00.000Z'].task();
  assert.equal(h.getHealthPayload().telegram.lastDelivery.ok, true);
});

test('check refresh replaces a moved reminder immediately, not at the next periodic fetch', async (t) => {
  const h = runtime(t);
  await h.ready;
  h.setEvents([{ ...event, timeText: '9:30pm', timestamp: event.timestamp + 3600 }]);
  await h.handlers.message({ chat: { id: '1' }, text: '/check' });
  assert.equal(h.jobs['warning-2026-09-09T12:30:00.000Z'], undefined);
  assert.ok(h.jobs['warning-2026-09-09T13:30:00.000Z']);
});

test('later date query moving an event across midnight leaves only the new reminder', async (t) => {
  const h = runtime(t);
  await h.ready;
  const moved = { ...event, timestamp: event.timestamp + 14400, dateStr: 'Thu Sep 10', timeText: '12:30am' };
  h.setEvents((query) => query === 'sep10.2026' ? [moved] : []);
  await h.refreshSchedule();
  assert.equal(h.jobs['warning-2026-09-09T12:30:00.000Z'], undefined);
  assert.ok(h.jobs['warning-2026-09-09T16:30:00.000Z']);
});

test('schedule notices and subsequent corrections respect updated alert filters', async (t) => {
  const eur = { ...event, currency: 'EUR', eventName: 'Trade Balance' };
  const h = runtime(t, [eur]);
  await h.ready;
  h.setTime(Date.parse('2026-09-09T12:32:00Z'));
  h.setEvents([{ ...eur, actual: '1B' }]);
  await h.jobs['result-2026-09-09T12:30:00.000Z'].task();
  assert.equal(h.sent.length, 1);
  h.setFilters({ currencies: ['USD'], impacts: [] });
  h.setEvents([{ ...eur, actual: '2B', timestamp: eur.timestamp - 60, timeText: '8:29pm' }]);
  await h.refreshSchedule();
  assert.equal(h.sent.length, 1);
});

test('status commands remain responsive while startup calendar requests are stalled', async (t) => {
  const h = runtime(t);
  let release;
  h.setBlock(new Promise((resolve) => { release = resolve; }));
  await new Promise(setImmediate);
  await h.handlers.message({ chat: { id: '1' }, text: '/status' });
  assert.match(h.sent[0].text, /Bot Status/);
  assert.equal(h.sent[0].options.reply_markup.inline_keyboard[0][0].callback_data, 'status:details');
  h.setBlock(null);
  release();
  await h.ready;
});

test('cancelling a later simultaneous event during an earlier send suppresses its warning', async (t) => {
  const second = { ...event, id: '456', eventName: 'Core CPI m/m' };
  const h = runtime(t, [event, second]);
  await h.ready;
  let unblock;
  h.setSendBlock(new Promise((resolve) => { unblock = resolve; }));
  const warning = h.jobs['warning-2026-09-09T12:30:00.000Z'].task();
  await new Promise(setImmediate);
  h.setEvents([event, { ...second, timeText: 'Cancelled' }]);
  const check = h.handlers.message({ chat: { id: '1' }, text: '/check' });
  await new Promise(setImmediate);
  unblock();
  await Promise.all([warning, check]);
  const warnings = h.sent.filter((message) => message.text.includes('Minutes to Release'));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0].text, /Core CPI/);
});
