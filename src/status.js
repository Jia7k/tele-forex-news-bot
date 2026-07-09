const normalizeValue = (value) => (
  value === null || value === undefined ? '' : String(value)
);

const startedAt = new Date().toISOString();

const state = {
  startedAt,
  lastScrape: null,
  lastReleaseCheck: null,
  lastFallbackLookup: null,
  lastScheduleRefresh: null,
  telegram: {
    pollingConflict: false,
    lastPollingError: null,
  },
  pendingResults: {},
  scrapeWarningCount: 0,
};

const summarizeEvent = (ev) => ({
  id: ev.id || null,
  currency: ev.currency || '',
  eventName: ev.eventName || '',
  timeText: ev.timeText || '',
  dateStr: ev.dateStr || '',
  actual: normalizeValue(ev.actual),
  forecast: normalizeValue(ev.forecast),
  previous: normalizeValue(ev.previous),
});

const recordScrape = ({ url, expectedEventCount, capturedEventCount, ok = true, error = null }) => {
  const mismatch = ok && expectedEventCount > 0 && capturedEventCount !== expectedEventCount;

  if (mismatch || error) {
    state.scrapeWarningCount += 1;
  }

  state.lastScrape = {
    at: new Date().toISOString(),
    url,
    ok,
    expectedEventCount,
    capturedEventCount,
    mismatch,
    error: error ? String(error) : null,
  };
};

const recordScheduleRefresh = ({ scheduledWarningJobs, scheduledResultJobs, managedJobCount }) => {
  state.lastScheduleRefresh = {
    at: new Date().toISOString(),
    scheduledWarningJobs,
    scheduledResultJobs,
    managedJobCount,
  };
};

const isPollingConflict = ({ code, statusCode, description }) => (
  Number(statusCode) === 409 ||
  String(description || '').includes('409') ||
  (
    code === 'ETELEGRAM' &&
    /conflict/i.test(String(description || '')) &&
    /getUpdates|bot instance|poll/i.test(String(description || ''))
  )
);

const recordTelegramPollingError = ({ code = '', statusCode = null, description = '' }) => {
  state.telegram.lastPollingError = {
    at: new Date().toISOString(),
    code: normalizeValue(code),
    statusCode,
    description: normalizeValue(description),
  };

  if (isPollingConflict({ code, statusCode, description })) {
    state.telegram.pollingConflict = true;
  }
};

const recordReleaseCheck = ({
  groupKey,
  timeLabel,
  attempt,
  dateQueries,
  pendingEvents,
  sentEvents,
  nextRetryAt = null,
}) => {
  state.lastReleaseCheck = {
    at: new Date().toISOString(),
    groupKey,
    timeLabel,
    attempt,
    dateQueries,
    pendingEvents: pendingEvents.map(summarizeEvent),
    sentEvents: sentEvents.map(summarizeEvent),
    nextRetryAt,
  };
};

const recordPendingResults = ({
  groupKey,
  timeLabel,
  attempt,
  dateQueries,
  pendingEvents,
  nextRetryAt = null,
}) => {
  state.pendingResults[groupKey] = {
    updatedAt: new Date().toISOString(),
    groupKey,
    timeLabel,
    attempt,
    dateQueries,
    pendingEvents: pendingEvents.map(summarizeEvent),
    nextRetryAt,
  };
};

const clearPendingResults = (groupKey) => {
  delete state.pendingResults[groupKey];
};

const recordFallbackLookup = ({
  provider,
  ok,
  fetchedCount = 0,
  matchedCount = 0,
  error = null,
}) => {
  state.lastFallbackLookup = {
    at: new Date().toISOString(),
    provider,
    ok,
    fetchedCount,
    matchedCount,
    error: error ? String(error) : null,
  };
};

const getStatusState = () => ({
  ...state,
  pendingResults: { ...state.pendingResults },
});

module.exports = {
  clearPendingResults,
  getStatusState,
  recordFallbackLookup,
  recordPendingResults,
  recordReleaseCheck,
  recordScrape,
  recordScheduleRefresh,
  recordTelegramPollingError,
};
