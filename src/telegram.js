require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// Make sure your .env has TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;

// 1. Initialize the Bot with Polling enabled
const bot = new TelegramBot(token, { 
  polling: true,
  request: {
    agentOptions: {
      family: 4 // This forces IPv4 and fixes the EFATAL AggregateError
    }
  }
});// 2. Helper function to send messages (used by your scraper logic)
const sendTelegramMessage = async (text) => {
  if (!chatId) {
    console.error('CHAT_ID missing in .env');
    return;
  }
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Telegram Send Error:', error.message);
  }
};
// Add this under your existing sendTelegramMessage function

const sendTelegramPhoto = async (photoUrl, captionText) => {
  if (!chatId) {
    console.error('CHAT_ID missing in .env');
    return;
  }
  try {
    await bot.sendPhoto(chatId, photoUrl, { caption: captionText, parse_mode: 'HTML' });
  } catch (error) {
    console.error('Telegram Photo Send Error:', error.message);
  }
};

// Export the new function
module.exports = { sendTelegramMessage, sendTelegramPhoto, bot };