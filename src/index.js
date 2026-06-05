require('dotenv').config();

// --- IMPORTS ---
const express = require('express');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const readline = require('readline');

const { fetchCalendar } = require('./scraper');
const { parseTimeText, formatEventMessage, generateChartUrl } = require('./utils');
const { sendTelegramMessage, sendTelegramPhoto, bot } = require('./telegram'); 
const store = require('./store');

// --- DUMMY SERVER FOR RENDER ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));
// -------------------------------

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';
const SCRAPE_DELAY_MINUTES = 2; 
const WARNING_MINUTES = 10;
const SUMMARY_HOUR = 6; 

// --- 1. INDEPENDENT DAILY SUMMARY JOB (Runs at 6:00 AM) ---
const scheduleDailySummary = () => {
  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = SUMMARY_HOUR; // 6
  rule.minute = 0;
  rule.second = 0;

  console.log(`📅 Daily Summary job initialized for ${SUMMARY_HOUR}:00 ${TARGET_TZ}`);

  schedule.scheduleJob(rule, async () => {
    console.log('⏰ 6:00 AM Trigger: Fetching Daily Summary...');
    const now = moment.tz(TARGET_TZ);

    // Weekend Logic
    const dayOfWeek = now.day();
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    let targetDate = now.clone();
    let displayTitle = now.format('DD MMM');

    if (isWeekend) {
      const daysToAdd = dayOfWeek === 6 ? 2 : 1;
      targetDate = now.clone().add(daysToAdd, 'days');
      displayTitle = `Monday ${targetDate.format('DD MMM')} (Advance View)`;
    }

    // Explicit Date Query
    const dateQuery = targetDate.format('MMMD.YYYY').toLowerCase();
    const events = await fetchCalendar(dateQuery);

    // Filter for Target Date
    const startOfTarget = targetDate.clone().startOf('day');
    const endOfTarget = targetDate.clone().endOf('day');
    const targetEvents = events.filter(ev => {
      const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
      if (!dateObj) return false;
      return moment(dateObj).isBetween(startOfTarget, endOfTarget);
    });

    // Send Message
    if (targetEvents.length === 0) {
      await sendTelegramMessage(`📅 <b>${displayTitle}:</b>\nNo significant events found.`);
    } else {
      const sortedEvents = [...targetEvents].sort((a, b) => {
        const tA = parseTimeText(a.dateStr, a.timeText, a.year);
        const tB = parseTimeText(b.dateStr, b.timeText, b.year);
        return tA - tB;
      });

      let digestMsg = `🌅 <b>${displayTitle}:</b>\n\n`;

      sortedEvents.forEach(ev => {
          let icon = '⚪️';
          if(ev.impact === 'High') icon = '🔴';
          if(ev.impact === 'Medium') icon = '🟠';
          if(ev.impact === 'Low') icon = '🟡';
          
          // Vertical Stack Format for Summary
          digestMsg += `<b>${ev.timeText} ${icon} ${ev.currency} - ${ev.eventName}</b>\n`;
          digestMsg += `├ Fcst: ${ev.forecast || '--'}\n`;
          digestMsg += `└ Prev: ${ev.previous || '--'}\n\n`;
      });

      if (digestMsg.length > 4000) {
        const mid = Math.floor(digestMsg.length / 2);
        await sendTelegramMessage(digestMsg.substring(0, mid));
        await sendTelegramMessage(digestMsg.substring(mid));
      } else {
        await sendTelegramMessage(digestMsg);
      }
      console.log('✅ Daily Summary Sent.');
    }
  });
};

const groupEventsByTime = (events) => {
  const groups = {};
  events.forEach(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return;
    const key = dateObj.toISOString();
    if (!groups[key]) groups[key] = [];
    groups[key].push(ev);
  });
  return groups;
};

// --- CORE FUNCTION: Run Check Logic ---
const performSystemCheck = async (filterType = 'filter_all') => {
  const now = moment.tz(TARGET_TZ);
  
  const dayOfWeek = now.day();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  let targetDate = now.clone();
  let displayTitle = now.format('DD MMM');

  if (isWeekend) {
    const daysToAdd = dayOfWeek === 6 ? 2 : 1;
    targetDate = now.clone().add(daysToAdd, 'days');
    displayTitle = `Monday ${targetDate.format('DD MMM')} (Advance View)`;
  }

  const dateQuery = targetDate.format('MMMD.YYYY').toLowerCase();
  console.log(`[Check] Fetching data for ${targetDate.format('YYYY-MM-DD')} (Query: ${dateQuery})...`);
  
  const events = await fetchCalendar(dateQuery);
  
  const startOfTarget = targetDate.clone().startOf('day');
  const endOfTarget = targetDate.clone().endOf('day');
  
  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    
    // Time check
    const isToday = moment(dateObj).isBetween(startOfTarget, endOfTarget);
    if (!isToday) return false;

    // Filter check based on the button pressed
    if (filterType === 'filter_high') return ev.impact === 'High';
    if (filterType === 'filter_medium') return ev.impact === 'High' || ev.impact === 'Medium';
    
    return true; // filter_all
  });

  let filterLabel = 'All Events';
  if (filterType === 'filter_high') filterLabel = 'High Impact Only';
  if (filterType === 'filter_medium') filterLabel = 'High & Medium Impact';

  await sendTelegramMessage(`🛠 <b>System Check (${filterLabel})</b>\nStatus: 🟢 Online\nTime: ${now.format('HH:mm:ss')}\nMode: ${isWeekend ? 'Weekend' : 'Weekday'}`);

  if (targetEvents.length === 0) {
    await sendTelegramMessage(`No ${filterLabel.toLowerCase()} found for ${displayTitle}.`);
  } else {
    const sortedEvents = [...targetEvents].sort((a, b) => {
      const tA = parseTimeText(a.dateStr, a.timeText, a.year);
      const tB = parseTimeText(b.dateStr, b.timeText, b.year);
      return tA - tB;
    });

    let detailedMsg = `📋 <b>Detailed Report (${displayTitle}):</b>\n\n`;

    for (const ev of sortedEvents) {
      let icon = '⚪️';
      if (ev.impact === 'High') icon = '🔴';
      if (ev.impact === 'Medium') icon = '🟠';
      if (ev.impact === 'Low') icon = '🟡';

      detailedMsg += `<b>${ev.timeText} ${icon} ${ev.currency} - ${ev.eventName}</b>\n`;
      detailedMsg += `├ Act: ${ev.actual || '--'}\n`;
      detailedMsg += `├ Fcst: ${ev.forecast || '--'}\n`;
      detailedMsg += `└ Prev: ${ev.previous || '--'}\n\n`;
    }

    if (detailedMsg.length > 4000) {
      const mid = Math.floor(detailedMsg.length / 2);
      await sendTelegramMessage(detailedMsg.substring(0, mid));
      await sendTelegramMessage(detailedMsg.substring(mid));
    } else {
      await sendTelegramMessage(detailedMsg);
    }
  }
  console.log('[Check] Complete.');
};

// --- Main Schedule Logic (FOR ALERTS ONLY) ---
const loadAndSchedule = async () => {
  console.log('--- Starting Load Cycle (Alerts Only) ---');
  
  const now = moment.tz(TARGET_TZ);
  
  const dateQuery = now.format('MMMD.YYYY').toLowerCase();

  const events = await fetchCalendar(dateQuery);
  if (!events || events.length === 0) {
      console.log('No events found to schedule alerts for.');
      return;
  }

  const startOfTarget = now.clone().startOf('day');
  const endOfTarget = now.clone().endOf('day');

  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    const eventTime = moment(dateObj);
    return eventTime.isBetween(startOfTarget, endOfTarget);
  });

  console.log(`Found ${targetEvents.length} events for alerts.`);

  // 1. Schedule Alerts (Warnings & Results)
  const eventsByTime = groupEventsByTime(targetEvents);
  for (const [timeKey, groupEvents] of Object.entries(eventsByTime)) {
    const eventTime = moment(timeKey);
    const warningTime = eventTime.clone().subtract(WARNING_MINUTES, 'minutes');
    
    if (warningTime.isAfter(now)) {
      schedule.scheduleJob(warningTime.toDate(), async () => {
        let msg = `⚠️ <b>${WARNING_MINUTES} Minutes to Release:</b>\n`;
        groupEvents.forEach(ev => msg += formatEventMessage(ev) + '\n');
        await sendTelegramMessage(msg);
      });
      console.log(`   -> Warning set for ${warningTime.format('DD MMM HH:mm')}`);
    }

    const scrapeTime = eventTime.clone().add(SCRAPE_DELAY_MINUTES, 'minutes');
    if (scrapeTime.isAfter(now)) {
      const jobName = `result-${timeKey}`;
      if (schedule.scheduledJobs[jobName]) continue;
      
      // THIS IS THE UPDATED BLOCK WITH CHART LOGIC
      schedule.scheduleJob(jobName, scrapeTime.toDate(), async () => {
        try {
          const freshEvents = await fetchCalendar(dateQuery);
          
          for (const oldEv of groupEvents) {
            const freshEv = freshEvents.find(f => (f.id && f.id === oldEv.id) || (f.eventName === oldEv.eventName));
            const targetEv = freshEv || oldEv;
            
            let resultMsg = `✅ <b>News Released:</b>\n`;
            resultMsg += formatEventMessage(targetEv);

            const chartUrl = generateChartUrl(targetEv);

            if (chartUrl) {
              // Send the message as an image caption if a chart was generated
              await sendTelegramPhoto(chartUrl, resultMsg);
            } else {
              // Fallback to text if there's no data to chart
              await sendTelegramMessage(resultMsg);
            }
          }
        } catch (err) { console.error(err); }
      });
      console.log(`   -> Result set for ${scrapeTime.format('DD MMM HH:mm')}`);
    }
  }
};

(async () => {
  console.log(`Bot starting up in ${TARGET_TZ}...`);

  const shutdown = () => {
    console.log('🛑 Received shutdown signal. Closing bot...');
    bot.stopPolling();
    schedule.gracefulShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 1. Initialize the 6 AM Job immediately
  scheduleDailySummary();

  // 2. Load today's alerts
  await loadAndSchedule();

  // 3. Set up Midnight Reload (to refresh alerts for the new day)
  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = 0;
  rule.minute = 1;
  schedule.scheduleJob(rule, async () => {
    console.log('Midnight reload...');
    await loadAndSchedule();
  });

  console.log("👂 Listening for 'check' on Telegram...");
  
  // 1. Listen for the 'check' command and send the button menu
  bot.on('message', async (msg) => {
    const text = msg.text ? msg.text.toLowerCase().trim() : '';
    if (text === 'check') {
      console.log(`Received 'check' command from ${msg.chat.username}`);
      
      const options = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔴 High Impact', callback_data: 'filter_high' },
              { text: '🟠 Medium & Up', callback_data: 'filter_medium' }
            ],
            [
              { text: '📋 All Events', callback_data: 'filter_all' }
            ]
          ]
        },
        parse_mode: 'HTML'
      };

      await bot.sendMessage(msg.chat.id, "🔍 <b>Select the impact level you want to check:</b>", options);
    }
  });

  // 2. Listen for the button clicks
  bot.on('callback_query', async (query) => {
    const data = query.data; // This will be 'filter_high', 'filter_medium', or 'filter_all'
    
    await bot.answerCallbackQuery(query.id);
    
    let filterText = 'All Events';
    if (data === 'filter_high') filterText = 'High Impact Only';
    if (data === 'filter_medium') filterText = 'High & Medium Impact';
    
    await bot.editMessageText(`🔍 Checking status for: <b>${filterText}</b>...`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: 'HTML'
    });

    await performSystemCheck(data);
  });
})();