require('dotenv').config();
const { fetchCalendar } = require('./scraper');
const { parseTimeText, formatEventMessage } = require('./utils');
const { sendTelegramMessage } = require('./telegram');
const store = require('./store');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';
const SCRAPE_DELAY_MINUTES = 2; 
const WARNING_MINUTES = 10;
const SUMMARY_HOUR = 6; // Hour to send daily summary (0-23)

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
  const events = await fetchCalendar();
  
  if (!events || events.length === 0) {
    console.log('No events fetched.');
    return;
  }

  const now = moment.tz(TARGET_TZ);
  const startOfToday = now.clone().startOf('day');
  const endOfToday = now.clone().endOf('day');

  // Filter for TODAY only
  const todaysEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    const eventTime = moment(dateObj);
    return eventTime.isBetween(startOfToday, endOfToday);
  });

  console.log(`Found ${todaysEvents.length} events for today.`);

  // ---------------------------------------------------------
  // REQUIREMENT 1: Daily Summary at 06:00 AM
  // ---------------------------------------------------------
  const summaryTime = now.clone().hour(SUMMARY_HOUR).minute(0).second(0);
  
  if (todaysEvents.length > 0) {
    // Only schedule if 6am is in the future (e.g. it's currently 00:01)
    if (summaryTime.isAfter(now)) {
      console.log(`📅 Daily Summary scheduled for ${summaryTime.format('HH:mm:ss')}`);
      
      schedule.scheduleJob(summaryTime.toDate(), async () => {
        let digestMsg = `🌅 <b>Daily Summary (${now.format('DD MMM')}):</b>\n\n`;
        
        // Sort events by time
        const sortedEvents = [...todaysEvents].sort((a, b) => {
          const tA = parseTimeText(a.dateStr, a.timeText, a.year);
          const tB = parseTimeText(b.dateStr, b.timeText, b.year);
          return tA - tB;
        });

        sortedEvents.forEach(ev => {
            // Using a compact format for the summary to save space
            // e.g. "09:30pm - 🔴 USD CPI m/m"
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
        console.log('Sent daily summary.');
      });
    } else {
      console.log(`⚠️ Past 6:00 AM, skipping Daily Summary for today.`);
    }
  }

  // ---------------------------------------------------------
  // Schedule Warnings & Results
  // ---------------------------------------------------------
  const eventsByTime = groupEventsByTime(todaysEvents);

  for (const [timeKey, groupEvents] of Object.entries(eventsByTime)) {
    const eventTime = moment(timeKey);
    
    // 2. Schedule Warning (10 mins before)
    const warningTime = eventTime.clone().subtract(WARNING_MINUTES, 'minutes');
    
    if (warningTime.isAfter(now)) {
      schedule.scheduleJob(warningTime.toDate(), async () => {
        let msg = `⚠️ <b>${WARNING_MINUTES} Minutes to Release:</b>\n`;
        groupEvents.forEach(ev => {
            msg += formatEventMessage(ev) + '\n';
        });
        await sendTelegramMessage(msg);
        console.log(`Sent warning for ${eventTime.format('HH:mm')}`);
      });
      console.log(`   -> Warning set for ${warningTime.format('HH:mm:ss')}`);
    }

    // 3. Schedule Result (2 mins after)
    const scrapeTime = eventTime.clone().add(SCRAPE_DELAY_MINUTES, 'minutes');
    
    if (scrapeTime.isAfter(now)) {
      const jobName = `result-${timeKey}`;
      if (schedule.scheduledJobs[jobName]) continue;

      schedule.scheduleJob(jobName, scrapeTime.toDate(), async () => {
        console.log(`\nFetching Actual values for ${eventTime.format('HH:mm')}...`);
        try {
          const freshEvents = await fetchCalendar();
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
      console.log(`   -> Result scrape set for ${scrapeTime.format('HH:mm:ss')}`);
    }
  }

  store.setLastFetch(new Date().toISOString());
};

(async () => {
  console.log(`Bot starting up in ${TARGET_TZ}...`);
  await loadAndSchedule();

  // Reload at midnight 00:01 so we can catch the 06:00 summary
  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = 0;
  rule.minute = 1;
  schedule.scheduleJob(rule, async () => {
    console.log('Midnight reload...');
    await loadAndSchedule();
  });
})();