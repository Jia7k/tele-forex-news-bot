require('dotenv').config({ quiet: true });

const moment = require('moment-timezone');

const parseInteger = (name, fallback, { min, max } = {}) => {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === '' ? fallback : Number(rawValue);

  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be at least ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be at most ${max}`);
  }

  return value;
};

const parseChatIds = (value) => String(value || '')
  .split(',')
  .map((chatId) => chatId.trim())
  .filter(Boolean);

const parseList = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const parseBoolean = (name, fallback) => {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return fallback;

  const normalizedValue = rawValue.toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) return false;

  throw new Error(`${name} must be true or false`);
};

const parseTelegramMode = () => {
  const rawMode = process.env.TELEGRAM_MODE;
  if (rawMode) {
    const mode = rawMode.toLowerCase().trim();
    if (['polling', 'webhook', 'disabled'].includes(mode)) return mode;
    throw new Error('TELEGRAM_MODE must be polling, webhook, or disabled');
  }

  return parseBoolean('TELEGRAM_POLLING', true) ? 'polling' : 'disabled';
};

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
const targetTz = process.env.TARGET_TZ || 'Asia/Singapore';
const allowedChatIds = parseChatIds(process.env.ALLOWED_CHAT_IDS || chatId);
const telegramMode = parseTelegramMode();

const config = {
  baseUrl: process.env.BASE_URL || 'https://www.forexfactory.com',
  port: parseInteger('PORT', 3000, { min: 1, max: 65535 }),
  targetTz,
  scrapeDelayMinutes: parseInteger('SCRAPE_DELAY_MINUTES', 1, { min: 0 }),
  resultRetryAttempts: parseInteger('RESULT_RETRY_ATTEMPTS', 20, { min: 0 }),
  resultRetryDelaySeconds: parseInteger('RESULT_RETRY_DELAY_SECONDS', 30, { min: 1 }),
  warningMinutes: parseInteger('WARNING_MINUTES', 10, { min: 0 }),
  summaryHour: parseInteger('SUMMARY_HOUR', 6, { min: 0, max: 23 }),
  rescheduleIntervalMinutes: parseInteger('RESCHEDULE_INTERVAL_MINUTES', 30, { min: 0 }),
  telegramMessageChunkSize: parseInteger('TELEGRAM_MESSAGE_CHUNK_SIZE', 3800, { min: 1000, max: 4096 }),
  summaryFilters: {
    currencies: parseList(process.env.SUMMARY_CURRENCIES || ''),
    impacts: parseList(process.env.SUMMARY_IMPACTS || ''),
  },
  alertFilters: {
    currencies: parseList(process.env.ALERT_CURRENCIES || process.env.CURRENCIES || ''),
    impacts: parseList(process.env.ALERT_IMPACTS || process.env.IMPACTS || ''),
  },
  telegram: {
    token,
    chatId,
    allowedChatIds,
    mode: telegramMode,
    polling: telegramMode === 'polling',
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || '',
    webhookPath: process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook',
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    sendRetryAttempts: parseInteger('TELEGRAM_SEND_RETRY_ATTEMPTS', 2, { min: 0 }),
    sendRetryDelaySeconds: parseInteger('TELEGRAM_SEND_RETRY_DELAY_SECONDS', 2, { min: 1 }),
  },
};

const validateConfig = () => {
  const missing = [];

  if (!config.telegram.token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegram.chatId) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  if (!moment.tz.zone(config.targetTz)) {
    throw new Error(`TARGET_TZ is not a valid IANA timezone: ${config.targetTz}`);
  }

  if (config.telegram.allowedChatIds.length === 0) {
    throw new Error('No allowed Telegram chats configured');
  }

  if (!config.telegram.webhookPath.startsWith('/')) {
    throw new Error('TELEGRAM_WEBHOOK_PATH must start with /');
  }

  if (config.telegram.mode === 'webhook' && !config.telegram.webhookUrl) {
    throw new Error('TELEGRAM_WEBHOOK_URL is required when TELEGRAM_MODE=webhook');
  }
};

const isAllowedChatId = (chatIdToCheck) => (
  config.telegram.allowedChatIds.includes(String(chatIdToCheck))
);

module.exports = {
  config,
  validateConfig,
  isAllowedChatId,
  parseBoolean,
  parseChatIds,
  parseList,
  parseTelegramMode,
};
