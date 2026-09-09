const { escapeHtml } = require('./utils');
const { buildNextMessage, buildCompactStatus, buildDetailedStatus, buildPendingMessage,
  buildWhyMessage, formatSgtTime } = require('./qolPresentation');

const createCommandController = ({ qol, gateway, send, edit, editMarkup, answer,
  isAllowed, notificationChatId, getHealth, getCheckTarget, buildReport, now = Date.now, onCalendarRefreshed = async () => {} }) => {
  const checks = new Map();
  const statusKeyboard = { inline_keyboard: [[{ text: 'Details', callback_data: 'status:details' }]] };
  const check = (chatId) => {
    const key = String(chatId);
    if (checks.has(key)) return checks.get(key);
    const task = Promise.resolve().then(async () => {
      const target = getCheckTarget();
      const cached = gateway.cached(target.query);
      const acknowledgement = '<b>Refreshing calendar...</b>\n' + (cached ?
        `Cached snapshot: ${escapeHtml(formatSgtTime(cached.fetchedAt, now()))}\n\n${buildReport(cached.events, target)}` : 'Waiting for the data source.');
      const message = await send(acknowledgement, chatId);
      const result = await gateway.refresh(target.query);
      const notice = !result.ok ? '<b>Source unavailable. Showing cached data where available.</b>\n' : result.stale ? '<b>Partial refresh; previously seen events retained.</b>\n' : '';
      const report = !result.ok && result.events.length === 0 ? '<b>Calendar unavailable.</b>\nThe source could not be refreshed; an empty calendar was not confirmed.' : `${notice}Updated: ${escapeHtml(formatSgtTime(result.fetchedAt, now()))}\n\n${buildReport(result.events, target)}`;
      if (!message?.message_id || report.length > 3800 || acknowledgement.length > 3800 || !await edit(report, chatId, message.message_id)) {
        await send(report, chatId);
      }
      await onCalendarRefreshed();
    }).finally(() => checks.delete(key));
    checks.set(key, task);
    return task;
  };
  const onMessage = async (msg) => {
    if (!msg.chat || !isAllowed(msg.chat.id)) return;
    const chatId = msg.chat.id;
    const [rawCommand, arg] = String(msg.text || '').trim().toLowerCase().split(/\s+/);
    const command = rawCommand.replace(/^\//, '').split('@')[0];
    try {
      if (['pause', 'resume', 'noise'].includes(command) && String(chatId) !== String(notificationChatId)) {
        await send('Change notification settings in the configured notification chat.', chatId);
        return;
      }
      if (command === 'check') await check(chatId);
      else if (command === 'next') {
        const snapshots = Object.values(qol.getCalendars());
        const events = snapshots.flatMap((s) => s.events);
        const seen = new Set();
        const unique = events.filter((ev) => {
          const key = JSON.stringify([ev.currency, ev.eventName, ev.timestamp, ev.dateStr, ev.timeText]);
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
        const fetchedTimes = snapshots.map((s) => s.fetchedAt).filter((time) => Number.isFinite(time) && time > 0);
        await send(buildNextMessage(unique, { now: now(), fetchedAt: fetchedTimes.length ? Math.min(...fetchedTimes) : null,
          stale: snapshots.some((s) => s.stale || s.partial) }), chatId);
      } else if (command === 'status') {
        await send(buildCompactStatus(getHealth(), { now: now(), prefs: qol.getPreferences(notificationChatId) }), chatId, { reply_markup: statusKeyboard });
      } else if (command === 'pending') await send(buildPendingMessage(getHealth(), { now: now() }), chatId);
      else if (command === 'pause') {
        const until = qol.pause(chatId, arg);
        await send(`<b>Notifications paused</b>\nAuto-resume: ${escapeHtml(formatSgtTime(until, now()))}\nData collection continues. Held alerts will appear in one catch-up report.`, chatId);
      } else if (command === 'resume') {
        await send('Resuming notifications...', chatId);
        if (!await qol.resume(chatId)) await send('Catch-up delivery failed. Held alerts remain queued for retry.', chatId);
      } else if (command === 'noise') {
        qol.setNoise(chatId, arg);
        await send(arg === 'low' ? 'Low-impact and non-economic alerts will arrive silently. No events are removed.' : 'Normal notifications restored for all impacts. Individually muted events stay silent.', chatId);
      } else if (['help', 'start'].includes(command)) {
        await send('<b>Calendar bot</b>\n/next - next full release group\n/check - refresh calendar\n/status - health and details\n/pending - delayed values\n/pause 1h - pause notifications\n/resume - resume and catch up\n/noise low - silent low-impact alerts\n/noise normal - normal notifications\n\nUse the buttons on each event for its explanation, source and mute setting.', chatId);
      }
    } catch (error) {
      await send(`Unable to complete command: ${escapeHtml(error.message)}`, chatId);
    }
  };
  const onCallback = async (query) => {
    const chatId = query.message?.chat?.id;
    if (chatId === undefined || !isAllowed(chatId)) {
      await answer(query.id, { text: 'Not authorized.', show_alert: true });
      return;
    }
    const [action, id] = String(query.data || '').split(':');
    try {
      if (action === 'status' && id === 'details') {
        await answer(query.id);
        await send(buildDetailedStatus(getHealth(), { now: now() }), chatId);
        return;
      }
      if (!['why', 'mute'].includes(action)) { await answer(query.id, { text: 'Unknown action.' }); return; }
      const record = qol.getRecord(id, chatId);
      if (!record) { await answer(query.id, { text: 'This alert has expired.', show_alert: true }); return; }
      if (action === 'why') {
        await answer(query.id);
        await send(buildWhyMessage(record), chatId, { reply_parameters: { message_id: query.message.message_id, allow_sending_without_reply: true } });
      } else {
        if (String(chatId) !== String(notificationChatId)) { await answer(query.id, { text: 'Use the notification chat.' }); return; }
        const muted = qol.toggleMute(id, chatId);
        await answer(query.id, { text: muted ? 'This occurrence will arrive silently.' : 'Normal event notifications restored.' });
        await editMarkup(chatId, query.message.message_id, qol.keyboardFor(id, chatId));
      }
    } catch {
      await answer(query.id, { text: 'Action failed. Please try again.', show_alert: true });
    }
  };
  return { onMessage, onCallback };
};

module.exports = { createCommandController };
