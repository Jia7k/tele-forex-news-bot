const { createHash } = require('crypto');
const moment = require('moment-timezone');
const { config } = require('./config');
const { reconcileCalendar } = require('./calendarState');
const { formatEventMessage, formatEventTime, escapeHtml, hasDataValue, parseDateText, getReleaseDedupeId, getEventGoldOutlook } = require('./utils');
const { eventTimeMs, formatSgtTime, buildLateNotice } = require('./qolPresentation');

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const clone = (value) => JSON.parse(JSON.stringify(value));
const normalize = (value) => String(value || '').trim().toLowerCase();
const realId = (ev) => /^\d+$/.test(String(ev.id)) ? String(ev.id) : null;
const eventDay = (ev) => {
  const time = eventTimeMs(ev) || parseDateText(ev.dateStr, ev.year)?.getTime();
  return time ? moment(time).tz(config.targetTz).format('YYYY-MM-DD') : `${ev.year}:${ev.dateStr}`;
};
const occurrenceKey = (ev) => hash(`${normalize(ev.currency)}:${normalize(ev.eventName)}:${eventDay(ev)}`);
const sameOccurrence = (a, b) => {
  if (a.occurrenceId && b.occurrenceId) return a.occurrenceId === b.occurrenceId;
  if (realId(a) && realId(b)) return realId(a) === realId(b);
  return occurrenceKey(a) === occurrenceKey(b) && eventTimeMs(a) === eventTimeMs(b);
};
const isCancelled = (ev) => ev.cancelled === true || /cancelled|canceled/i.test(`${ev.status || ''} ${ev.timeText || ''}`);
const valueSignature = (ev) => JSON.stringify([ev.actual, ev.forecast, ev.previous].map((v) => hasDataValue(v) ? String(v).trim() : ''));

const createQolService = ({ store, send, now = Date.now }) => {
  const state = { chats: {}, records: {}, notices: {}, calendars: {}, changes: [], ...store.getQolState() };
  const locks = new Map();
  const save = () => store.saveQolState(state);
  const prefs = (chatId) => {
    const key = String(chatId);
    state.chats[key] ||= { noise: 'normal', pauseUntil: 0, muted: {}, resumePending: false };
    return state.chats[key];
  };
  const serial = (chatId, operation) => {
    const key = String(chatId);
    const task = (locks.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    locks.set(key, task);
    return task.finally(() => { if (locks.get(key) === task) locks.delete(key); });
  };
  const recordsFor = (ev, chatId) => Object.values(state.records)
    .filter((r) => r.chatId === String(chatId) && sameOccurrence(r.event, ev))
    .sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence);
  const sourceUrl = (ev) => ev.valueSource === 'Trading Economics' ? 'https://tradingeconomics.com/calendar' :
    `https://www.forexfactory.com/calendar?day=${moment(eventDay(ev), 'YYYY-MM-DD', true).isValid() ? moment(eventDay(ev)).format('MMMD.YYYY').toLowerCase() : 'today'}`;
  const keyboard = (record) => ({ inline_keyboard: [[
    { text: 'Why this bias?', callback_data: `why:${record.id}` },
    { text: 'Open source', url: sourceUrl(record.event) },
    { text: prefs(record.chatId).muted[record.key] ? 'Unmute event' : 'Mute this event', callback_data: `mute:${record.id}` },
  ]] });
  const combinedKeyboard = (records) => ({ inline_keyboard: records.map((record) => {
    const row = keyboard(record).inline_keyboard[0];
    if (records.length > 1) row[0].text = `Why: ${record.event.currency} ${record.event.eventName}`.slice(0, 45);
    return row;
  }) });
  const getRecord = (id, chatId) => {
    const record = state.records[id];
    return record && record.chatId === String(chatId) ? clone(record) : null;
  };
  const deliverNotice = (key, text, chatId) => serial(chatId, async () => {
    const id = hash(`${chatId}:${key}`);
    const notice = state.notices[id] ||= { id, text, chatId: String(chatId), createdAt: now(), isNotice: true };
    if (notice.messageId || notice.deferred) return true;
    const settings = prefs(chatId);
    if (settings.pauseUntil > now() || settings.resumePending) {
      notice.deferred = true;
      save(); return true;
    }
    save();
    const message = await send(text, chatId, {});
    settings.lastDelivery = { at: now(), ok: Boolean(message?.message_id) };
    if (message?.message_id) notice.messageId = message.message_id;
    save();
    return Boolean(message?.message_id);
  });
  const deliverEvent = (event, { chatId, phase = 'release', contextEvents = [event], observedAt = now() } = {}) => serial(chatId, async () => {
    const related = recordsFor(event, chatId);
    const key = related[0]?.key || event.occurrenceId || hash(`${occurrenceKey(event)}:${realId(event) || eventTimeMs(event)}`);
    const signature = phase === 'pre-release' ? String(eventTimeMs(event)) : valueSignature(event);
    const latest = related.find((r) => r.phase === phase);
    const latestSignature = latest && (phase === 'pre-release' ? String(eventTimeMs(latest.event)) : valueSignature(latest.event));
    const id = latestSignature === signature ? latest.id : hash(`${chatId}:${key}:${phase}:${signature}:${latest?.id || ''}`);
    let record = state.records[id];
    if (record?.messageId || record?.legacyDelivered) return { accepted: true, delivered: true };
    if (record?.deferred) return { accepted: true, delivered: false };
    const priorResult = related.find((r) => r.phase === 'release' && (r.messageId || r.legacyDelivered));
    const priorWarning = related.find((r) => r.phase === 'pre-release' && r.messageId);
    if (!record) {
      record = state.records[id] = clone({ id, key, chatId: String(chatId), event, contextEvents, phase,
        outlook: getEventGoldOutlook(event, { phase, contextEvents }),
        body: formatEventMessage(event, { phase, contextEvents }),
        observedAt, createdAt: now(), sequence: Object.keys(state.records).length,
        correction: phase === 'release' && Boolean(priorResult), priorEvent: priorResult?.event || null,
        replyTo: phase === 'release' ? (priorResult?.messageId || priorWarning?.messageId || null) : null,
        messageId: null, deferred: false });
    }
    if (phase === 'release' && !latest && store.hasSent?.(getReleaseDedupeId(event))) {
      record.legacyDelivered = true;
      save();
      return { accepted: true, delivered: true };
    }
    const settings = prefs(chatId);
    if (settings.pauseUntil > now() || settings.resumePending) {
      record.deferred = true;
      save();
      return { accepted: true, delivered: false };
    }
    save();
    const title = phase === 'pre-release' ? `${config.warningMinutes} Minutes to Release` : record.correction ? 'Correction' : 'News Released';
    const late = phase === 'release' ? buildLateNotice(event, { now: now(), observedAt: record.observedAt }) : '';
    const previous = record.correction ? `Previously reported: Act ${escapeHtml(record.priorEvent.actual || '--')}; Prev ${escapeHtml(record.priorEvent.previous || '--')}\n` : '';
    const text = `<b>${title} (${escapeHtml(formatEventTime(event))}):</b>\n${late ? `${late}\n` : ''}${previous}${record.body || formatEventMessage(event, { phase, contextEvents: record.contextEvents })}`;
    const options = {
      disable_notification: Boolean(settings.muted[key]) || (settings.noise === 'low' && ['Low', 'Non-Economic'].includes(event.impact)),
      reply_markup: keyboard(record),
      ...(record.replyTo ? { reply_parameters: { message_id: record.replyTo, allow_sending_without_reply: true } } : {}),
    };
    const message = await send(text, chatId, options);
    settings.lastDelivery = { at: now(), ok: Boolean(message?.message_id) };
    if (!message?.message_id) { save(); return { accepted: false, delivered: false }; }
    record.messageId = message.message_id;
    record.deliveredAt = now();
    save();
    return { accepted: true, delivered: true };
  });

  const flushChat = (chatId, force = false) => serial(chatId, async () => {
    const settings = prefs(chatId);
    if (!force && settings.pauseUntil > now()) return false;
    const deferred = [...Object.values(state.records), ...Object.values(state.notices)].filter((r) => r.chatId === String(chatId) && r.deferred);
    if (!settings.resumePending && deferred.length === 0) return true;
    settings.pauseUntil = 0;
    settings.resumePending = true;
    save();
    const supersededWarnings = deferred.filter((r) => r.phase === 'pre-release' && deferred.some((result) => result.phase === 'release' && result.key === r.key));
    let queued = deferred.filter((r) => !supersededWarnings.includes(r));
    if (queued.length === 0) {
      const message = await send('<b>Alerts resumed</b>\nNo alerts were held during your pause.', chatId, {});
      if (!message?.message_id) return false;
    }
    while (queued.length) {
      let text = `<b>Catch-up: alerts resumed</b>\n${escapeHtml(formatSgtTime(now(), now()))}\n`;
      const batch = [];
      const silent = (record) => !record.isNotice && (Boolean(settings.muted[record.key]) ||
        (settings.noise === 'low' && ['Low', 'Non-Economic'].includes(record.event.impact)));
      for (const record of queued) {
        if (batch.length && (batch.length >= 8 || silent(record) !== silent(batch[0]))) break;
        const ev = record.event;
        const line = record.isNotice ? `\n${record.text}\n` :
          `\n${formatSgtTime(eventTimeMs(ev), now())}\n${record.phase === 'pre-release' ? 'Reminder held during pause' : buildLateNotice(ev, { now: now(), observedAt: record.observedAt })}\n${record.correction ? 'Correction\n' : ''}${record.body || formatEventMessage(ev, { phase: record.phase, contextEvents: record.contextEvents })}`;
        if (batch.length && text.length + line.length > 3400) break;
        batch.push(record);
        text += line;
      }
      const controls = batch.filter((record) => !record.isNotice);
      const message = await send(text, chatId, {
        disable_notification: silent(batch[0]),
        ...(controls.length ? { reply_markup: combinedKeyboard(controls) } : {}),
      });
      settings.lastDelivery = { at: now(), ok: Boolean(message?.message_id) };
      if (!message?.message_id) { save(); return false; }
      for (const record of batch) {
        record.deferred = false;
        record.messageId = message.message_id;
        record.deliveredAt = now();
        for (const warning of supersededWarnings.filter((w) => w.key === record.key)) {
          warning.deferred = false;
          warning.messageId = message.message_id;
          warning.deliveredAt = now();
        }
      }
      save();
      queued = queued.slice(batch.length);
    }
    settings.resumePending = false;
    save();
    return true;
  });

  const observeCalendar = (query, snapshot) => {
    const result = reconcileCalendar(state.calendars, query, snapshot, { now, sameOccurrence, occurrenceKey });
    state.calendars = result.calendars;
    for (const change of result.changes) {
      if (!state.changes.some((c) => c.id === change.id)) state.changes.push(change);
    }
    save();
    return result.changes;
  };

  return {
    deliverEvent, deliverNotice, getRecord, observeCalendar,
    getCalendar: (query) => state.calendars[query] ? clone(state.calendars[query]) : null,
    getCalendars: () => clone(state.calendars),
    getPreferences: (chatId) => clone(prefs(chatId)),
    getDeferredCount: (chatId) => [...Object.values(state.records), ...Object.values(state.notices)].filter((r) => r.chatId === String(chatId) && r.deferred).length,
    getRecords: () => clone(Object.values(state.records)),
    getChanges: () => clone(state.changes.filter((c) => !c.delivered)),
    markChangeDelivered: (id) => { const change = state.changes.find((c) => c.id === id); if (change) { change.delivered = true; save(); } },
    pause: (chatId, duration) => {
      const match = /^(\d+)(m|h)$/i.exec(String(duration));
      const ms = match ? Number(match[1]) * (match[2].toLowerCase() === 'h' ? 3600000 : 60000) : 0;
      if (ms < 60000 || ms > 86400000) throw new Error('Use /pause 1h or /pause 30m (1 minute to 24 hours).');
      Object.assign(prefs(chatId), { pauseUntil: now() + ms, resumePending: true });
      save();
      return prefs(chatId).pauseUntil;
    },
    resume: (chatId) => flushChat(chatId, true),
    flushDue: async () => { for (const chatId of Object.keys(state.chats)) await flushChat(chatId); },
    setNoise: (chatId, mode) => {
      if (!['normal', 'low'].includes(mode)) throw new Error('Use /noise low or /noise normal.');
      prefs(chatId).noise = mode; save();
    },
    toggleMute: (id, chatId) => {
      const record = getRecord(id, chatId);
      if (!record) return null;
      const settings = prefs(chatId);
      settings.muted[record.key] = !settings.muted[record.key];
      save();
      return settings.muted[record.key];
    },
    keyboardFor: (id, chatId) => {
      const record = getRecord(id, chatId);
      if (!record) return null;
      if (!record.messageId) return keyboard(record);
      const shared = Object.values(state.records).filter((r) => r.chatId === String(chatId) && r.messageId === record.messageId);
      const controls = shared.filter((r) => r.phase !== 'pre-release' || !shared.some((result) => result.phase === 'release' && result.key === r.key));
      return combinedKeyboard(controls);
    },
    cleanup: () => {
      const cutoff = now() - 14 * 86400000;
      for (const [id, record] of Object.entries(state.records)) if (!record.deferred && record.createdAt < cutoff) delete state.records[id];
      for (const [id, notice] of Object.entries(state.notices)) if (!notice.deferred && notice.createdAt < cutoff) delete state.notices[id];
      for (const [query, calendar] of Object.entries(state.calendars)) if (calendar.fetchedAt < cutoff) delete state.calendars[query];
      state.changes = state.changes.filter((change) => !change.delivered || change.at >= cutoff);
      save();
    },
  };
};

module.exports = { createQolService, occurrenceKey, sameOccurrence, isCancelled };
