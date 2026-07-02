require('dotenv').config({ quiet: true });
const TelegramBot = require('node-telegram-bot-api');

const { config } = require('./config');

const bot = new TelegramBot(config.telegram.token, {
  polling: config.telegram.polling,
  request: {
    agentOptions: {
      family: 4
    }
  }
});

bot.on('polling_error', (error) => {
  const description = error.response?.body?.description || error.message || String(error);

  if (error.code === 'ETELEGRAM' && description.includes('409')) {
    console.error('Telegram polling conflict: another bot instance is already running with this token.');
    return;
  }

  console.error('Telegram Polling Error:', description);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendWithRetries = async (label, operation) => {
  for (let attempt = 0; attempt <= config.telegram.sendRetryAttempts; attempt += 1) {
    try {
      await operation();
      return true;
    } catch (error) {
      const isFinalAttempt = attempt === config.telegram.sendRetryAttempts;
      const attemptLabel = `${attempt + 1}/${config.telegram.sendRetryAttempts + 1}`;
      console.error(`${label} Error (${attemptLabel}):`, error.message);

      if (isFinalAttempt) return false;
      await delay(config.telegram.sendRetryDelaySeconds * 1000);
    }
  }

  return false;
};

const sendTelegramMessage = async (text, targetChatId = config.telegram.chatId) => {
  const recipient = targetChatId ?? config.telegram.chatId;
  if (!recipient) {
    console.error('CHAT_ID missing in .env');
    return false;
  }
  return sendWithRetries('Telegram Send', () => (
    bot.sendMessage(recipient, text, { parse_mode: 'HTML' })
  ));
};

const sendTelegramPhoto = async (photoUrl, captionText, targetChatId = config.telegram.chatId) => {
  const recipient = targetChatId ?? config.telegram.chatId;
  if (!recipient) {
    console.error('CHAT_ID missing in .env');
    return false;
  }
  return sendWithRetries('Telegram Photo Send', () => (
    bot.sendPhoto(recipient, photoUrl, { caption: captionText, parse_mode: 'HTML' })
  ));
};

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

module.exports = { sendTelegramMessage, sendTelegramPhoto, registerTelegramWebhook, bot };
