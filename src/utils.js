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
// --- NEW DATA PARSER & CHART GENERATOR ---

// Helper: Converts "1.5K", "-0.2%", "150B" into flat numbers for charting
const cleanNumber = (str) => {
  if (!str || str.trim() === '' || str === '-' || str === '--') return null;
  const match = str.match(/-?[\d.]+/);
  return match ? parseFloat(match[0]) : null;
};

// Generates a QuickChart URL comparing Previous vs Forecast vs Actual
const generateChartUrl = (ev) => {
  const prev = cleanNumber(ev.previous);
  const fcst = cleanNumber(ev.forecast);
  const act = cleanNumber(ev.actual);

  // If there is no actual data released yet, skip generating a chart
  if (act === null) return null;

  // Visual Context: Green if Actual beat Forecast, Red if it missed.
  // Note: For some events (like Unemployment), lower is better. You can refine this logic later!
  const actColor = act >= (fcst !== null ? fcst : prev) ? 'rgba(46, 204, 113, 0.8)' : 'rgba(231, 76, 60, 0.8)';

  const chartConfig = {
    type: 'bar',
    data: {
      labels: ['Previous', 'Forecast', 'Actual'],
      datasets: [{
        label: 'Reported Value',
        data: [prev || 0, fcst || prev || 0, act],
        backgroundColor: ['rgba(149, 165, 166, 0.8)', 'rgba(52, 152, 219, 0.8)', actColor]
      }]
    },
    options: {
      title: { display: true, text: `${ev.currency} - ${ev.eventName}` },
      legend: { display: false }
    }
  };

  const encodedConfig = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?w=500&h=300&c=${encodedConfig}&bkg=white`;
};

module.exports = { parseTimeText, formatEventMessage, generateChartUrl };