require('dotenv').config({ quiet: true });

const express = require('express');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

const { config, validateConfig, isAllowedChatId } = require('./config');
const { applyFallbackValues } = require('./fallback');
const { fetchCalendarSnapshot } = require('./scraper');
const { createQolService, sameOccurrence } = require('./qolService');
const { createCalendarGateway } = require('./calendarGateway');
const { createCommandController } = require('./commands');
const { eventTimeMs, formatSgtTime } = require('./qolPresentation');
const {
  parseDateText,
  parseTimeText,
  formatEventTime,
  escapeHtml,
  getReleaseDedupeId,
  getReleaseUpdateEvents,
  getImpactIcon,
  getTimezoneLabel,
  hasDataValue,
  shouldWaitForActualValue,
} = require('./utils');
const store = require('./store');
const {
  cleanupSentEvents,
  getLastFetch,
  getSentEventCount,
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
const { sendTelegramChunks, editTelegramMessage, editTelegramReplyMarkup,
  answerTelegramCallback, registerTelegramWebhook, bot } = require('./telegram');

const sendRich = async (text, chatId = config.telegram.chatId, options = {}) => {
  const messages = await sendTelegramChunks(text, chatId, { maxLength: config.telegramMessageChunkSize, ...options });
  return messages?.at(-1) || null;
};
const qol = createQolService({ store, send: sendRich, now: () => Date.now() });
let scheduleDirty = false;
const calendar = createCalendarGateway({ fetchSnapshot: fetchCalendarSnapshot, qol,
  onChange: () => { scheduleDirty = true; },
});
qol.cleanup();
const fetchCalendar = async (query) => {
  const snapshot = await calendar.refresh(query);
  if (snapshot.ok) setLastFetch(new Date(snapshot.fetchedAt).toISOString());
  return snapshot.events;
};

const app = express();
const port = config.port;
app.use(express.json());

const TARGET_TZ = config.targetTz;
const SCRAPE_DELAY_SECONDS = config.scrapeDelaySeconds;
const MIN_RESULT_RETRY_ATTEMPTS = 60;
const RESULT_RETRY_ATTEMPTS = Math.max(config.resultRetryAttempts, MIN_RESULT_RETRY_ATTEMPTS);
const RESULT_RETRY_DELAY_SECONDS = config.resultRetryDelaySeconds;
const WARNING_MINUTES = config.warningMinutes;
const SUMMARY_HOUR = config.summaryHour;
const RESCHEDULE_INTERVAL_MINUTES = config.rescheduleIntervalMinutes;
const RELEASE_CATCHUP_MINUTES = config.releaseCatchupMinutes;
const SENT_EVENT_TTL_DAYS = config.sentEventTtlDays;
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
  const timestamp = Number(ev.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const milliseconds = timestamp > 100000000000 ? timestamp : timestamp * 1000;
    return moment(milliseconds).tz(TARGET_TZ);
  }

  const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year) ||
    parseDateText(ev.dateStr, ev.year);
  return dateObj ? moment(dateObj).tz(TARGET_TZ) : null;
};

const getEventsForDate = (events, targetDate) => events.filter((ev) => {
  const eventDate = getEventDate(ev);
  return eventDate ? eventDate.isSame(targetDate, 'day') : false;
});

const getTimedEventDate = (ev) => {
  const time = eventTimeMs(ev);
  return time ? moment(time).tz(TARGET_TZ) : null;
};

const getTimedEvents = (events) => events.filter(getTimedEventDate);

const normalizeFilterValue = (value) => String(value || '').trim().toUpperCase();

const eventMatchesFilters = (ev, filters) => {
  const currencies = filters.currencies.map(normalizeFilterValue);
  const impacts = filters.impacts.map(normalizeFilterValue);

  const currencyMatches = currencies.length === 0 || currencies.includes(normalizeFilterValue(ev.currency));
  const impactMatches = impacts.length === 0 || impacts.includes(normalizeFilterValue(ev.impact));

  return currencyMatches && impactMatches;
};

const filterEvents = (events, filters) => events.filter((ev) => eventMatchesFilters(ev, filters));

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

const isSameEvent = sameOccurrence;

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
  const today = calendar.cached(moment.tz(TARGET_TZ).format('MMMD.YYYY').toLowerCase());
  const lastScrape = today ? {
    at: today.fetchedAt ? new Date(today.fetchedAt).toISOString() : null,
    ok: today.ok, source: today.source, error: today.error || null,
    capturedEventCount: today.capturedEventCount ?? today.events.length,
    expectedEventCount: today.expectedEventCount ?? today.events.length,
    mismatch: Boolean(today.partial),
  } : statusState.lastScrape;
  const scrapeFailed = Boolean(lastScrape && !lastScrape.ok);

  return {
    status: statusState.telegram?.pollingConflict || scrapeFailed || qol.getPreferences(config.telegram.chatId).lastDelivery?.ok === false ? 'degraded' : 'ok',
    startedAt: statusState.startedAt,
    timezone: TARGET_TZ,
    timezoneLabel: TIMEZONE_LABEL,
    telegramMode: config.telegram.mode,
    telegram: {
      mode: config.telegram.mode,
      polling: config.telegram.polling,
      pollingConflict: Boolean(statusState.telegram?.pollingConflict),
      lastPollingError: statusState.telegram?.lastPollingError || null,
      lastDelivery: qol.getPreferences(config.telegram.chatId).lastDelivery || null,
    },
    lastFetch: today?.fetchedAt ? new Date(today.fetchedAt).toISOString() : getLastFetch(),
    lastScrape,
    lastReleaseCheck: statusState.lastReleaseCheck,
    lastFallbackLookup: statusState.lastFallbackLookup,
    pendingResults: statusState.pendingResults,
    notifications: qol.getPreferences(config.telegram.chatId),
    deferredAlertCount: qol.getDeferredCount(config.telegram.chatId),
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
      scrapeDelaySeconds: SCRAPE_DELAY_SECONDS,
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

const getDedupeKey = (ev) => (
  ev.timestamp ?
    `${ev.timestamp}:${ev.currency}:${ev.eventName}` :
    `${ev.currency}:${ev.eventName}:${ev.dateStr}:${ev.timeText}`
);

const getCachedEvents = (queries) => {
  const selected = queries ? new Set(queries) : null;
  const unique = new Map();
  for (const [query, snapshot] of Object.entries(qol.getCalendars())) {
    if (selected && !selected.has(query)) continue;
    for (const event of snapshot.events) unique.set(event.occurrenceId || getDedupeKey(event), event);
  }
  return [...unique.values()];
};

const fetchFreshEventsAcrossDates = async (dateQueries) => {
  for (const query of dateQueries) await fetchCalendar(query);
  return getCachedEvents(dateQueries);
};

const fetchFreshResultEvents = async (dateQueries, groupEvents) => {
  const freshEvents = await fetchFreshEventsAcrossDates(dateQueries);
  const matchedEvents = groupEvents.map((oldEv) => findFreshEvent(freshEvents, oldEv))
    .filter((ev) => eventTimeMs(ev) === eventTimeMs(groupEvents[0]));
  const resultEvents = await applyFallbackValues(matchedEvents, dateQueries);

  return {
    events: resultEvents,
    pendingEvents: resultEvents.filter(shouldWaitForActualValue),
    contextEvents: [
      ...resultEvents,
      ...freshEvents.filter((ev) => !resultEvents.some((result) => isSameEvent(ev, result))),
    ],
  };
};

const getLastScrapeFailure = (query) => {
  const snapshot = calendar.cached(query);
  return snapshot?.stale ? { error: snapshot.error || 'Calendar refresh failed' } : null;
};

const buildScrapeFailureMessage = (displayTitle, failure) => (
  `<b>${escapeHtml(displayTitle)} (${TIMEZONE_LABEL}):</b>\n` +
  'The calendar source is unavailable; an empty calendar was not confirmed.\n' +
  `Reason: ${escapeHtml(failure?.error || 'Refresh failed')}`
);

const sendReleaseGroupMessage = async (releaseEvents, contextEvents) => {
  const accepted = [];
  for (const event of releaseEvents) {
    const result = await qol.deliverEvent(event, {
      chatId: config.telegram.chatId,
      contextEvents,
      observedAt: event.observedAt || Date.now(),
    });
    if (result.delivered) markSent(getReleaseDedupeId(event));
    if (result.accepted) accepted.push(event);
  }
  return accepted;
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
    const scrapeFailure = getLastScrapeFailure(dateQuery);
    if (scrapeFailure && events.length === 0) {
      await qol.deliverNotice(`summary-failed:${dateQuery}`, buildScrapeFailureMessage(displayTitle, scrapeFailure), config.telegram.chatId);
      return;
    }

    const allTargetEvents = getEventsForDate(events, targetDate);
    const targetEvents = filterEvents(allTargetEvents, config.summaryFilters);
    const cachedNotice = scrapeFailure ?
      '⚠️ <b>Forex Factory refresh failed; showing the last successful calendar snapshot.</b>\n\n' : '';

    if (targetEvents.length === 0) {
      const emptyMessage = allTargetEvents.length === 0 ?
        `📅 <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\nNo significant events found.` :
        `📅 <b>${displayTitle} (${TIMEZONE_LABEL}):</b>\nNo events matched summary filters.\n<b>Total available:</b> ${allTargetEvents.length}`;
      await qol.deliverNotice(`summary:${dateQuery}`, emptyMessage, config.telegram.chatId);
    } else {
      await qol.deliverNotice(`summary:${dateQuery}`, cachedNotice + buildEventsReport(targetEvents, displayTitle, '🌅', allTargetEvents.length), config.telegram.chatId);
    }
  });
};

const groupEventsByTime = (events) => {
  const groups = {};
  events.forEach(ev => {
    const eventDate = getTimedEventDate(ev);
    if (!eventDate) return;
    const key = eventDate.toDate().toISOString();
    if (!groups[key]) groups[key] = [];
    groups[key].push(ev);
  });
  return groups;
};

const loadAndSchedule = async (refresh = true) => {
  const now = moment.tz(TARGET_TZ);
  const scheduleStart = now.clone().subtract(RELEASE_CATCHUP_MINUTES, 'minutes');
  const scheduleEnd = now.clone().add(24, 'hours');
  const dateQueries = [
    now.clone().subtract(1, 'day'),
    now,
    now.clone().add(1, 'day'),
  ].map((date) => date.format('MMMD.YYYY').toLowerCase());

  if (refresh) for (const query of dateQueries) await fetchCalendar(query);
  scheduleDirty = false;
  const events = getCachedEvents(dateQueries);

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
        for (const scheduled of groupEvents) {
          const current = getCachedEvents();
          const event = current.find((candidate) => sameOccurrence(candidate, scheduled)) || scheduled;
          if (eventTimeMs(event) !== eventTimeMs(scheduled)) continue;
          await qol.deliverEvent(event, {
            chatId: config.telegram.chatId, phase: 'pre-release', contextEvents: groupEvents,
          });
        }
      });
    }

    const scrapeTime = eventTime.clone().add(SCRAPE_DELAY_SECONDS, 'seconds');
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
              contextEvents,
            } = await fetchFreshResultEvents(dateQueries, groupEvents);

            const releaseEvents = getReleaseUpdateEvents(resultEvents, nextPendingEvents);
            const unsentReleaseEvents = releaseEvents;
            const deliveredReleaseEvents = [];

            if (unsentReleaseEvents.length > 0) {
              const delivered = await sendReleaseGroupMessage(unsentReleaseEvents, contextEvents);
              sentCount += delivered.length;
              deliveredReleaseEvents.push(...delivered);
            }

            pendingEvents = nextPendingEvents;
            const undeliveredCount = unsentReleaseEvents.length - deliveredReleaseEvents.length;
            const needsRetry = pendingEvents.length > 0 || undeliveredCount > 0;
            const nextRetryAt = needsRetry && attempt < RESULT_RETRY_ATTEMPTS ?
              new Date(Date.now() + RESULT_RETRY_DELAY_SECONDS * 1000).toISOString() :
              null;

            recordReleaseCheck({
              groupKey: jobName,
              timeLabel: formatEventTime(groupEvents[0]),
              attempt,
              dateQueries,
              pendingEvents,
              sentEvents: deliveredReleaseEvents,
              nextRetryAt,
            });

            if (!needsRetry) {
              clearPendingResults(jobName);
              return;
            }

            if (attempt === RESULT_RETRY_ATTEMPTS) {
              if (undeliveredCount > 0) console.warn(`${undeliveredCount} release alert(s) could not be delivered after retries.`);
              if (pendingEvents.length > 0) {
                console.warn(
                  `Actual value still pending after ${attempt + 1} scrape cycle(s) across ${dateQueries.join(', ')}: ` +
                  pendingEvents.map((ev) => `${ev.currency} ${ev.eventName}`).join(', ')
                );
                if (sentCount === 0 && releaseEvents.length === 0) {
                  console.warn(
                    `No release rows with actual values after ${attempt + 1} scrape cycle(s) across ${dateQueries.join(', ')}`
                  );
                }
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
  await sendCalendarChanges();
  // Continue checking revisions of already observed releases during regular refreshes.
  const observed = qol.getRecords().filter((r) => r.phase === 'release');
  for (const event of filterEvents(events, config.alertFilters)) {
    const time = eventTimeMs(event);
    if (!time || time > now.valueOf() || now.valueOf() - time > 48 * 3600000 || !hasDataValue(event.actual)) continue;
    if (observed.some((r) => sameOccurrence(r.event, event))) {
      await sendReleaseGroupMessage([event], events);
    }
  }
  recordScheduleRefresh({
    scheduledWarningJobs: [...activeJobNames].filter((jobName) => jobName.startsWith('warning-')).length,
    scheduledResultJobs: [...activeJobNames].filter((jobName) => jobName.startsWith('result-')).length,
    managedJobCount: managedScheduleJobNames.size,
  });
};

const sendCalendarChanges = async () => {
  for (const change of qol.getChanges()) {
    if (!eventMatchesFilters(change.event, config.alertFilters)) { qol.markChangeDelivered(change.id); continue; }
    const name = `${escapeHtml(change.event.currency)} - ${escapeHtml(change.event.eventName)}`;
    const oldTime = formatSgtTime(eventTimeMs(change.previous));
    const newTime = change.kind === 'cancelled' ? 'Cancelled by source' :
      change.kind === 'tentative' ? 'Tentative; exact time unconfirmed' : formatSgtTime(eventTimeMs(change.event));
    const message = `<b>Schedule changed: ${name}</b>\n${escapeHtml(oldTime)}\nNow: ${escapeHtml(newTime)}`;
    if (await qol.deliverNotice(`schedule:${change.id}`, message, config.telegram.chatId)) qol.markChangeDelivered(change.id);
    else break;
  }
};

let scheduleRefreshInProgress = false;
const refreshSchedule = async (refresh = true) => {
  if (scheduleRefreshInProgress) { if (!refresh) scheduleDirty = true; return; }
  scheduleRefreshInProgress = true;

  try {
    await loadAndSchedule(refresh);
    qol.cleanup();
  } catch (err) {
    console.error('Schedule refresh failed:', err);
  } finally {
    scheduleRefreshInProgress = false;
  }
};

app.get('/', (req, res) => res.json(getHealthPayload()));
app.get('/health', (req, res) => res.json(getHealthPayload()));

const server = app.listen(port, () => console.log(`Web server listening on port ${port}`));

const ready = (async () => {
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

  const commands = createCommandController({
    qol, gateway: calendar, send: sendRich, edit: editTelegramMessage,
    editMarkup: editTelegramReplyMarkup, answer: answerTelegramCallback,
    isAllowed: isAllowedChatId, notificationChatId: config.telegram.chatId, getHealth: getHealthPayload,
    now: () => Date.now(),
    onCalendarRefreshed: () => refreshSchedule(false),
    getCheckTarget: () => {
      const target = getTargetDateInfo();
      return { query: target.dateQuery, title: target.displayTitle, date: target.targetDate };
    },
    buildReport: (events, target) => {
      const all = getEventsForDate(events, target.date);
      const selected = filterEvents(all, config.summaryFilters);
      return buildEventsReport(selected, target.title, 'Calendar', all.length);
    },
  });
  // Commands must be usable even while startup is waiting on an unavailable source.
  bot.on('message', commands.onMessage);
  bot.on('callback_query', commands.onCallback);
  await registerTelegramWebhook(app);
  await qol.flushDue();
  setInterval(async () => {
    try { await qol.flushDue(); if (scheduleDirty) await refreshSchedule(false); await sendCalendarChanges(); }
    catch (error) { console.error('Notification maintenance failed:', error.message); }
  }, 15000);
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

})();

module.exports = { ready, getHealthPayload, refreshSchedule };
