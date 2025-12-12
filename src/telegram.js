require('dotenv').config();
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const sendTelegramMessage = async (text) => {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_TOKEN or CHAT_ID missing in .env');
    return;
  }
  try {
    await axios.post(`${TELEGRAM_BASE}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    console.log('sent message');
  } catch (err) {
    console.error('telegram send error', err.message);
  }
};

module.exports = { sendTelegramMessage };
