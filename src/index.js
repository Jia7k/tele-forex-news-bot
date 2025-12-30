
// --- ADD THIS TO THE VERY TOP OF src/index.js ---
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running!'));

app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
});
// ------------------------------------------------

require('dotenv').config();
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

// --- Helper: Sort and Send the Digest ---
const sendDailyDigest = async (events, dateTitle) => {
  if (!events || events.length === 0) {
    await sendTelegramMessage(`📅 <b>${dateTitle}:</b>\nNo significant events found.`);
    return;
  }

  let digestMsg = `🌅 <b>${dateTitle}:</b>\n\n`;
  
  const sortedEvents = [...events].sort((a, b) => {
    const tA = parseTimeText(a.dateStr, a.timeText, a.year);
    const tB = parseTimeText(b.dateStr, b.timeText, b.year);
    return tA - tB;
  });

  sortedEvents.forEach(ev => {
      let icon = '⚪️';
      if(ev.impact === 'High') icon = '🔴';
      if(ev.impact === 'Medium') icon = '🟠';
      if(ev.impact === 'Low') icon = '🟡';
      
      digestMsg += `${ev.timeText} ${icon} ${ev.currency} ${ev.eventName}\n`;
  });

  if (digestMsg.length > 4000) {
    const mid = Math.floor(digestMsg.length / 2);
    await sendTelegramMessage(digestMsg.substring(0, mid));
    await sendTelegramMessage(digestMsg.substring(mid));
  } else {
    await sendTelegramMessage(digestMsg);
  }
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
// --- CORE FUNCTION: Run Check Logic ---
const performSystemCheck = async () => {
  const now = moment.tz(TARGET_TZ);
  
  // 1. Weekend Logic
  const dayOfWeek = now.day();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  let targetDate = now.clone();
  let dateQuery = ''; 
  let displayTitle = now.format('DD MMM');

  if (isWeekend) {
    const daysToAdd = dayOfWeek === 6 ? 2 : 1;
    targetDate = now.clone().add(daysToAdd, 'days');
    dateQuery = targetDate.format('MMMD.YYYY').toLowerCase();
    displayTitle = `Monday ${targetDate.format('DD MMM')} (Advance View)`;
  }

  console.log(`[Check] Fetching data for ${targetDate.format('YYYY-MM-DD')}...`);
  
  // 2. Fetch
  const events = await fetchCalendar(dateQuery);
  
  // 3. Filter for Target Date
  const startOfTarget = targetDate.clone().startOf('day');
  const endOfTarget = targetDate.clone().endOf('day');
  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    return moment(dateObj).isBetween(startOfTarget, endOfTarget);
  });

  // 4. Send Status Message
  await sendTelegramMessage(`🛠 <b>System Check</b>\nStatus: 🟢 Online\nTime: ${now.format('HH:mm:ss')}\nMode: ${isWeekend ? 'Weekend' : 'Weekday'}`);

  // 5. Send Detailed News Report
  if (targetEvents.length === 0) {
    await sendTelegramMessage(`No events found for ${displayTitle}.`);
  } else {
    // Sort events by time
    const sortedEvents = [...targetEvents].sort((a, b) => {
      const tA = parseTimeText(a.dateStr, a.timeText, a.year);
      const tB = parseTimeText(b.dateStr, b.timeText, b.year);
      return tA - tB;
    });

    let detailedMsg = `📋 <b>Detailed Report (${displayTitle}):</b>\n`;

    // Loop through and format using the "Vertical Stack" style
    for (const ev of sortedEvents) {
      detailedMsg += formatEventMessage(ev) + '\n';
    }

    // Split message if it exceeds Telegram's 4096 char limit
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

// --- Main Schedule Logic ---
const loadAndSchedule = async () => {
  console.log('--- Starting Load Cycle ---');
  
  const now = moment.tz(TARGET_TZ);
  const dayOfWeek = now.day();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  let targetDate = now.clone();
  let dateQuery = ''; 
  let displayTitle = `Daily Summary (${now.format('DD MMM')})`;

  if (isWeekend) {
    const daysToAdd = dayOfWeek === 6 ? 2 : 1;
    targetDate = now.clone().add(daysToAdd, 'days');
    dateQuery = targetDate.format('MMMD.YYYY').toLowerCase();
    displayTitle = `Monday's Schedule (Advance View - ${targetDate.format('DD MMM')})`;
    console.log(`Weekend detected. Switching target to Monday.`);
  }

  const events = await fetchCalendar(dateQuery);
  if (!events || events.length === 0) return;

  const startOfTarget = targetDate.clone().startOf('day');
  const endOfTarget = targetDate.clone().endOf('day');

  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    const eventTime = moment(dateObj);
    return eventTime.isBetween(startOfTarget, endOfTarget);
  });

  console.log(`Found ${targetEvents.length} events.`);

  // 1. Schedule Summary (06:00 AM)
  const summaryTime = now.clone().hour(SUMMARY_HOUR).minute(0).second(0);
  if (targetEvents.length > 0 && summaryTime.isAfter(now)) {
      console.log(`📅 Summary scheduled for ${summaryTime.format('HH:mm:ss')}`);
      schedule.scheduleJob(summaryTime.toDate(), async () => {
        await sendDailyDigest(targetEvents, displayTitle);
      });
  }

  // 2. Schedule Alerts
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

  // --- NEW: STARTUP MESSAGE ---
  await sendTelegramMessage("🤖 <b>Bot is now online.</b> Waiting for news...");
  // -----------------------------

  await loadAndSchedule();

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

// --- SHUTDOWN HANDLER (Fixes 409 Conflict) ---
const shutdown = () => {
  console.log('🛑 Received shutdown signal. Closing bot...');
  
  // 1. Stop listening to Telegram (polling)
  bot.stopPolling();
  
  // 2. Kill the schedule jobs
  schedule.gracefulShutdown();
  
  // 3. Close the Express server (if you want to be thorough, though optional here)
  
  console.log('✅ Bot shut down gracefully.');
  process.exit(0);
};

// Listen for the "SIGTERM" signal from Render
process.on('SIGTERM', shutdown);
// Listen for "SIGINT" (Ctrl+C on local)
process.on('SIGINT', shutdown);