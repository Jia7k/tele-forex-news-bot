require('dotenv').config({ quiet: true });
const TelegramBot = require('node-telegram-bot-api');

const { config } = require('./config');
const { buildTelegramBotOptions } = require('./telegramOptions');
const { createPollingErrorHandler } = require('./telegramPollingErrors');
const { createTelegramTransport, splitTelegramHtml } = require('./telegramTransport');

const bot = new TelegramBot(config.telegram.token, buildTelegramBotOptions(config.telegram));

bot.on('polling_error', createPollingErrorHandler({
  logThrottleMs: config.telegram.pollingErrorLogThrottleSeconds * 1000,
}));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const transport = createTelegramTransport({ bot, config: config.telegram, delay, logger: console });

const registerTelegramWebhook = async (app) => {
  if (config.telegram.mode !== 'webhook') return false;

  app.post(config.telegram.webhookPath, (req, res) => {
    if (
      config.telegram.webhookSecretToken &&
      req.header('x-telegram-bot-api-secret-token') !== config.telegram.webhookSecretToken
    ) {
      res.sendStatus(401);
      return;
    }

    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  const webhookOptions = config.telegram.webhookSecretToken ?
    { secret_token: config.telegram.webhookSecretToken } :
    undefined;

  await bot.setWebHook(config.telegram.webhookUrl, webhookOptions);
  console.log(`Telegram webhook registered at ${config.telegram.webhookPath}`);
  return true;
};

module.exports = { ...transport, splitTelegramHtml, registerTelegramWebhook, bot };
