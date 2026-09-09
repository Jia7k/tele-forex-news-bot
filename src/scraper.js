const cheerio = require('cheerio');
const moment = require('moment-timezone');
require('dotenv').config({ quiet: true });

const { config } = require('./config');
const { recordScrape } = require('./status');

const BASE = config.baseUrl;
const TARGET_TZ = config.targetTz;
const PUBLIC_FEED_CACHE_TTL_MS = 30 * 1000;
let publicFeedCache = null;

const normalizeText = (text) => (
  text === null || text === undefined ? '' : String(text)
).replace(/\s+/g, ' ').trim();

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

const classifyCalendarResponse = (response) => {
  const statusCode = Number(response?.statusCode || 0);
  const headers = response?.headers || {};
  const body = String(response?.body || '');
  const isCloudflareChallenge = String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge' ||
    /<title>\s*Just a moment|_cf_chl_opt|Enable JavaScript and cookies to continue/i.test(body);

  if (isCloudflareChallenge) {
    return {
      code: 'cloudflare-challenge',
      message: 'Forex Factory returned a Cloudflare challenge',
    };
  }

  if (statusCode >= 400) {
    return {
      code: 'http-error',
      message: `Forex Factory returned HTTP ${statusCode}`,
    };
  }

  return null;
};

const getFeedImpact = (impact) => {
  const normalizedImpact = normalizeText(impact).toLowerCase();
  if (normalizedImpact === 'high') return 'High';
  if (normalizedImpact === 'medium' || normalizedImpact === 'orange') return 'Medium';
  if (normalizedImpact === 'holiday' || normalizedImpact === 'non-economic') return 'Non-Economic';
  return 'Low';
};

const getCalendarRequestUrls = (dateQuery, options = {}) => {
  const requestedUrl = getCalendarUrl(dateQuery, options);
  if (!options.cacheBust) return [requestedUrl];

  const canonicalUrl = getCalendarUrl(dateQuery);
  return requestedUrl === canonicalUrl ? [requestedUrl] : [requestedUrl, canonicalUrl];
};

const decodeJsonString = (value) => {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
};

const extractEmbeddedEventData = (html) => {
  const eventsById = new Map();
  const eventPattern = /\{(?=[^{}]*"id"\s*:\s*\d+)[^{}]*"id"\s*:\s*(\d+)[^{}]*"dateline"\s*:\s*(\d+)[^{}]*\}/g;
  let match;

  while ((match = eventPattern.exec(html)) !== null) {
    const objectText = match[0];
    const timeLabelMatch = objectText.match(/"timeLabel"\s*:\s*"((?:\\.|[^"])*)"/);
    const dateMatch = objectText.match(/"date"\s*:\s*"((?:\\.|[^"])*)"/);

    eventsById.set(match[1], {
      timestamp: Number(match[2]),
      timeLabel: timeLabelMatch ? decodeJsonString(timeLabelMatch[1]) : '',
      date: dateMatch ? decodeJsonString(dateMatch[1]) : '',
    });
  }

  return eventsById;
};

const parseCalendarHtml = (html, dateQuery = '') => {
  const $ = cheerio.load(html);
  const events = [];
  const embeddedEvents = extractEmbeddedEventData(html);
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
    const embeddedEvent = embeddedEvents.get(String(id));
    const timestamp = Number(embeddedEvent?.timestamp);

    const event = {
      id,
      dateStr: embeddedEvent?.date || currentDateStr,
      year: currentYear,
      timeText: embeddedEvent?.timeLabel || timeText,
      currency,
      impact: getImpact(impactClass),
      eventName,
      actual: normalizeText(row.find('.calendar__actual').text()),
      forecast: normalizeText(row.find('.calendar__forecast').text()),
      previous: normalizeText(row.find('.calendar__previous').text()),
    };

    if (Number.isFinite(timestamp) && timestamp > 0) {
      event.timestamp = timestamp;
    }

    events.push(event);
  });

  return { events, expectedEventCount };
};

const parsePublicCalendarFeed = (body) => {
  const rows = JSON.parse(String(body || ''));
  if (!Array.isArray(rows)) throw new Error('Forex Factory public feed returned a non-array payload');

  return rows.map((row) => {
    const eventName = normalizeText(row.title || row.event || row.name);
    const currency = normalizeText(row.country || row.currency);
    const eventMoment = moment.parseZone(String(row.date || ''));

    if (!eventName || !currency || !eventMoment.isValid()) return null;

    const singaporeMoment = eventMoment.tz(TARGET_TZ);
    const dateStr = singaporeMoment.format('ddd MMM D');
    const timeText = singaporeMoment.format('h:mma');
    const id = `feed:${fallbackEventId({ dateStr, timeText, currency, eventName })}`;

    return {
      id,
      dateStr,
      year: singaporeMoment.year(),
      timeText,
      timestamp: eventMoment.unix(),
      currency,
      impact: getFeedImpact(row.impact),
      eventName,
      actual: normalizeText(row.actual ?? row.Actual),
      forecast: normalizeText(row.forecast ?? row.Forecast),
      previous: normalizeText(row.previous ?? row.Previous),
    };
  }).filter(Boolean);
};

const getDateQueryKey = (dateQuery) => {
  const match = String(dateQuery || '').match(/^([a-z]{3})(\d{1,2})\.(\d{4})$/i);
  if (!match) return null;

  const date = moment.tz(`${match[1]} ${match[2]} ${match[3]}`, 'MMM D YYYY', true, TARGET_TZ);
  return date.isValid() ? date.format('YYYY-MM-DD') : null;
};

const getEventDayKey = (event) => {
  const timestamp = Number(event.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  return moment.unix(timestamp).tz(TARGET_TZ).format('YYYY-MM-DD');
};

const getPublicFeedEventsForQuery = (events, dateQuery) => {
  const dateKey = getDateQueryKey(dateQuery);
  return dateKey ? events.filter((event) => getEventDayKey(event) === dateKey) : events;
};

const normalizeIdentity = (value) => normalizeText(value).toLowerCase();

const eventsMatch = (first, second) => {
  const sameLabels = normalizeIdentity(first.currency) === normalizeIdentity(second.currency) &&
    normalizeIdentity(first.eventName) === normalizeIdentity(second.eventName);
  if (!sameLabels) return false;

  const firstTimestamp = Number(first.timestamp);
  const secondTimestamp = Number(second.timestamp);
  if (Number.isFinite(firstTimestamp) && Number.isFinite(secondTimestamp)) {
    return firstTimestamp === secondTimestamp;
  }

  return normalizeIdentity(first.dateStr) === normalizeIdentity(second.dateStr) &&
    normalizeIdentity(first.timeText) === normalizeIdentity(second.timeText);
};

const mergeCalendarEvents = (baseEvents, enrichedEvents) => {
  const mergedEvents = baseEvents.map((event) => ({ ...event }));

  enrichedEvents.forEach((enrichedEvent) => {
    const matchingIndex = mergedEvents.findIndex((event) => eventsMatch(event, enrichedEvent));
    if (matchingIndex === -1) {
      mergedEvents.push(enrichedEvent);
      return;
    }

    const baseEvent = mergedEvents[matchingIndex];
    const mergedEvent = { ...baseEvent, ...enrichedEvent };
    ['actual', 'forecast', 'previous'].forEach((field) => {
      if (!normalizeText(enrichedEvent[field])) mergedEvent[field] = baseEvent[field];
    });
    mergedEvents[matchingIndex] = mergedEvent;
  });

  return mergedEvents;
};

const fetchPublicCalendarFeed = async () => {
  const now = Date.now();
  if (publicFeedCache && now - publicFeedCache.fetchedAt < PUBLIC_FEED_CACHE_TTL_MS) {
    return publicFeedCache;
  }

  const url = config.publicCalendarFeedUrl;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  if (!response.ok) {
    throw new Error(`Forex Factory public feed returned HTTP ${response.status}`);
  }

  const events = parsePublicCalendarFeed(await response.text());
  publicFeedCache = { fetchedAt: Date.now(), url, events };
  return publicFeedCache;
};

const createCalendarFetcher = ({
  requestHtml = async (options) => (await import('got-scraping')).gotScraping(options),
  loadFeed = fetchPublicCalendarFeed,
  record = recordScrape,
} = {}) => {
  const successfulCalendarCache = new Map();
  return async (dateQuery = '', options = {}) => {
    const requestStartedAt = Date.now();
    const requestUrls = getCalendarRequestUrls(dateQuery, options);
    const url = requestUrls[0];
    const cacheKey = String(dateQuery || '__default__').toLowerCase();
    let publicFeed = null;
    let publicFeedFailure = null;
    let lastFailure = null;

    try {
      publicFeed = await loadFeed();
    } catch (error) {
      publicFeedFailure = error;
    }

    const feedEvents = publicFeed ? getPublicFeedEventsForQuery(publicFeed.events, dateQuery) : [];

    for (const requestUrl of requestUrls) {
      try {
        const response = await requestHtml({
          url: requestUrl,
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Cookie': `timezone=${encodeURIComponent(TARGET_TZ)};`,
          },
          headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 110 }], devices: ['desktop'] },
          retry: { limit: 2, methods: ['GET'] },
          timeout: { request: 30000 },
          throwHttpErrors: false,
        });

        const responseFailure = classifyCalendarResponse(response);
        if (responseFailure) {
          lastFailure = new Error(responseFailure.message);
          lastFailure.code = responseFailure.code;
          continue;
        }

        const { events: htmlEvents, expectedEventCount } = parseCalendarHtml(response.body, dateQuery);
        const events = mergeCalendarEvents(feedEvents, htmlEvents);

        if (expectedEventCount && htmlEvents.length !== expectedEventCount) {
          console.warn(`Forex Factory scraper captured ${htmlEvents.length}/${expectedEventCount} HTML event rows for ${requestUrl}`);
        }

        successfulCalendarCache.set(cacheKey, events);
        const partial = expectedEventCount > htmlEvents.length;
        const metadata = {
          url: requestUrl,
          expectedEventCount: Math.max(expectedEventCount, events.length),
          capturedEventCount: events.length,
          source: publicFeed ? 'html+public-feed' : 'html',
          ok: true,
        };
        record(metadata);
        return { ...metadata, events, partial, authoritative: !partial, requestStartedAt, fetchedAt: Date.now() };
      } catch (error) {
        lastFailure = error;
      }
    }

    const error = lastFailure || new Error('Forex Factory calendar request failed');
    if (publicFeed) {
      console.warn(`Forex Factory HTML unavailable; using public calendar feed with ${feedEvents.length} row(s)`);
      successfulCalendarCache.set(cacheKey, feedEvents);
      const metadata = {
        url: publicFeed.url,
        expectedEventCount: feedEvents.length,
        capturedEventCount: feedEvents.length,
        source: 'public-feed',
        ok: true,
      };
      record(metadata);
      return { ...metadata, events: feedEvents, authoritative: false, requestStartedAt: publicFeed.fetchedAt || requestStartedAt, fetchedAt: publicFeed.fetchedAt || Date.now() };
    }

    if (publicFeedFailure) {
      lastFailure = new Error(`${error.message}; public feed failed: ${publicFeedFailure.message}`);
    }

    const finalError = lastFailure || error;
    const cachedEvents = successfulCalendarCache.get(cacheKey);
    const cacheAvailable = successfulCalendarCache.has(cacheKey);
    const cacheNote = cacheAvailable ? `; using ${cachedEvents.length} cached row(s)` : '';
    const errorMessage = `${finalError.message}${cacheNote}`;

    console.error('Error in scraper:', errorMessage);
    const metadata = {
      url,
      expectedEventCount: cacheAvailable ? cachedEvents.length : 0,
      capturedEventCount: cacheAvailable ? cachedEvents.length : 0,
      ok: false,
      error: errorMessage,
    };
    record(metadata);
    return { ...metadata, events: cachedEvents || [], authoritative: false, stale: true, requestStartedAt };
  };
};

const fetchCalendarSnapshot = createCalendarFetcher();
const fetchCalendar = async (dateQuery = '', options = {}) => (await fetchCalendarSnapshot(dateQuery, options)).events;

module.exports = {
  classifyCalendarResponse,
  fetchCalendar,
  fetchCalendarSnapshot,
  createCalendarFetcher,
  mergeCalendarEvents,
  parseCalendarHtml,
  parsePublicCalendarFeed,
};
