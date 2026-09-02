const buildTelegramBotOptions = (telegramConfig) => ({
  polling: telegramConfig.polling ? {
    interval: telegramConfig.pollingIntervalMs,
    params: {
      timeout: telegramConfig.pollingTimeoutSeconds,
    },
  } : false,
  request: {
    agentOptions: {
      family: 4,
    },
  },
});

module.exports = { buildTelegramBotOptions };
