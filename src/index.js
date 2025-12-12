require('dotenv').config();
const { fetchCalendar } = require('./scraper');
const { parseTimeText, formatEventMessage } = require('./utils');
const { sendTelegramMessage } = require('./telegram');
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
  
  // Sort events by time
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

  // Split message if too long
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

const loadAndSchedule = async () => {
  console.log('--- Starting Load Cycle ---');
  
  const now = moment.tz(TARGET_TZ);
  const dayOfWeek = now.day(); // 0=Sun, 6=Sat
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  let targetDate = now.clone();
  let dateQuery = ''; // empty = default current week
  let displayTitle = `Daily Summary (${now.format('DD MMM')})`;

  // --- WEEKEND LOGIC: Switch to Monday ---
  if (isWeekend) {
    // If Sat(6), add 2 days. If Sun(0), add 1 day.
    const daysToAdd = dayOfWeek === 6 ? 2 : 1;
    targetDate = now.clone().add(daysToAdd, 'days');
    
    // Format for ForexFactory URL: 'mmmd.yyyy' e.g. 'dec15.2025' (lowercase)
    dateQuery = targetDate.format('MMMD.YYYY').toLowerCase();
    displayTitle = `Monday's Schedule (Advance View - ${targetDate.format('DD MMM')})`;
    
    console.log(`Weekend detected. Switching target to Monday: ${targetDate.format('YYYY-MM-DD')} (Query: ${dateQuery})`);
  }
  // ----------------------------------------

  // Fetch with the specific date query (if weekend) or default (if weekday)
  const events = await fetchCalendar(dateQuery);
  
  if (!events || events.length === 0) {
    console.log('No events fetched.');
    return;
  }

  // Define Filter Boundaries for the TARGET DATE
  const startOfTarget = targetDate.clone().startOf('day');
  const endOfTarget = targetDate.clone().endOf('day');

  // Filter events
  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    const eventTime = moment(dateObj);
    return eventTime.isBetween(startOfTarget, endOfTarget);
  });

  console.log(`Found ${targetEvents.length} events for ${targetDate.format('YYYY-MM-DD')}.`);

  // 1. Schedule Summary (06:00 AM)
  // If it's the weekend, we probably want to send this summary NOW or at 6am today
  // so the user knows what's coming Monday.
  const summaryTime = now.clone().hour(SUMMARY_HOUR).minute(0).second(0);
  
  if (targetEvents.length > 0) {
    // Check if we haven't passed 6am yet (or if we are testing)
    if (summaryTime.isAfter(now)) {
      console.log(`📅 Summary scheduled for ${summaryTime.format('HH:mm:ss')}`);
      schedule.scheduleJob(summaryTime.toDate(), async () => {
        await sendDailyDigest(targetEvents, displayTitle);
        console.log('Sent scheduled summary.');
      });
    } else {
        // If it's a Weekend and past 6am, maybe we want to force send it?
        // For now, standard logic: if missed 6am, skip until next reload.
        console.log('Past 6:00 AM. Summary skipped (will trigger on next midnight reload).');
    }
  } 

  // 2. Schedule Warnings & Results
  // Note: If today is Saturday, these jobs will be scheduled for MONDAY.
  // Node-schedule handles future dates perfectly.
  const eventsByTime = groupEventsByTime(targetEvents);

  for (const [timeKey, groupEvents] of Object.entries(eventsByTime)) {
    const eventTime = moment(timeKey);
    
    // Warning (10 mins before)
    const warningTime = eventTime.clone().subtract(WARNING_MINUTES, 'minutes');
    
    // Only schedule if the warning time is in the future
    if (warningTime.isAfter(now)) {
      schedule.scheduleJob(warningTime.toDate(), async () => {
        let msg = `⚠️ <b>${WARNING_MINUTES} Minutes to Release:</b>\n`;
        groupEvents.forEach(ev => {
            msg += formatEventMessage(ev) + '\n';
        });
        await sendTelegramMessage(msg);
        console.log(`Sent warning for ${eventTime.format('DD MMM HH:mm')}`);
      });
      console.log(`   -> Warning set for ${warningTime.format('DD MMM HH:mm')}`);
    }

    // Result (2 mins after)
    const scrapeTime = eventTime.clone().add(SCRAPE_DELAY_MINUTES, 'minutes');
    
    if (scrapeTime.isAfter(now)) {
      const jobName = `result-${timeKey}`;
      if (schedule.scheduledJobs[jobName]) continue;

      schedule.scheduleJob(jobName, scrapeTime.toDate(), async () => {
        console.log(`\nFetching Actual values for ${eventTime.format('HH:mm')}...`);
        try {
          // IMPORTANT: Re-fetch specifically for that day (or Monday)
          const freshEvents = await fetchCalendar(dateQuery);
          
          let resultMsg = `✅ <b>News Released:</b>\n`;

          for (const oldEv of groupEvents) {
            const freshEv = freshEvents.find(f => 
              (f.id && f.id === oldEv.id) || 
              (f.eventName === oldEv.eventName && f.currency === oldEv.currency)
            );
            const eventToSend = freshEv || oldEv;
            resultMsg += formatEventMessage(eventToSend) + '\n';
            store.markSent(eventToSend.id || `${eventToSend.eventName}-${eventToSend.timeText}`);
          }
          await sendTelegramMessage(resultMsg);
          console.log(`Sent results for ${eventTime.format('HH:mm')}`);

        } catch (err) {
          console.error('Error fetching results:', err);
        }
      });
      console.log(`   -> Result scrape set for ${scrapeTime.format('DD MMM HH:mm')}`);
    }
  }

  store.setLastFetch(new Date().toISOString());
};

// --- Main Execution ---
(async () => {
  console.log(`Bot starting up in ${TARGET_TZ}...`);
  await loadAndSchedule();

  // Reload at midnight
  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = 0;
  rule.minute = 1;
  schedule.scheduleJob(rule, async () => {
    console.log('Midnight reload...');
    await loadAndSchedule();
  });

  // --- INTERACTIVE CHECK ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  console.log("👉 Type 'check' to test.");

  rl.on('line', async (input) => {
    if (input.trim().toLowerCase() === 'check') {
      console.log('\n🔎 Manual check initiated...');
      const now = moment.tz(TARGET_TZ);
      
      // We run the exact same logic as loadAndSchedule but force the "Send Digest" part
      // 1. Detect Weekend logic again for the check
      const dayOfWeek = now.day();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      let targetDate = now.clone();
      let dateQuery = ''; 
      let displayTitle = `Daily Summary (${now.format('DD MMM')})`;

      if (isWeekend) {
        const daysToAdd = dayOfWeek === 6 ? 2 : 1;
        targetDate = now.clone().add(daysToAdd, 'days');
        dateQuery = targetDate.format('MMMD.YYYY').toLowerCase();
        displayTitle = `Monday's Schedule (Advance View)`;
      }

      console.log(`Fetching data for ${targetDate.format('YYYY-MM-DD')}...`);
      const events = await fetchCalendar(dateQuery);
      
      const startOfTarget = targetDate.clone().startOf('day');
      const endOfTarget = targetDate.clone().endOf('day');

      const targetEvents = events.filter(ev => {
        const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
        if (!dateObj) return false;
        return moment(dateObj).isBetween(startOfTarget, endOfTarget);
      });

      await sendTelegramMessage(`🛠 <b>System Check</b>\nStatus: 🟢 Online\nMode: ${isWeekend ? 'Weekend (Targeting Monday)' : 'Weekday'}`);
      await sendDailyDigest(targetEvents, displayTitle);
      console.log('Manual check complete.\n');
    }
  });

})();