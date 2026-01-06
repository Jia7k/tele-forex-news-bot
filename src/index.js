require('dotenv').config();
// --- DUMMY SERVER FOR RENDER ---
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));
// -------------------------------

const { fetchCalendar } = require('./scraper');
const { parseTimeText, formatEventMessage } = require('./utils');
const { sendTelegramMessage, bot } = require('./telegram'); 
const store = require('./store');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const readline = require('readline');

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

    // Weekend Logic (Same as before)
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
const performSystemCheck = async () => {
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
    return moment(dateObj).isBetween(startOfTarget, endOfTarget);
  });

  await sendTelegramMessage(`🛠 <b>System Check</b>\nStatus: 🟢 Online\nTime: ${now.format('HH:mm:ss')}\nMode: ${isWeekend ? 'Weekend' : 'Weekday'}`);

  if (targetEvents.length === 0) {
    await sendTelegramMessage(`No events found for ${displayTitle}.`);
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
  
  // Note: For alerts, we only care about TODAY's actual events.
  // We do NOT use the Weekend Logic here, because there are no alerts on weekends.
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

  // REMOVED: "Schedule Summary" block (It is now handled by scheduleDailySummary)

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
      schedule.scheduleJob(jobName, scrapeTime.toDate(), async () => {
        try {
          const freshEvents = await fetchCalendar(dateQuery);
          let resultMsg = `✅ <b>News Released:</b>\n`;
          for (const oldEv of groupEvents) {
            const freshEv = freshEvents.find(f => (f.id && f.id === oldEv.id) || (f.eventName === oldEv.eventName));
            resultMsg += formatEventMessage(freshEv || oldEv) + '\n';
          }
          await sendTelegramMessage(resultMsg);
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
  
  bot.on('message', async (msg) => {
    const text = msg.text ? msg.text.toLowerCase().trim() : '';
    if (text === 'check') {
      console.log(`Received 'check' command from ${msg.chat.username}`);
      await bot.sendMessage(msg.chat.id, "🔍 Checking status... please wait.");
      await performSystemCheck();
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', async (input) => {
    if (input.trim().toLowerCase() === 'check') {
      console.log('Manual terminal check...');
      await performSystemCheck();
    }
  });

})();