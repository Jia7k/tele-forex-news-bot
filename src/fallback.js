const moment = require('moment-timezone');

const { config } = require('./config');
const { recordFallbackLookup } = require('./status');
const {
  hasDataValue,
  parseTimeText,
} = require('./utils');

const TARGET_TZ = config.targetTz;

const CURRENCY_COUNTRIES = {
  AUD: 'australia',
  CAD: 'canada',
  CHF: 'switzerland',
  CNY: 'china',
  EUR: 'euro area',
  GBP: 'united kingdom',
  JPY: 'japan',
  NZD: 'new zealand',
  USD: 'united states',
};

const normalizeText = (value) => (
  value === null || value === undefined ? '' : String(value)
).replace(/\s+/g, ' ').trim();

const pickField = (row, ...fields) => {
  for (const field of fields) {
    if (row[field] !== null && row[field] !== undefined) return row[field];
  }

  return '';
};

const normalizeForMatch = (value) => normalizeText(value)
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(y\/y|yy|yoy)\b/g, ' year over year ')
  .replace(/\b(m\/m|mm|mom)\b/g, ' month over month ')
  .replace(/\b(q\/q|qq|qoq)\b/g, ' quarter over quarter ')
  .replace(/\b(final|prelim|preliminary|flash|revised|advance|s\.a\.|sa|nsa)\b/g, ' ')
  .replace(/[^a-z0-9%]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tokenSet = (value) => new Set(
  normalizeForMatch(value)
    .split(' ')
    .filter((token) => token.length > 1)
);

const similarity = (a, b) => {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let matches = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) matches += 1;
  }

  return matches / Math.max(aTokens.size, bTokens.size);
};

const getFallbackEventName = (row) => normalizeText(pickField(row, 'Event', 'event', 'Category', 'category'));

const getFallbackCountry = (row) => normalizeForMatch(pickField(row, 'Country', 'country'));

const getFallbackDate = (row) => {
  const rawDate = pickField(row, 'Date', 'date');
  if (!rawDate) return null;

  const parsed = moment.utc(rawDate);
  return parsed.isValid() ? parsed.tz(TARGET_TZ) : null;
};

const formatFallbackValue = (value, unit = '') => {
  const cleanValue = normalizeText(value);
  const cleanUnit = normalizeText(unit);

  if (!hasDataValue(cleanValue)) return '';
  if (!cleanUnit || /[%$a-z]/i.test(cleanValue)) return cleanValue;

  return `${cleanValue}${cleanUnit}`;
};

const getEventMoment = (ev) => {
  const parsed = parseTimeText(ev.dateStr, ev.timeText, ev.year);
  return parsed ? moment(parsed).tz(TARGET_TZ) : null;
};

const findFallbackMatch = (targetEvent, fallbackRows) => {
  const targetCountry = CURRENCY_COUNTRIES[String(targetEvent.currency || '').toUpperCase()];
  const targetMoment = getEventMoment(targetEvent);
  if (!targetCountry || !targetMoment) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const row of fallbackRows) {
    if (!hasDataValue(pickField(row, 'Actual', 'actual'))) continue;
    if (targetCountry !== getFallbackCountry(row)) continue;

    const fallbackMoment = getFallbackDate(row);
    if (!fallbackMoment) continue;

    const diffMinutes = Math.abs(fallbackMoment.diff(targetMoment, 'minutes'));
    if (diffMinutes > config.fallback.matchWindowMinutes) continue;

    const candidateName = getFallbackEventName(row);
    const category = pickField(row, 'Category', 'category');
    const score = Math.max(
      similarity(targetEvent.eventName, candidateName),
      similarity(targetEvent.eventName, `${candidateName} ${category}`)
    );

    if (score > bestScore) {
      bestScore = score;
      bestMatch = row;
    }
  }

  return bestScore >= 0.45 ? bestMatch : null;
};

const getDateRange = (dateQueries) => {
  const dates = dateQueries
    .map((query) => {
      const match = String(query || '').match(/^([a-z]{3})(\d{1,2})\.(\d{4})$/i);
      if (!match) return null;

      const parsed = moment.tz(`${match[1]} ${match[2]} ${match[3]}`, 'MMM D YYYY', true, TARGET_TZ);
      return parsed.isValid() ? parsed : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.valueOf() - b.valueOf());

  if (dates.length === 0) {
    const today = moment.tz(TARGET_TZ);
    return {
      start: today.format('YYYY-MM-DD'),
      end: today.format('YYYY-MM-DD'),
    };
  }

  return {
    start: dates[0].format('YYYY-MM-DD'),
    end: dates[dates.length - 1].format('YYYY-MM-DD'),
  };
};

const fetchTradingEconomicsRows = async (dateQueries) => {
  const { start, end } = getDateRange(dateQueries);
  const url = new URL(`https://api.tradingeconomics.com/calendar/country/All/${start}/${end}`);
  url.searchParams.set('c', config.fallback.tradingEconomicsApiKey);
  url.searchParams.set('f', 'json');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Trading Economics fallback returned HTTP ${response.status}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
};

const applyFallbackValues = async (events, dateQueries) => {
  if (config.fallback.provider === 'none') return events;

  try {
    const fallbackRows = await fetchTradingEconomicsRows(dateQueries);
    let matchedCount = 0;

    const mergedEvents = events.map((ev) => {
      if (!shouldUseFallbackForEvent(ev)) return ev;

      const match = findFallbackMatch(ev, fallbackRows);
      if (!match) return ev;

      matchedCount += 1;
      return {
        ...ev,
        actual: formatFallbackValue(
          pickField(match, 'Actual', 'actual'),
          pickField(match, 'Unit', 'unit')
        ),
        forecast: hasDataValue(ev.forecast) ?
          ev.forecast :
          formatFallbackValue(
            pickField(match, 'Forecast', 'forecast'),
            pickField(match, 'Unit', 'unit')
          ),
        previous: hasDataValue(ev.previous) ?
          ev.previous :
          formatFallbackValue(
            pickField(match, 'Previous', 'previous'),
            pickField(match, 'Unit', 'unit')
          ),
        valueSource: 'Trading Economics',
      };
    });

    recordFallbackLookup({
      provider: config.fallback.provider,
      ok: true,
      fetchedCount: fallbackRows.length,
      matchedCount,
    });

    return mergedEvents;
  } catch (error) {
    recordFallbackLookup({
      provider: config.fallback.provider,
      ok: false,
      error: error.message,
    });
    console.error('Fallback calendar lookup failed:', error.message);
    return events;
  }
};

const shouldUseFallbackForEvent = (ev) => (
  !hasDataValue(ev.actual) &&
  (hasDataValue(ev.forecast) || hasDataValue(ev.previous))
);

module.exports = {
  applyFallbackValues,
  findFallbackMatch,
  formatFallbackValue,
  normalizeForMatch,
};
