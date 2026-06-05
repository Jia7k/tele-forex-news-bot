const moment = require('moment-timezone');
require('dotenv').config();

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';

const parseTimeText = (dateStr, timeText, year) => {
  if (!timeText || timeText.toLowerCase().includes('tentative') || timeText === '') {
    return null;
  }

  const cleanDate = dateStr.replace(/([A-Za-z]+)(\d+)/, '$1 $2').trim();
  const datePart = cleanDate.split(' ').slice(1).join(' '); 

  if (timeText.toLowerCase().includes('day')) {
      const m = moment.tz(`${year} ${datePart} 12:00am`, 'YYYY MMM D h:mma', TARGET_TZ);
      return m.isValid() ? m.toDate() : null;
  }
  
  const cleanTime = timeText.trim();
  const fullString = `${year} ${datePart} ${cleanTime}`;
  
  // FIXED: Parse exactly as the target timezone, since we will force FF to send it in this timezone!
  const m = moment.tz(fullString, 'YYYY MMM D h:mma', TARGET_TZ);

  if (!m.isValid()) return null;

  return m.toDate();
};

const formatEventMessage = (ev) => {
  let impactIcon = '⚪️';
  if (ev.impact === 'High') impactIcon = '🔴';
  else if (ev.impact === 'Medium') impactIcon = '🟠';
  else if (ev.impact === 'Low') impactIcon = '🟡';
  else if (ev.impact === 'Non-Economic') impactIcon = '⚪️';

  const actual = (ev.actual && ev.actual.trim() !== '') ? `<b>${ev.actual}</b>` : '-';
  const forecast = (ev.forecast && ev.forecast.trim() !== '') ? ev.forecast : '-';
  const previous = (ev.previous && ev.previous.trim() !== '') ? ev.previous : '-';

  return `\n${impactIcon} <b>${ev.currency} - ${ev.eventName}</b>\n├ Act: ${actual}\n├ Fcst: ${forecast}\n└ Prev: ${previous}\n`;
};

const cleanNumber = (str) => {
  if (!str || str.trim() === '' || str === '-' || str === '--') return null;
  const match = str.match(/-?[\d.]+/);
  return match ? parseFloat(match[0]) : null;
};

const generateChartUrl = (ev) => {
  const prev = cleanNumber(ev.previous);
  const fcst = cleanNumber(ev.forecast);
  const act = cleanNumber(ev.actual);

  if (act === null) return null;

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