require('dotenv').config({ quiet: true });

const express = require('express');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

const { fetchCalendar } = require('./scraper');
const {
  parseDateText,
  parseTimeText,
  formatEventMessage,
  formatEventTime,
  generateChartUrl,
  escapeHtml,
  getImpactIcon,
  getTimezoneLabel,
} = require('./utils');
const { sendTelegramMessage, sendTelegramPhoto, bot } = require('./telegram'); 

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';
const SCRAPE_DELAY_MINUTES = 2; 
const WARNING_MINUTES = 10;
const SUMMARY_HOUR = 6; 
const RESCHEDULE_INTERVAL_MINUTES = Number(process.env.RESCHEDULE_INTERVAL_MINUTES || 30);
const TELEGRAM_MESSAGE_CHUNK_SIZE = 3800;
const TIMEZONE_LABEL = getTimezoneLabel();

const getTargetDateInfo = (now = moment.tz(TARGET_TZ)) => {
  const dayOfWeek = now.day();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  let targetDate = now.clone();
  let displayTitle = now.format('DD MMM');

  if (isWeekend) {
    const daysToAdd = dayOfWeek === 6 ? 2 : 1;
    targetDate = now.clone().add(daysToAdd, 'days');
    displayTitle = `Monday ${targetDate.format('DD MMM')} (Advance View)`;
  }

  return {
    targetDate,
    displayTitle,
    dateQuery: targetDate.format('MMMD.YYYY').toLowerCase(),
  };
};

const getEventDate = (ev) => {
  const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year) ||
    parseDateText(ev.dateStr, ev.year);
  return dateObj ? moment(dateObj).tz(TARGET_TZ) : null;
};

const getEventsForDate = (events, targetDate) => events.filter((ev) => {
  const eventDate = getEventDate(ev);
  return eventDate ? eventDate.isSame(targetDate, 'day') : false;
});

const getTimedEvents = (events) => events.filter((ev) => parseTimeText(ev.dateStr, ev.timeText, ev.year));

const sendLongTelegramMessage = async (text, targetChatId) => {
  const lines = text.split('\n');
  let chunk = '';

  for (const line of lines) {
    if (line.length > TELEGRAM_MESSAGE_CHUNK_SIZE) {
      if (chunk) {
        await sendTelegramMessage(chunk, targetChatId);
        chunk = '';
      }

      for (let i = 0; i < line.length; i += TELEGRAM_MESSAGE_CHUNK_SIZE) {
        await sendTelegramMessage(line.slice(i, i + TELEGRAM_MESSAGE_CHUNK_SIZE), targetChatId);
      }
      continue;
    }

    const nextChunk = chunk ? `${chunk}\n${line}` : line;

    if (nextChunk.length <= TELEGRAM_MESSAGE_CHUNK_SIZE) {
      chunk = nextChunk;
      continue;
    }

    if (chunk) await sendTelegramMessage(chunk, targetChatId);
    chunk = line;
  }

  if (chunk) await sendTelegramMessage(chunk, targetChatId);
};

const buildEventsReport = (events, displayTitle, heading) => {
  let report = `${heading} <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\n`;
  let lastPrintedTime = null;

  for (const ev of events) {
    const icon = getImpactIcon(ev.impact);
    const displayTime = formatEventTime(ev);
    const eventTitle = `<b>${escapeHtml(ev.currency)} - ${escapeHtml(ev.eventName)}</b>`;
    const actual = ev.actual ? escapeHtml(ev.actual) : '--';
    const forecast = ev.forecast ? escapeHtml(ev.forecast) : '--';
    const previous = ev.previous ? escapeHtml(ev.previous) : '--';

    if (displayTime !== lastPrintedTime) {
      report += `${lastPrintedTime === null ? '\n' : '\n\n'}<b>${escapeHtml(displayTime)}</b> ${icon} ${eventTitle}\n`;
      lastPrintedTime = displayTime;
    } else {
      report += `${icon} ${eventTitle}\n`;
    }

    report += `├ Act: ${actual}\n`;
    report += `├ Fcst: ${forecast}\n`;
    report += `└ Prev: ${previous}\n`;
  }

  report += `\n<b>Total events:</b> ${events.length}`;
  return report;
};

const scheduleOrReplaceJob = (jobName, runAt, task) => {
  if (schedule.scheduledJobs[jobName]) {
    schedule.scheduledJobs[jobName].cancel();
  }

  schedule.scheduleJob(jobName, runAt, task);
};

const managedScheduleJobNames = new Set();

const scheduleOrReplaceManagedJob = (jobName, runAt, task) => {
  scheduleOrReplaceJob(jobName, runAt, task);
  managedScheduleJobNames.add(jobName);
};

const cancelStaleManagedJobs = (activeJobNames) => {
  for (const jobName of managedScheduleJobNames) {
    if (activeJobNames.has(jobName)) continue;

    if (schedule.scheduledJobs[jobName]) {
      schedule.scheduledJobs[jobName].cancel();
    }
    managedScheduleJobNames.delete(jobName);
  }
};

const isSameEvent = (a, b) => (
  (a.id && b.id && a.id === b.id) ||
  (
    a.currency === b.currency &&
    a.eventName === b.eventName &&
    a.dateStr === b.dateStr &&
    a.timeText === b.timeText
  )
);

const scheduleDailySummary = () => {
  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = SUMMARY_HOUR; 
  rule.minute = 0;
  rule.second = 0;

  schedule.scheduleJob(rule, async () => {
    const now = moment.tz(TARGET_TZ);
    const { targetDate, displayTitle, dateQuery } = getTargetDateInfo(now);
    const events = await fetchCalendar(dateQuery);
    const targetEvents = getEventsForDate(events, targetDate);

    if (targetEvents.length === 0) {
      await sendTelegramMessage(`📅 <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\nNo significant events found.`);
    } else {
      await sendLongTelegramMessage(buildEventsReport(targetEvents, displayTitle, '🌅'));
    }
  });
};

const groupEventsByTime = (events) => {
  const groups = {};
  events.forEach(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return;
    const key = dateObj.toISOString();
    if (!groups[key]) groups[key] = [];
    groups[key].push(ev);
  });
  return groups;
};

const performSystemCheck = async (targetChatId) => {
  const now = moment.tz(TARGET_TZ);
  const { targetDate, displayTitle, dateQuery } = getTargetDateInfo(now);
  const events = await fetchCalendar(dateQuery);
  const targetEvents = getEventsForDate(events, targetDate);

  if (targetEvents.length === 0) {
    await sendTelegramMessage(`No events found for ${displayTitle} (${TIMEZONE_LABEL}).`, targetChatId);
  } else {
    await sendLongTelegramMessage(buildEventsReport(targetEvents, displayTitle, '📋'), targetChatId);
  }
};

const loadAndSchedule = async () => {  
  const now = moment.tz(TARGET_TZ);
  const dateQuery = now.format('MMMD.YYYY').toLowerCase();

  const events = await fetchCalendar(dateQuery);
  if (!events || events.length === 0) return;

  const targetEvents = getTimedEvents(getEventsForDate(events, now));

  const eventsByTime = groupEventsByTime(targetEvents);
  const activeJobNames = new Set();

  for (const [timeKey, groupEvents] of Object.entries(eventsByTime)) {
    const eventTime = moment(timeKey).tz(TARGET_TZ);
    const warningTime = eventTime.clone().subtract(WARNING_MINUTES, 'minutes');
    
    if (warningTime.isAfter(now)) {
      const warningJobName = `warning-${timeKey}`;
      activeJobNames.add(warningJobName);
      scheduleOrReplaceManagedJob(warningJobName, warningTime.toDate(), async () => {
        let msg = `⚠️ <b>${WARNING_MINUTES} Minutes to Release (${escapeHtml(formatEventTime(groupEvents[0]))}):</b>\n`;
        groupEvents.forEach(ev => msg += formatEventMessage(ev) + '\n');
        await sendTelegramMessage(msg);
      });
    }

    const scrapeTime = eventTime.clone().add(SCRAPE_DELAY_MINUTES, 'minutes');
    if (scrapeTime.isAfter(now)) {
      const jobName = `result-${timeKey}`;
      activeJobNames.add(jobName);
      
      scheduleOrReplaceManagedJob(jobName, scrapeTime.toDate(), async () => {
        try {
          const freshEvents = await fetchCalendar(dateQuery);
          for (const oldEv of groupEvents) {
            const freshEv = freshEvents.find(f => isSameEvent(f, oldEv));
            const targetEv = freshEv || oldEv;
            
            let resultMsg = `✅ <b>News Released (${escapeHtml(formatEventTime(targetEv))}):</b>\n`;
            resultMsg += formatEventMessage(targetEv);

            const chartUrl = generateChartUrl(targetEv);
            if (chartUrl) await sendTelegramPhoto(chartUrl, resultMsg);
            else await sendTelegramMessage(resultMsg);
          }
        } catch (err) { console.error(err); }
      });
    }
  }

  cancelStaleManagedJobs(activeJobNames);
};

let scheduleRefreshInProgress = false;
const refreshSchedule = async () => {
  if (scheduleRefreshInProgress) return;
  scheduleRefreshInProgress = true;

  try {
    await loadAndSchedule();
  } catch (err) {
    console.error('Schedule refresh failed:', err);
  } finally {
    scheduleRefreshInProgress = false;
  }
};

(async () => {
  const shutdown = () => {
    bot.stopPolling();
    schedule.gracefulShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  scheduleDailySummary();
  await refreshSchedule();

  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = 0;
  rule.minute = 1;
  schedule.scheduleJob(rule, async () => {
    await refreshSchedule();
  });

  if (RESCHEDULE_INTERVAL_MINUTES > 0) {
    setInterval(refreshSchedule, RESCHEDULE_INTERVAL_MINUTES * 60 * 1000);
  }

  bot.on('message', async (msg) => {
    const text = msg.text ? msg.text.toLowerCase().trim() : '';
    const command = text.split(/\s+/)[0];
    if (command === 'check' || command === '/check' || command.startsWith('/check@')) {
      await performSystemCheck(msg.chat.id);
    }
  });
})();
