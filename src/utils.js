const moment = require('moment-timezone');
require('dotenv').config({ quiet: true });

const { config } = require('./config');

const TARGET_TZ = config.targetTz;
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

const normalizeText = (text) => (
  text === null || text === undefined ? '' : String(text)
).replace(/\s+/g, ' ').trim();
const getTimezoneLabel = () => (TARGET_TZ === 'Asia/Singapore' ? 'SGT' : TARGET_TZ);

const PLACEHOLDER_VALUES = new Set(['', '-', '--', '—', '–', 'n/a', 'na']);

const hasDataValue = (value) => {
  const normalized = normalizeText(value).toLowerCase();
  return !PLACEHOLDER_VALUES.has(normalized);
};

const shouldWaitForActualValue = (ev) => (
  !hasDataValue(ev.actual) &&
  (hasDataValue(ev.forecast) || hasDataValue(ev.previous))
);

const shouldSendReleaseUpdate = (ev) => hasDataValue(ev.actual);

const getReleaseUpdateEvents = (events, pendingEvents = []) => {
  const actualEvents = events.filter(shouldSendReleaseUpdate);

  if (pendingEvents.length > 0 || actualEvents.length === 0) {
    return actualEvents;
  }

  return events.filter((ev) => shouldSendReleaseUpdate(ev) || !shouldWaitForActualValue(ev));
};

const getReleaseDedupeId = (ev) => {
  const eventId = ev.id || [ev.currency, ev.eventName, ev.dateStr, ev.timeText]
    .map(normalizeText)
    .filter(Boolean)
    .join(':');
  const actual = hasDataValue(ev.actual) ? normalizeText(ev.actual) : 'pending';

  return `release:${eventId}:actual:${actual}`;
};

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

const getTimestampMoment = (ev) => {
  const timestamp = Number(ev.timestamp);

  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const milliseconds = timestamp > 100000000000 ? timestamp : timestamp * 1000;
  const m = moment(milliseconds).tz(TARGET_TZ);

  return m.isValid() ? m : null;
};

const formatEventTime = (ev) => {
  const cleanTime = normalizeText(ev.timeText).toLowerCase();
  const timezoneLabel = getTimezoneLabel();

  if (!cleanTime) return `Unscheduled (${timezoneLabel})`;
  if (cleanTime.includes('tentative')) return 'Tentative';
  if (cleanTime.includes('day')) return `All Day (${timezoneLabel})`;

  const timestampMoment = getTimestampMoment(ev);
  if (timestampMoment) return `${timestampMoment.format('h:mma')} ${timezoneLabel}`;

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

  const actual = hasDataValue(ev.actual) ? `<b>${escapeHtml(ev.actual)}</b>` : '--';
  const forecast = hasDataValue(ev.forecast) ? escapeHtml(ev.forecast) : '--';
  const previous = hasDataValue(ev.previous) ? escapeHtml(ev.previous) : '--';
  const currency = escapeHtml(ev.currency);
  const eventName = escapeHtml(ev.eventName);
  const surprise = getSurpriseText(ev);
  const previousPrefix = surprise ? '├' : '└';
  const surpriseLine = surprise ? `\n└ ${surprise}` : '';

  return `\n${impactIcon} <b>${currency} - ${eventName}</b>\n├ Act: ${actual}\n├ Fcst: ${forecast}\n${previousPrefix} Prev: ${previous}${surpriseLine}\n`;
};

const parseMetricValue = (str) => {
  if (!hasDataValue(str)) return null;

  const match = String(str).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([KMBT%])?/i);
  if (!match) return null;

  const suffix = (match[2] || '').toUpperCase();
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, '%': 1 };

  return {
    raw: parseFloat(match[1]),
    suffix,
    value: parseFloat(match[1]) * (multipliers[suffix] || 1),
  };
};

const cleanNumber = (str) => {
  const metric = parseMetricValue(str);
  return metric ? metric.value : null;
};

const formatDelta = (delta, suffix) => {
  const sign = delta > 0 ? '+' : '';
  const divisors = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, '%': 1 };
  const divisor = divisors[suffix] || 1;
  const scaledDelta = delta / divisor;
  const absDelta = Math.abs(scaledDelta);
  const decimals = absDelta !== 0 && absDelta < 10 ? 2 : 1;
  const rounded = Number(scaledDelta.toFixed(decimals));

  return `${sign}${rounded}${suffix}`;
};

const getSurpriseText = (ev) => {
  const actual = parseMetricValue(ev.actual);
  const forecast = parseMetricValue(ev.forecast);

  if (!actual || !forecast) return '';

  const delta = actual.value - forecast.value;
  const direction = delta > 0 ? 'Higher than forecast' : delta < 0 ? 'Lower than forecast' : 'In line with forecast';
  const suffix = actual.suffix === forecast.suffix ? actual.suffix : '';

  return `Surprise: ${escapeHtml(direction)} (${escapeHtml(formatDelta(delta, suffix))})`;
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
  getSurpriseText,
  escapeHtml,
  getImpactIcon,
  getTimezoneLabel,
  hasDataValue,
  parseMetricValue,
  getReleaseDedupeId,
  getReleaseUpdateEvents,
  shouldWaitForActualValue,
  shouldSendReleaseUpdate,
};
