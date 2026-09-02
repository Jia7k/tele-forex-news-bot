const { recordTelegramPollingError } = require('./status');

const getPollingErrorDetails = (error) => {
  const description = error?.response?.body?.description || error?.message || String(error);
  const statusCode = error?.response?.statusCode || error?.response?.body?.error_code || null;

  return {
    code: error?.code || '',
    statusCode,
    description,
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

const isTransientPollingError = ({ code, statusCode, description }) => {
  const numericStatusCode = Number(statusCode);

  return (
    (Number.isFinite(numericStatusCode) && numericStatusCode >= 500 && numericStatusCode < 600) ||
    /bad gateway|gateway timeout|service unavailable|internal server error|timeout|econnreset|etimedout|socket hang up/i
      .test(`${code || ''} ${description || ''}`)
  );
};

const createPollingErrorHandler = ({
  logThrottleMs = 60_000,
  logger = console,
  now = () => Date.now(),
  record = recordTelegramPollingError,
} = {}) => {
  let lastTransientLogAt = null;
  let suppressedTransientErrors = 0;

  return (error) => {
    const details = getPollingErrorDetails(error);
    record(details);

    if (isPollingConflict(details)) {
      logger.error('Telegram polling conflict: another bot instance is already running with this token.');
      return;
    }

    if (isTransientPollingError(details)) {
      const currentTime = now();
      const shouldLog = lastTransientLogAt === null ||
        logThrottleMs === 0 ||
        currentTime - lastTransientLogAt >= logThrottleMs;

      if (shouldLog) {
        const suppressedText = suppressedTransientErrors > 0 ?
          ` (${suppressedTransientErrors} similar polling error${suppressedTransientErrors === 1 ? '' : 's'} suppressed)` :
          '';

        logger.warn(`Telegram polling transient error: ${details.description}${suppressedText}`);
        lastTransientLogAt = currentTime;
        suppressedTransientErrors = 0;
      } else {
        suppressedTransientErrors += 1;
      }

      return;
    }

    logger.error('Telegram Polling Error:', details.description);
  };
};

module.exports = {
  createPollingErrorHandler,
  getPollingErrorDetails,
  isPollingConflict,
  isTransientPollingError,
};
