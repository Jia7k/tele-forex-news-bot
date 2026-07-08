require('dotenv').config({ quiet: true });

const express = require('express');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

const { config, validateConfig, isAllowedChatId } = require('./config');
const { applyFallbackValues } = require('./fallback');
const { fetchCalendar } = require('./scraper');
const {
  parseDateText,
  parseTimeText,
  formatEventMessage,
  formatEventTime,
  escapeHtml,
  getReleaseDedupeId,
  getImpactIcon,
  getTimezoneLabel,
  hasDataValue,
  shouldSendReleaseUpdate,
  shouldWaitForActualValue,
} = require('./utils');
const {
  cleanupSentEvents,
  getLastFetch,
  getSentEventCount,
  hasSent,
  markSent,
  setLastFetch,
} = require('./store');
const {
  clearPendingResults,
  getStatusState,
  recordPendingResults,
  recordReleaseCheck,
  recordScheduleRefresh,
} = require('./status');

validateConfig();
const { sendTelegramMessage, registerTelegramWebhook, bot } = require('./telegram');

const app = express();
const port = config.port;
app.use(express.json());

const TARGET_TZ = config.targetTz;
const MIN_SCRAPE_DELAY_MINUTES = 2;
const SCRAPE_DELAY_MINUTES = Math.max(config.scrapeDelayMinutes, MIN_SCRAPE_DELAY_MINUTES);
const MIN_RESULT_RETRY_ATTEMPTS = 60;
const RESULT_RETRY_ATTEMPTS = Math.max(config.resultRetryAttempts, MIN_RESULT_RETRY_ATTEMPTS);
const RESULT_RETRY_DELAY_SECONDS = config.resultRetryDelaySeconds;
const WARNING_MINUTES = config.warningMinutes;
const SUMMARY_HOUR = config.summaryHour;
const RESCHEDULE_INTERVAL_MINUTES = config.rescheduleIntervalMinutes;
const RELEASE_CATCHUP_MINUTES = config.releaseCatchupMinutes;
const SENT_EVENT_TTL_DAYS = config.sentEventTtlDays;
const TELEGRAM_MESSAGE_CHUNK_SIZE = config.telegramMessageChunkSize;
const TIMEZONE_LABEL = getTimezoneLabel();

const cleanedSentEvents = cleanupSentEvents(SENT_EVENT_TTL_DAYS);
if (cleanedSentEvents > 0) {
  console.log(`Cleaned ${cleanedSentEvents} sent release dedupe entr${cleanedSentEvents === 1 ? 'y' : 'ies'}.`);
}

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

const normalizeFilterValue = (value) => String(value || '').trim().toUpperCase();

const eventMatchesFilters = (ev, filters) => {
  const currencies = filters.currencies.map(normalizeFilterValue);
  const impacts = filters.impacts.map(normalizeFilterValue);

  const currencyMatches = currencies.length === 0 || currencies.includes(normalizeFilterValue(ev.currency));
  const impactMatches = impacts.length === 0 || impacts.includes(normalizeFilterValue(ev.impact));

  return currencyMatches && impactMatches;
};

const filterEvents = (events, filters) => events.filter((ev) => eventMatchesFilters(ev, filters));

const formatFilters = (filters) => {
  const currencyText = filters.currencies.length > 0 ? filters.currencies.join(', ') : 'All';
  const impactText = filters.impacts.length > 0 ? filters.impacts.join(', ') : 'All';
  return `Currencies: ${currencyText}; Impacts: ${impactText}`;
};

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

const buildEventsReport = (events, displayTitle, heading, totalEventCount = events.length) => {
  let report = `${heading} <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\n`;
  let lastPrintedTime = null;

  for (const ev of events) {
    const icon = getImpactIcon(ev.impact);
    const displayTime = formatEventTime(ev);
    const eventTitle = `<b>${escapeHtml(ev.currency)} - ${escapeHtml(ev.eventName)}</b>`;
    const actual = hasDataValue(ev.actual) ? escapeHtml(ev.actual) : '--';
    const forecast = hasDataValue(ev.forecast) ? escapeHtml(ev.forecast) : '--';
    const previous = hasDataValue(ev.previous) ? escapeHtml(ev.previous) : '--';

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
  if (totalEventCount !== events.length) {
    report += ` of ${totalEventCount} available`;
  }
  return report;
};

const scheduleOrReplaceJob = (jobName, runAt, task) => {
  if (schedule.scheduledJobs[jobName]) {
    schedule.scheduledJobs[jobName].cancel();
  }

  schedule.scheduleJob(jobName, runAt, task);
};

const managedScheduleJobNames = new Set();
const activeResultCheckNames = new Set();

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

const getScheduledJobSummary = () => {
  const jobs = Object.entries(schedule.scheduledJobs);
  const managedJobs = jobs.filter(([jobName]) => managedScheduleJobNames.has(jobName));
  const nextJobs = managedJobs
    .map(([name, job]) => {
      const nextInvocation = job.nextInvocation?.();
      const nextDate = nextInvocation?.toDate ? nextInvocation.toDate() : nextInvocation;
      return {
        name,
        nextRunAt: nextDate instanceof Date ? nextDate.toISOString() : null,
      };
    })
    .filter((job) => job.nextRunAt)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
    .slice(0, 5);

  return {
    totalJobs: jobs.length,
    managedJobs: managedJobs.length,
    warningJobs: managedJobs.filter(([jobName]) => jobName.startsWith('warning-')).length,
    resultJobs: managedJobs.filter(([jobName]) => jobName.startsWith('result-')).length,
    nextJobs,
  };
};

const getHealthPayload = () => {
  const statusState = getStatusState();
  const scheduledJobs = getScheduledJobSummary();

  return {
    status: 'ok',
    startedAt: statusState.startedAt,
    timezone: TARGET_TZ,
    timezoneLabel: TIMEZONE_LABEL,
    telegramMode: config.telegram.mode,
    lastFetch: getLastFetch(),
    lastScrape: statusState.lastScrape,
    lastReleaseCheck: statusState.lastReleaseCheck,
    lastFallbackLookup: statusState.lastFallbackLookup,
    pendingResults: statusState.pendingResults,
    pendingResultCount: Object.keys(statusState.pendingResults || {}).length,
    scrapeWarningCount: statusState.scrapeWarningCount,
    lastScheduleRefresh: statusState.lastScheduleRefresh,
    sentEventCount: getSentEventCount(),
    activeResultChecks: activeResultCheckNames.size,
    scheduledJobs,
    filters: {
      summary: config.summaryFilters,
      alerts: config.alertFilters,
    },
    release: {
      scrapeDelayMinutes: SCRAPE_DELAY_MINUTES,
      retryAttempts: RESULT_RETRY_ATTEMPTS,
      retryDelaySeconds: RESULT_RETRY_DELAY_SECONDS,
      catchupMinutes: RELEASE_CATCHUP_MINUTES,
      sentEventTtlDays: SENT_EVENT_TTL_DAYS,
    },
    fallback: {
      provider: config.fallback.provider,
      matchWindowMinutes: config.fallback.matchWindowMinutes,
    },
  };
};

const buildStatusMessage = () => {
  const health = getHealthPayload();
  const lastScrape = health.lastScrape;
  const nextJob = health.scheduledJobs.nextJobs[0];

  return [
    '<b>Bot Status</b>',
    `Status: ${escapeHtml(health.status)}`,
    `Mode: ${escapeHtml(health.telegramMode)}`,
    `Timezone: ${escapeHtml(TARGET_TZ)} (${escapeHtml(TIMEZONE_LABEL)})`,
    `Last fetch: ${escapeHtml(health.lastFetch || 'Never')}`,
    `Last scrape rows: ${lastScrape ? `${lastScrape.capturedEventCount}/${lastScrape.expectedEventCount || lastScrape.capturedEventCount}` : 'None'}`,
    `Scrape warnings: ${health.scrapeWarningCount}`,
    `Scheduled jobs: ${health.scheduledJobs.managedJobs} managed (${health.scheduledJobs.warningJobs} warnings, ${health.scheduledJobs.resultJobs} results)`,
    `Next job: ${nextJob ? `${escapeHtml(nextJob.name)} at ${escapeHtml(nextJob.nextRunAt)}` : 'None'}`,
    `Active result checks: ${health.activeResultChecks}`,
    `Pending release groups: ${health.pendingResultCount}`,
    `Last release check: ${health.lastReleaseCheck ? `${escapeHtml(health.lastReleaseCheck.groupKey)} at ${escapeHtml(health.lastReleaseCheck.at)}` : 'None'}`,
    `Fallback: ${escapeHtml(health.fallback.provider)}${health.lastFallbackLookup ? ` (last ok: ${health.lastFallbackLookup.ok}, matched: ${health.lastFallbackLookup.matchedCount})` : ''}`,
    `Sent release dedupe entries: ${health.sentEventCount}`,
    `Summary filters: ${escapeHtml(formatFilters(config.summaryFilters))}`,
    `Alert filters: ${escapeHtml(formatFilters(config.alertFilters))}`,
  ].join('\n');
};

const buildPendingMessage = () => {
  const health = getHealthPayload();
  const pendingGroups = Object.values(health.pendingResults || {})
    .sort((a, b) => String(a.nextRetryAt || '').localeCompare(String(b.nextRetryAt || '')));

  if (pendingGroups.length === 0) {
    return '<b>Pending Releases</b>\nNo release values are pending.';
  }

  const lines = ['<b>Pending Releases</b>'];

  for (const group of pendingGroups.slice(0, 10)) {
    lines.push('');
    lines.push(`<b>${escapeHtml(group.timeLabel || group.groupKey)}</b>`);
    lines.push(`Attempt: ${escapeHtml(String((group.attempt ?? 0) + 1))}/${RESULT_RETRY_ATTEMPTS + 1}`);
    lines.push(`Next retry: ${escapeHtml(group.nextRetryAt || 'Not scheduled')}`);
    lines.push(`Date queries: ${escapeHtml((group.dateQueries || []).join(', ') || 'None')}`);

    for (const ev of group.pendingEvents || []) {
      const forecast = ev.forecast === null || ev.forecast === undefined || ev.forecast === '' ? '--' : String(ev.forecast);
      const previous = ev.previous === null || ev.previous === undefined || ev.previous === '' ? '--' : String(ev.previous);
      lines.push(`- ${escapeHtml(ev.currency)} ${escapeHtml(ev.eventName)} (Fcst: ${escapeHtml(forecast)}, Prev: ${escapeHtml(previous)})`);
    }
  }

  if (pendingGroups.length > 10) {
    lines.push('');
    lines.push(`Showing 10 of ${pendingGroups.length} pending groups.`);
  }

  return lines.join('\n');
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findFreshEvent = (freshEvents, oldEv) => (
  freshEvents.find(f => isSameEvent(f, oldEv)) || oldEv
);

const getDateQueryVariants = (dateQuery, groupEvents) => {
  const queries = new Set([dateQuery]);
  const addMomentWithNeighbors = (dateMoment) => {
    if (!dateMoment || !dateMoment.isValid()) return;

    [-1, 0, 1].forEach((days) => {
      queries.add(dateMoment.clone().add(days, 'days').format('MMMD.YYYY').toLowerCase());
    });
  };

  const dateQueryMatch = String(dateQuery || '').match(/^([a-z]{3})(\d{1,2})\.(\d{4})$/i);
  if (dateQueryMatch) {
    addMomentWithNeighbors(moment.tz(
      `${dateQueryMatch[1]} ${dateQueryMatch[2]} ${dateQueryMatch[3]}`,
      'MMM D YYYY',
      true,
      TARGET_TZ
    ));
  }

  groupEvents.forEach((ev) => {
    const eventDate = getEventDate(ev);
    if (eventDate) addMomentWithNeighbors(eventDate);
  });

  return [...queries];
};

const getDedupeKey = (ev) => ev.id || `${ev.currency}:${ev.eventName}:${ev.dateStr}:${ev.timeText}`;

const fetchFreshEventsAcrossDates = async (dateQueries) => {
  const seenEvents = new Set();
  const freshEvents = [];

  for (const query of dateQueries) {
    const events = await fetchCalendar(query, { cacheBust: true });
    for (const ev of events) {
      const key = getDedupeKey(ev);
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      freshEvents.push(ev);
    }
  }

  setLastFetch(new Date().toISOString());
  return freshEvents;
};

const fetchFreshResultEvents = async (dateQueries, groupEvents) => {
  const freshEvents = await fetchFreshEventsAcrossDates(dateQueries);
  const matchedEvents = groupEvents.map((oldEv) => findFreshEvent(freshEvents, oldEv));
  const resultEvents = await applyFallbackValues(matchedEvents, dateQueries);

  return {
    events: resultEvents,
    pendingEvents: resultEvents.filter(shouldWaitForActualValue),
  };
};

const sendReleaseGroupMessage = async (releaseEvents) => {
  if (releaseEvents.length === 0) return false;

  let resultMsg = `✅ <b>News Released (${escapeHtml(formatEventTime(releaseEvents[0]))}):</b>\n`;
  for (const ev of releaseEvents) {
    resultMsg += formatEventMessage(ev);
  }

  return sendTelegramMessage(resultMsg);
};

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
    setLastFetch(new Date().toISOString());
    const allTargetEvents = getEventsForDate(events, targetDate);
    const targetEvents = filterEvents(allTargetEvents, config.summaryFilters);

    if (targetEvents.length === 0) {
      const emptyMessage = allTargetEvents.length === 0 ?
        `📅 <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\nNo significant events found.` :
        `📅 <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\nNo events matched summary filters.\n<b>Total available:</b> ${allTargetEvents.length}`;
      await sendTelegramMessage(emptyMessage);
    } else {
      await sendLongTelegramMessage(buildEventsReport(targetEvents, displayTitle, '🌅', allTargetEvents.length));
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
  setLastFetch(new Date().toISOString());
  const allTargetEvents = getEventsForDate(events, targetDate);
  const targetEvents = filterEvents(allTargetEvents, config.summaryFilters);

  if (targetEvents.length === 0) {
    const emptyMessage = allTargetEvents.length === 0 ?
      `No events found for ${displayTitle} (${TIMEZONE_LABEL}).` :
      `No events matched summary filters for ${displayTitle} (${TIMEZONE_LABEL}). Total available: ${allTargetEvents.length}`;
    await sendTelegramMessage(emptyMessage, targetChatId);
  } else {
    await sendLongTelegramMessage(buildEventsReport(targetEvents, displayTitle, '📋', allTargetEvents.length), targetChatId);
  }
};

const loadAndSchedule = async () => {
  const now = moment.tz(TARGET_TZ);
  const scheduleStart = now.clone().subtract(RELEASE_CATCHUP_MINUTES, 'minutes');
  const scheduleEnd = now.clone().add(24, 'hours');
  const dateQueries = [
    now.clone().subtract(1, 'day'),
    now,
    now.clone().add(1, 'day'),
  ].map((date) => date.format('MMMD.YYYY').toLowerCase());

  const seenEvents = new Set();
  const events = [];
  for (const query of dateQueries) {
    const calendarEvents = await fetchCalendar(query);
    for (const ev of calendarEvents) {
      const key = getDedupeKey(ev);
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      events.push(ev);
    }
  }
  setLastFetch(new Date().toISOString());
  if (!events || events.length === 0) return;

  const targetEvents = filterEvents(getTimedEvents(events), config.alertFilters)
    .filter((ev) => {
      const eventDate = getEventDate(ev);
      return eventDate && eventDate.isBetween(scheduleStart, scheduleEnd, undefined, '[]');
    });

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
    const isCatchupRelease = !scrapeTime.isAfter(now) && eventTime.isSameOrAfter(scheduleStart);

    if (scrapeTime.isAfter(now) || isCatchupRelease) {
      const jobName = `result-${timeKey}`;
      activeJobNames.add(jobName);
      const runAt = scrapeTime.isAfter(now) ? scrapeTime.toDate() : now.clone().add(5, 'seconds').toDate();
      const baseDateQuery = eventTime.format('MMMD.YYYY').toLowerCase();

      scheduleOrReplaceManagedJob(jobName, runAt, async () => {
        if (activeResultCheckNames.has(jobName)) {
          console.warn(`Skipped overlapping result check for ${jobName}`);
          return;
        }

        activeResultCheckNames.add(jobName);
        try {
          const dateQueries = getDateQueryVariants(baseDateQuery, groupEvents);
          let pendingEvents = groupEvents.filter(shouldWaitForActualValue);
          let sentCount = 0;

          for (let attempt = 0; attempt <= RESULT_RETRY_ATTEMPTS; attempt += 1) {
            const {
              events: resultEvents,
              pendingEvents: nextPendingEvents,
            } = await fetchFreshResultEvents(dateQueries, groupEvents);

            const releaseEvents = resultEvents.filter(shouldSendReleaseUpdate);
            const unsentReleaseEvents = releaseEvents.filter((targetEv) => !hasSent(getReleaseDedupeId(targetEv)));

            if (unsentReleaseEvents.length > 0) {
              const sent = await sendReleaseGroupMessage(unsentReleaseEvents);
              if (sent) {
                unsentReleaseEvents.forEach((targetEv) => markSent(getReleaseDedupeId(targetEv)));
                sentCount += unsentReleaseEvents.length;
              }
            }

            pendingEvents = nextPendingEvents;
            const nextRetryAt = pendingEvents.length > 0 && attempt < RESULT_RETRY_ATTEMPTS ?
              new Date(Date.now() + RESULT_RETRY_DELAY_SECONDS * 1000).toISOString() :
              null;

            recordReleaseCheck({
              groupKey: jobName,
              timeLabel: formatEventTime(groupEvents[0]),
              attempt,
              dateQueries,
              pendingEvents,
              sentEvents: unsentReleaseEvents,
              nextRetryAt,
            });

            if (pendingEvents.length === 0) {
              clearPendingResults(jobName);
              return;
            }

            if (attempt === RESULT_RETRY_ATTEMPTS) {
              console.warn(
                `Actual value still pending after ${attempt + 1} scrape cycle(s) across ${dateQueries.join(', ')}: ` +
                pendingEvents.map((ev) => `${ev.currency} ${ev.eventName}`).join(', ')
              );
              if (sentCount === 0) {
                console.warn(
                  `No release rows with actual values after ${attempt + 1} scrape cycle(s) across ${dateQueries.join(', ')}`
                );
              }
              return;
            }

            recordPendingResults({
              groupKey: jobName,
              timeLabel: formatEventTime(groupEvents[0]),
              attempt,
              dateQueries,
              pendingEvents,
              nextRetryAt,
            });

            await delay(RESULT_RETRY_DELAY_SECONDS * 1000);
          }
        } catch (err) {
          console.error(err);
        } finally {
          activeResultCheckNames.delete(jobName);
        }
      });
    }
  }

  cancelStaleManagedJobs(activeJobNames);
  recordScheduleRefresh({
    scheduledWarningJobs: [...activeJobNames].filter((jobName) => jobName.startsWith('warning-')).length,
    scheduledResultJobs: [...activeJobNames].filter((jobName) => jobName.startsWith('result-')).length,
    managedJobCount: managedScheduleJobNames.size,
  });
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

app.get('/', (req, res) => res.json(getHealthPayload()));
app.get('/health', (req, res) => res.json(getHealthPayload()));

const server = app.listen(port, () => console.log(`Web server listening on port ${port}`));

(async () => {
  const shutdown = () => {
    if (config.telegram.polling) {
      bot.stopPolling();
    }
    schedule.gracefulShutdown();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await registerTelegramWebhook(app);
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
    const isCheckCommand = command === 'check' || command === '/check' || command.startsWith('/check@');
    const isStatusCommand = command === 'status' || command === '/status' || command.startsWith('/status@');
    const isPendingCommand = command === 'pending' || command === '/pending' || command.startsWith('/pending@');

    if (isCheckCommand || isStatusCommand || isPendingCommand) {
      if (!isAllowedChatId(msg.chat.id)) {
        console.warn(`Ignored command from unauthorized chat ${msg.chat.id}`);
        return;
      }
    }

    if (isCheckCommand) {
      await performSystemCheck(msg.chat.id);
    } else if (isStatusCommand) {
      await sendTelegramMessage(buildStatusMessage(), msg.chat.id);
    } else if (isPendingCommand) {
      await sendTelegramMessage(buildPendingMessage(), msg.chat.id);
    }
  });
})();
