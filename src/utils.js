const moment = require('moment-timezone');
require('dotenv').config({ quiet: true });

const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';
const MONTHS = {
  jan: 'Jan',
  feb: 'Feb',
  mar: 'Mar',
  apr: 'Apr',
  may: 'May',
  jun: 'Jun',
  jul: 'Jul',
  aug: 'Aug',
  sep: 'Sep',
  oct: 'Oct',
  nov: 'Nov',
  dec: 'Dec',
};

const TIME_FORMATS = [
  'YYYY MMM D h:mma',
  'YYYY MMM D ha',
  'YYYY MMM D H:mm',
  'YYYY MMM D HH:mm',
];

const normalizeText = (text) => (text || '').replace(/\s+/g, ' ').trim();
const getTimezoneLabel = () => (TARGET_TZ === 'Asia/Singapore' ? 'SGT' : TARGET_TZ);

const extractDatePart = (dateStr) => {
  const cleanDate = normalizeText(dateStr)
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  const match = cleanDate.match(
    /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i
  );

  if (!match) return null;

  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  return `${month} ${Number(match[2])}`;
};

const parseDateText = (dateStr, year) => {
  const datePart = extractDatePart(dateStr);
  if (!datePart) return null;

  const m = moment.tz(`${year} ${datePart} 00:00`, 'YYYY MMM D HH:mm', true, TARGET_TZ);
  return m.isValid() ? m.toDate() : null;
};

const parseTimeText = (dateStr, timeText, year) => {
  const cleanTime = normalizeText(timeText).toLowerCase().replace(/\./g, '');
  const datePart = extractDatePart(dateStr);

  if (!cleanTime || cleanTime.includes('tentative') || !datePart) {
    return null;
  }

  if (cleanTime.includes('day')) {
    const m = moment.tz(`${year} ${datePart} 00:00`, 'YYYY MMM D HH:mm', true, TARGET_TZ);
    return m.isValid() ? m.toDate() : null;
  }

  const fullString = `${year} ${datePart} ${cleanTime.replace(/\s+/g, '')}`;
  const m = moment.tz(fullString, TIME_FORMATS, true, TARGET_TZ);

  if (!m.isValid()) return null;
  return m.toDate();
};

const formatEventTime = (ev) => {
  const cleanTime = normalizeText(ev.timeText).toLowerCase();
  const timezoneLabel = getTimezoneLabel();

  if (!cleanTime) return `Unscheduled (${timezoneLabel})`;
  if (cleanTime.includes('tentative')) return 'Tentative';
  if (cleanTime.includes('day')) return `All Day (${timezoneLabel})`;

  const parsedTime = parseTimeText(ev.dateStr, ev.timeText, ev.year);
  if (!parsedTime) return `${normalizeText(ev.timeText)} ${timezoneLabel}`;

  return `${moment(parsedTime).tz(TARGET_TZ).format('h:mma')} ${timezoneLabel}`;
};

const escapeHtml = (value) => normalizeText(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const getImpactIcon = (impact) => {
  if (impact === 'High') return '🔴';
  if (impact === 'Medium') return '🟠';
  if (impact === 'Low') return '🟡';
  return '⚪️';
};

const formatEventMessage = (ev) => {
  const impactIcon = getImpactIcon(ev.impact);

  const actual = (ev.actual && ev.actual.trim() !== '') ? `<b>${escapeHtml(ev.actual)}</b>` : '--';
  const forecast = (ev.forecast && ev.forecast.trim() !== '') ? escapeHtml(ev.forecast) : '--';
  const previous = (ev.previous && ev.previous.trim() !== '') ? escapeHtml(ev.previous) : '--';
  const currency = escapeHtml(ev.currency);
  const eventName = escapeHtml(ev.eventName);

  return `\n${impactIcon} <b>${currency} - ${eventName}</b>\n├ Act: ${actual}\n├ Fcst: ${forecast}\n└ Prev: ${previous}\n`;
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

module.exports = {
  parseDateText,
  parseTimeText,
  formatEventMessage,
  formatEventTime,
  generateChartUrl,
  escapeHtml,
  getImpactIcon,
  getTimezoneLabel,
};
