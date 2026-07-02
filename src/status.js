const startedAt = new Date().toISOString();

const state = {
  startedAt,
  lastScrape: null,
  lastScheduleRefresh: null,
  scrapeWarningCount: 0,
};

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

const getStatusState = () => ({ ...state });

module.exports = { getStatusState, recordScrape, recordScheduleRefresh };
