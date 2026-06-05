require('dotenv').config();

const express = require('express');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

const { fetchCalendar } = require('./scraper');
const { parseTimeText, formatEventMessage, generateChartUrl } = require('./utils');
const { sendTelegramMessage, sendTelegramPhoto, bot } = require('./telegram'); 

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';
const SCRAPE_DELAY_MINUTES = 2; 
const WARNING_MINUTES = 10;
const SUMMARY_HOUR = 6; 

const scheduleDailySummary = () => {
  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = SUMMARY_HOUR; 
  rule.minute = 0;
  rule.second = 0;

  schedule.scheduleJob(rule, async () => {
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
    const events = await fetchCalendar(dateQuery);

    const startOfTarget = targetDate.clone().startOf('day');
    const endOfTarget = targetDate.clone().endOf('day');
    
    const targetEvents = events.filter(ev => {
      const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
      if (!dateObj) return false;
      return moment(dateObj).isBetween(startOfTarget, endOfTarget, null, '[]');
    });

    if (targetEvents.length === 0) {
      await sendTelegramMessage(`📅 <b>${displayTitle}:</b>\nNo significant events found.`);
    } else {
      const sortedEvents = [...targetEvents].sort((a, b) => {
        return parseTimeText(a.dateStr, a.timeText, a.year) - parseTimeText(b.dateStr, b.timeText, b.year);
      });

      let digestMsg = `🌅 <b>${displayTitle}:</b>\n`;
      let lastPrintedTime = null; 

      sortedEvents.forEach(ev => {
          let icon = '⚪️';
          if(ev.impact === 'High') icon = '🔴';
          if(ev.impact === 'Medium') icon = '🟠';
          if(ev.impact === 'Low') icon = '🟡';
          if(ev.impact === 'Non-Economic') icon = '⚪️';
          
          // DIRECT OUTPUT: Print exactly what Forex Factory gave us
          const displayTime = ev.timeText.toLowerCase().includes('day') ? 'All Day' : ev.timeText.toLowerCase();
          
          if (displayTime !== lastPrintedTime) {
            digestMsg += `${lastPrintedTime === null ? '\n' : '\n\n'}<b>${displayTime}</b> ${icon} <b>${ev.currency} - ${ev.eventName}</b>\n`;
            lastPrintedTime = displayTime;
          } else {
            digestMsg += `${icon} <b>${ev.currency} - ${ev.eventName}</b>\n`;
          }

          digestMsg += `├ Act: ${ev.actual || '--'}\n`;
          digestMsg += `├ Fcst: ${ev.forecast || '--'}\n`;
          digestMsg += `└ Prev: ${ev.previous || '--'}\n`;
      });

      if (digestMsg.length > 4000) {
        const mid = Math.floor(digestMsg.length / 2);
        await sendTelegramMessage(digestMsg.substring(0, mid));
        await sendTelegramMessage(digestMsg.substring(mid));
      } else {
        await sendTelegramMessage(digestMsg);
      }
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
  
  const events = await fetchCalendar(dateQuery);
  
  const startOfTarget = targetDate.clone().startOf('day');
  const endOfTarget = targetDate.clone().endOf('day');
  
  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    return moment(dateObj).isBetween(startOfTarget, endOfTarget, null, '[]');
  });

  if (targetEvents.length === 0) {
    await sendTelegramMessage(`No events found for ${displayTitle}.`);
  } else {
    const sortedEvents = [...targetEvents].sort((a, b) => {
      return parseTimeText(a.dateStr, a.timeText, a.year) - parseTimeText(b.dateStr, b.timeText, b.year);
    });

    let detailedMsg = `📋 <b>Detailed Report (${displayTitle}):</b>\n`;
    let lastPrintedTime = null; 

    for (const ev of sortedEvents) {
      let icon = '⚪️';
      if (ev.impact === 'High') icon = '🔴';
      if (ev.impact === 'Medium') icon = '🟠';
      if (ev.impact === 'Low') icon = '🟡';
      if (ev.impact === 'Non-Economic') icon = '⚪️';

      // DIRECT OUTPUT: Print exactly what Forex Factory gave us
      const displayTime = ev.timeText.toLowerCase().includes('day') ? 'All Day' : ev.timeText.toLowerCase();

      if (displayTime !== lastPrintedTime) {
        detailedMsg += `${lastPrintedTime === null ? '\n' : '\n\n'}<b>${displayTime}</b> ${icon} <b>${ev.currency} - ${ev.eventName}</b>\n`;
        lastPrintedTime = displayTime;
      } else {
        detailedMsg += `${icon} <b>${ev.currency} - ${ev.eventName}</b>\n`;
      }

      detailedMsg += `├ Act: ${ev.actual || '--'}\n`;
      detailedMsg += `├ Fcst: ${ev.forecast || '--'}\n`;
      detailedMsg += `└ Prev: ${ev.previous || '--'}\n`;
    }

    if (detailedMsg.length > 4000) {
      const mid = Math.floor(detailedMsg.length / 2);
      await sendTelegramMessage(detailedMsg.substring(0, mid));
      await sendTelegramMessage(detailedMsg.substring(mid));
    } else {
      await sendTelegramMessage(detailedMsg);
    }
  }
};

const loadAndSchedule = async () => {  
  const now = moment.tz(TARGET_TZ);
  const dateQuery = now.format('MMMD.YYYY').toLowerCase();

  const events = await fetchCalendar(dateQuery);
  if (!events || events.length === 0) return;

  const startOfTarget = now.clone().startOf('day');
  const endOfTarget = now.clone().endOf('day');

  const targetEvents = events.filter(ev => {
    const dateObj = parseTimeText(ev.dateStr, ev.timeText, ev.year);
    if (!dateObj) return false;
    return moment(dateObj).isBetween(startOfTarget, endOfTarget, null, '[]');
  });

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
    }

    const scrapeTime = eventTime.clone().add(SCRAPE_DELAY_MINUTES, 'minutes');
    if (scrapeTime.isAfter(now)) {
      const jobName = `result-${timeKey}`;
      if (schedule.scheduledJobs[jobName]) continue;
      
      schedule.scheduleJob(jobName, scrapeTime.toDate(), async () => {
        try {
          const freshEvents = await fetchCalendar(dateQuery);
          for (const oldEv of groupEvents) {
            const freshEv = freshEvents.find(f => (f.id && f.id === oldEv.id) || (f.eventName === oldEv.eventName));
            const targetEv = freshEv || oldEv;
            
            let resultMsg = `✅ <b>News Released:</b>\n`;
            resultMsg += formatEventMessage(targetEv);

            const chartUrl = generateChartUrl(targetEv);
            if (chartUrl) await sendTelegramPhoto(chartUrl, resultMsg);
            else await sendTelegramMessage(resultMsg);
          }
        } catch (err) { console.error(err); }
      });
    }
  }
};

(async () => {
  const shutdown = () => {
    bot.stopPolling();
    schedule.gracefulShutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  scheduleDailySummary();
  await loadAndSchedule();

  const rule = new schedule.RecurrenceRule();
  rule.tz = TARGET_TZ;
  rule.hour = 0;
  rule.minute = 1;
  schedule.scheduleJob(rule, async () => {
    await loadAndSchedule();
  });

  bot.on('message', async (msg) => {
    const text = msg.text ? msg.text.toLowerCase().trim() : '';
    if (text === 'check') {
      await performSystemCheck();
    }
  });
})();