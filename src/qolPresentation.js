const moment = require('moment-timezone');
const { config } = require('./config');
const { escapeHtml, getTimezoneLabel, hasDataValue, parseTimeText, getEventGoldOutlook } = require('./utils');

const timeMs = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return null;
  let milliseconds;
  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    milliseconds = Math.abs(numeric) > 1e11 ? numeric : numeric * 1000;
  } else if (typeof value === 'string') {
    const parsed = moment.tz(value, moment.ISO_8601, true, config.targetTz);
    milliseconds = parsed.isValid() ? parsed.valueOf() : NaN;
  }
  return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
};

const eventTimeMs = (ev) => {
  if (!ev || ev.cancelled || ev.canceled || ev.tentative || ev.allDay ||
    /tentative|all[\s-]*day|cancelled|canceled/i.test(`${ev.timeText || ''} ${ev.status || ''}`)) return null;
  const timestamp = timeMs(ev.timestamp);
  if (timestamp !== null && timestamp > 0) return timestamp;
  if (!Number.isInteger(Number(ev.year)) || Number(ev.year) <= 0) return null;
  return parseTimeText(ev.dateStr, ev.timeText, ev.year)?.getTime() ?? null;
};

const duration = (milliseconds) => {
  let seconds = Math.floor(Math.abs(milliseconds) / 1000);
  if (!seconds) return '<1s';
  const parts = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${unit}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return parts.join(' ');
};

const formatSgtTime = (value, now = Date.now()) => {
  const timestamp = timeMs(value);
  if (timestamp === null) return 'Unknown';
  const current = timeMs(now);
  const absolute = `${moment(timestamp).tz(config.targetTz).format('DD MMM YYYY HH:mm:ss')} ${getTimezoneLabel()}`;
  if (current === null) return escapeHtml(absolute);
  const delta = timestamp - current;
  const relative = delta === 0 ? 'now' : delta > 0 ? `in ${duration(delta)}` : `${duration(delta)} ago`;
  return escapeHtml(`${absolute} (${relative})`);
};

const eventTitle = (ev) => escapeHtml([ev?.currency, ev?.eventName || 'Unnamed event'].filter(Boolean).join(' - '));

const buildNextMessage = (events, { now = Date.now(), fetchedAt = null, stale = false } = {}) => {
  const current = timeMs(now);
  const timed = (events || []).map((ev) => ({ ev, at: eventTimeMs(ev) }))
    .filter(({ at }) => current !== null && at !== null && at > current);
  const nextAt = timed.reduce((earliest, { at }) => Math.min(earliest, at), Infinity);
  const lines = ['<b>Next Release</b>'];
  if (Number.isFinite(nextAt)) {
    lines.push(formatSgtTime(nextAt, now));
    for (const { ev } of timed.filter(({ at }) => at === nextAt)) {
      lines.push(`- ${eventTitle(ev)} (${escapeHtml(ev.impact || 'Unknown impact')})`);
    }
  } else {
    lines.push('No upcoming timed events in this calendar.');
  }
  lines.push(`Cached calendar${stale ? ' (STALE)' : ''}: ${formatSgtTime(fetchedAt, now)}`);
  return lines.join('\n');
};

const buildLateNotice = (ev, { now = Date.now(), observedAt = now, lateAfterMs = 300000 } = {}) => {
  const releaseAt = eventTimeMs(ev);
  const latest = Math.max(timeMs(now) ?? -Infinity, timeMs(observedAt) ?? -Infinity);
  if (releaseAt === null || latest - releaseAt < lateAfterMs) return '';
  return [
    '<b>LATE</b>',
    `Release: ${formatSgtTime(releaseAt, now)}`,
    `Observed: ${formatSgtTime(observedAt, now)}`,
  ].join('\n');
};

const diagnosticText = (value, now) => escapeHtml(value ?? 'Unknown')
  .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g,
    (iso) => formatSgtTime(iso, now));

const pendingGroups = (health) => health?.pendingResults && typeof health.pendingResults === 'object' ?
  Object.values(health.pendingResults).filter(Boolean) : null;

// A running transport is not evidence that a message was delivered.
const deliveryState = (health, prefs) => {
  const telegram = health.telegram || {};
  const mode = health.telegramMode ?? telegram.mode;
  const delivery = prefs?.lastDelivery ?? health.notifications?.lastDelivery ?? telegram.lastDelivery ?? health.lastDelivery;
  if (mode === 'disabled' || telegram.mode === 'disabled') return 'Disabled';
  if (delivery?.ok === false || delivery?.error) return 'Failed (last send)';
  if (telegram.pollingConflict) return 'Degraded (polling conflict)';
  if (telegram.lastPollingError) return 'Degraded (polling error)';
  if (!['polling', 'webhook'].includes(mode)) return 'Unknown (transport mode unknown)';
  if (delivery?.ok === true && timeMs(delivery.at) !== null) return 'Last send succeeded';
  return 'Unknown (no confirmed send)';
};

const buildCompactStatus = (health, { now = Date.now(), prefs } = {}) => {
  const h = health || {};
  const scrape = h.lastScrape;
  let calendar = 'Unknown';
  if (scrape?.ok === false || scrape?.error) calendar = 'Unavailable';
  else if (scrape?.ok === true) calendar = scrape.mismatch ? 'Partial' : 'Available';
  const groups = pendingGroups(h);
  const count = groups?.length ?? h.pendingResultCount;
  const pending = Number.isInteger(count) && count >= 0 ? `${count} group${count === 1 ? '' : 's'}` : 'Unknown';
  const pausedUntil = timeMs(prefs?.pauseUntil ?? prefs?.pausedUntil);
  const current = timeMs(now);
  const notifications = pausedUntil !== null && current !== null && pausedUntil > current ?
    `Paused until ${formatSgtTime(pausedUntil, now)}` : prefs?.resumePending ? 'Catch-up pending' : prefs ? 'Active' : 'Unknown';
  return [
    '<b>Bot Status</b>',
    `Calendar: ${calendar}; cached ${formatSgtTime(h.lastFetch, now)}`,
    `Pending: ${pending}`,
    `Delivery: ${deliveryState(h, prefs)}`,
    `Notifications: ${notifications}`,
    `Noise: ${escapeHtml(prefs?.noise ?? 'Unknown')}`,
  ].join('\n');
};

const metric = (value) => hasDataValue(value) ? escapeHtml(value) : '--';

const buildPendingMessage = (health, { now = Date.now() } = {}) => {
  const groups = pendingGroups(health);
  const lines = ['<b>Pending Releases</b>'];
  if (!groups) return `${lines[0]}\nPending state is unknown.`;
  if (!groups.length) return `${lines[0]}\nNo release values are pending.`;
  groups.sort((a, b) => (timeMs(a.nextRetryAt) ?? Infinity) - (timeMs(b.nextRetryAt) ?? Infinity));
  const attempts = health.release?.retryAttempts;
  for (const group of groups.slice(0, 10)) {
    const attempt = Number.isInteger(group.attempt) ? group.attempt + 1 : 'Unknown';
    lines.push('', `<b>${diagnosticText(group.timeLabel || group.groupKey, now)}</b>`,
      `Attempt: ${attempt}${Number.isInteger(attempts) ? `/${attempts + 1}` : ''}`,
      `Updated: ${formatSgtTime(group.updatedAt, now)}`,
      `Next retry: ${timeMs(group.nextRetryAt) === null ? 'Not scheduled' : formatSgtTime(group.nextRetryAt, now)}`);
    for (const ev of group.pendingEvents || []) {
      lines.push(`- ${eventTitle(ev)} (Fcst: ${metric(ev.forecast)}, Prev: ${metric(ev.previous)})`);
    }
  }
  if (groups.length > 10) lines.push(`Showing 10 of ${groups.length} pending groups.`);
  return lines.join('\n');
};

const formatFilters = (filters) => {
  if (!filters) return 'Unknown';
  const list = (values) => Array.isArray(values) ? values.join(', ') || 'All' : 'Unknown';
  return `Currencies: ${list(filters.currencies)}; Impacts: ${list(filters.impacts)}`;
};

const buildDetailedStatus = (health, { now = Date.now() } = {}) => {
  const h = health || {};
  const text = (value) => diagnosticText(value, now);
  const time = (value) => formatSgtTime(value, now);
  const jobs = h.scheduledJobs || {};
  const scrape = h.lastScrape;
  const release = h.lastReleaseCheck;
  const fallback = h.lastFallbackLookup;
  const telegram = h.telegram || {};
  const delivery = h.notifications?.lastDelivery ?? telegram.lastDelivery ?? h.lastDelivery;
  const pollingError = telegram.lastPollingError;
  const lines = [
    '<b>Bot Status Details</b>',
    ...buildCompactStatus(h, { now }).split('\n').slice(1, 4),
    `Started: ${time(h.startedAt)}`,
    `Mode: ${text(h.telegramMode ?? telegram.mode)}`,
    `Last fetch: ${time(h.lastFetch)}`,
    `Last scrape: ${time(scrape?.at)}; source: ${text(scrape?.source)}`,
    `Scrape rows: ${text(scrape?.capturedEventCount)}/${text(scrape?.expectedEventCount)}; warnings: ${text(h.scrapeWarningCount)}`,
    `Scrape error: ${text(scrape?.error || 'None recorded')}`,
    `Scheduled jobs: ${text(jobs.managedJobs)} managed (${text(jobs.warningJobs)} warnings, ${text(jobs.resultJobs)} results); ${text(jobs.totalJobs)} total`,
    `Schedule refreshed: ${time(h.lastScheduleRefresh?.at)}`,
  ];
  for (const job of jobs.nextJobs || []) lines.push(`Next job: ${text(job.name)} at ${time(job.nextRunAt)}`);
  lines.push(
    `Active result checks: ${text(h.activeResultChecks)}`,
    `Last release check: ${text(release?.groupKey)} at ${time(release?.at)}`,
    `Next retry: ${time(release?.nextRetryAt)}`,
    `Fallback: ${text(h.fallback?.provider)}; last lookup: ${time(fallback?.at)}; ok: ${text(fallback?.ok)}; matched: ${text(fallback?.matchedCount)}`,
    `Fallback error: ${text(fallback?.error || 'None recorded')}`,
    `Last delivery: ${time(delivery?.at)}; error: ${text(delivery?.error || 'None recorded')}`,
    `Last polling error: ${pollingError ? `${text(pollingError.description)} (${text(pollingError.code)}, ${text(pollingError.statusCode)}) at ${time(pollingError.at)}` : 'None recorded'}`,
    `Sent release dedupe entries: ${text(h.sentEventCount)}`,
    `Summary filters: ${text(formatFilters(h.filters?.summary))}`,
    `Alert filters: ${text(formatFilters(h.filters?.alerts))}`,
    `Release retries: ${text(h.release?.retryAttempts)}; delay: ${text(h.release?.retryDelaySeconds)}s; catch-up: ${text(h.release?.catchupMinutes)}m`,
    '', buildPendingMessage(h, { now }),
  );
  return lines.join('\n');
};

const buildWhyMessage = (record) => {
  if (!record?.event) return '<b>Why</b>\nNo saved alert snapshot is available.';
  const ev = record.event;
  const phase = record.phase || 'release';
  const outlook = record.outlook || getEventGoldOutlook(ev, {
    phase,
    contextEvents: record.contextEvents || [],
  });
  return [
    `<b>Why: ${eventTitle(ev)}</b>`,
    `Phase: ${escapeHtml(phase)}`,
    `Release: ${formatSgtTime(eventTimeMs(ev), record.observedAt ?? null)}`,
    `Observed: ${formatSgtTime(record.observedAt, null)}`,
    `Act: ${metric(ev.actual)}; Fcst: ${metric(ev.forecast)}; Prev: ${metric(ev.previous)}`,
    `Gold: <b>${escapeHtml(outlook.bias.toUpperCase())}</b>`,
    escapeHtml(outlook.reason),
    escapeHtml(outlook.action),
    '<i>Rules-based interpretation, not price confirmation.</i>',
  ].join('\n');
};

module.exports = {
  eventTimeMs, formatSgtTime, buildNextMessage, buildLateNotice,
  buildCompactStatus, buildDetailedStatus, buildPendingMessage, buildWhyMessage,
};
