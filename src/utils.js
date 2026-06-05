const moment = require('moment-timezone');
require('dotenv').config();

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';

/**
 * Combines date string, year, and time string into a JS Date object.
 */
const parseTimeText = (dateStr, timeText, year) => {
  if (!timeText || 
      timeText.toLowerCase().includes('day') || 
      timeText.toLowerCase().includes('tentative') ||
      timeText === '') {
    return null;
  }

  const cleanDate = dateStr.replace(/([A-Za-z]+)(\d+)/, '$1 $2').trim();
  const cleanTime = timeText.trim();
  const datePart = cleanDate.split(' ').slice(1).join(' '); // "Oct 27"
  
  const fullString = `${year} ${datePart} ${cleanTime}`;
  
  // FIX 3: Parse explicitly as Eastern Time. 
  // m.toDate() will then convert this safely into a universal UTC Date object
  // which index.js will perfectly adapt to your local Asia/Singapore timezone.
  const m = moment.tz(fullString, 'YYYY MMM D h:mma', 'America/New_York');

  if (!m.isValid()) return null;

  return m.toDate();
};
/**
 * Formats the event into a clean vertical stack for mobile.
 */
const formatEventMessage = (ev) => {
  // 1. Map Impact to Icon
  let impactIcon = '⚪️';
  if (ev.impact === 'High') impactIcon = '🔴';
  else if (ev.impact === 'Medium') impactIcon = '🟠';
  else if (ev.impact === 'Low') impactIcon = '🟡';
  else if (ev.impact === 'Non-Economic') impactIcon = '⚪️';

  // 2. Handle empty data
  const actual = (ev.actual && ev.actual.trim() !== '') ? `<b>${ev.actual}</b>` : '-';
  const forecast = (ev.forecast && ev.forecast.trim() !== '') ? ev.forecast : '-';
  const previous = (ev.previous && ev.previous.trim() !== '') ? ev.previous : '-';

  // 3. Vertical Format
  return `
${impactIcon} <b>${ev.currency} - ${ev.eventName}</b>
├ Act: ${actual}
├ Fcst: ${forecast}
└ Prev: ${previous}
`;
};

module.exports = { parseTimeText, formatEventMessage };