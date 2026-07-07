const cheerio = require('cheerio');
require('dotenv').config({ quiet: true });

const { config } = require('./config');
const { recordScrape } = require('./status');

const BASE = config.baseUrl;
const TARGET_TZ = config.targetTz;

const normalizeText = (text) => (text || '').replace(/\s+/g, ' ').trim();

const getYearFromDateQuery = (dateQuery) => {
  const match = String(dateQuery || '').match(/\.(\d{4})$/);
  return match ? Number(match[1]) : new Date().getFullYear();
};

const getDateText = (row) => {
  const dateCellText =
    normalizeText(row.find('.calendar__date .date').first().text()) ||
    normalizeText(row.find('.calendar__date').first().text()) ||
    normalizeText(row.find('td.date, .date').first().text());

  if (dateCellText) return dateCellText;

  if (row.hasClass('calendar__row--day-breaker')) {
    return normalizeText(row.find('.calendar__cell').first().text());
  }

  return '';
};

const getImpact = (impactClass) => {
  const className = impactClass || '';

  if (className.includes('red')) return 'High';
  if (className.includes('ora') || className.includes('orange')) return 'Medium';
  if (className.includes('yel') || className.includes('yellow')) return 'Low';
  if (
    className.includes('gra') ||
    className.includes('gray') ||
    className.includes('grey') ||
    className.includes('holiday')
  ) {
    return 'Non-Economic';
  }

  return 'Low';
};

const fallbackEventId = ({ dateStr, timeText, currency, eventName }) => (
  [dateStr, timeText, currency, eventName]
    .map((part) => normalizeText(part).toLowerCase())
    .filter(Boolean)
    .join('|')
);

const getCalendarUrl = (dateQuery = '', options = {}) => {
  let url = dateQuery ? `${BASE}/calendar?day=${dateQuery}` : `${BASE}/calendar`;

  if (options.cacheBust) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}_=${Date.now()}`;
  }

  return url;
};

const fetchCalendar = async (dateQuery = '', options = {}) => {
  const { gotScraping } = await import('got-scraping');
  const url = getCalendarUrl(dateQuery, options);

  try {
    const response = await gotScraping({
      url,
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Cookie': `timezone=${encodeURIComponent(TARGET_TZ)};`,
      },
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 110 }], devices: ['desktop'] },
      retry: { limit: 2, methods: ['GET'] },
      timeout: { request: 30000 },
    });

    const html = response.body;
    const $ = cheerio.load(html);
    const events = [];
    const expectedEventCount = $('tr.calendar__row[data-event-id], tr.calendar__row[data-eventid]').length;
    
    const currentYear = getYearFromDateQuery(dateQuery);
    let currentDateStr = ""; 
    let lastTimeText = ""; 

    $('tr.calendar__row').each((i, el) => {
      const row = $(el);
      const dateText = getDateText(row);
      
      if (dateText) {
        currentDateStr = dateText;
        lastTimeText = ""; 
      }

      if (!currentDateStr) return;

      let timeText = normalizeText(row.find('.calendar__time, .time').first().text());
      if (timeText && timeText !== '') {
        lastTimeText = timeText;
      } else if (lastTimeText !== '') {
        timeText = lastTimeText;
      } else {
        return; 
      }

      const currency = normalizeText(row.find('.calendar__currency').text());
      const eventName = normalizeText(row.find('.calendar__event-title').first().text()) ||
        normalizeText(row.find('.calendar__event').text());
      if (!currency || !eventName) return;

      const impactClass = row.find('.calendar__impact span').attr('class') || '';
      const id = row.attr('data-eventid') ||
        row.attr('data-event-id') ||
        fallbackEventId({ dateStr: currentDateStr, timeText, currency, eventName });

      events.push({
        id, dateStr: currentDateStr, year: currentYear, timeText, currency,
        impact: getImpact(impactClass),
        eventName,
        actual: normalizeText(row.find('.calendar__actual').text()),
        forecast: normalizeText(row.find('.calendar__forecast').text()),
        previous: normalizeText(row.find('.calendar__previous').text()),
      });
    });

    if (expectedEventCount && events.length !== expectedEventCount) {
      console.warn(`Forex Factory scraper captured ${events.length}/${expectedEventCount} event rows for ${url}`);
    }

    recordScrape({
      url,
      expectedEventCount,
      capturedEventCount: events.length,
    });
    
    return events;
  } catch (error) {
    console.error('Error in scraper:', error.message);
    recordScrape({
      url,
      expectedEventCount: 0,
      capturedEventCount: 0,
      ok: false,
      error: error.message,
    });
    return [];
  }
};

module.exports = { fetchCalendar };
