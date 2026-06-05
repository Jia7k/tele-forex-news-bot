const cheerio = require('cheerio');
const moment = require('moment-timezone');
require('dotenv').config();

const BASE = process.env.BASE_URL || 'https://www.forexfactory.com';
const TARGET_TZ = process.env.TARGET_TZ || 'Asia/Singapore';

const fetchCalendar = async (dateQuery = '') => {
  const { gotScraping } = await import('got-scraping');

  const scrapePage = async (url) => {
    try {
      const response = await gotScraping({
        url,
        headers: {
          // FORCE Forex Factory to return SGT. This prevents IP geolocation bugs!
          'cookie': `timezone=${TARGET_TZ};` 
        },
        headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 110 }], devices: ['desktop'], locales: ['en-US'], operatingSystems: ['windows'] },
        retry: { limit: 2, methods: ['GET'], statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524] },
        timeout: { request: 30000 },
      });

      const html = response.body;
      const $ = cheerio.load(html);
      const events = [];
      
      let currentYear = new Date().getFullYear();
      let currentDateStr = ""; 
      let lastTimeText = ""; 

      $('tr.calendar__row').each((i, el) => {
        const row = $(el);
        const dateText = row.find('.date, .calendar__date').text().trim();
        
        if (dateText) {
          currentDateStr = dateText;
          lastTimeText = ""; 
        }

        if (!currentDateStr) return;

        const id = row.attr('data-eventid') || row.attr('data-event-id');
        if (!id) return;

        let timeText = row.find('.calendar__time, .time').text().trim();
        if (timeText && timeText !== '') {
          lastTimeText = timeText;
        } else if (lastTimeText !== '') {
          timeText = lastTimeText;
        } else {
          return; 
        }

        const currency = row.find('.calendar__currency').text().trim();
        const eventName = row.find('.calendar__event').text().trim();
        const impactClass = row.find('.calendar__impact span').attr('class') || '';
        let impact = 'Low';
        if (impactClass.includes('red')) impact = 'High';
        else if (impactClass.includes('orange')) impact = 'Medium';
        else if (impactClass.includes('yellow')) impact = 'Low';

        events.push({
          id, dateStr: currentDateStr, year: currentYear, timeText, currency, impact, eventName,
          actual: row.find('.calendar__actual').text().trim(),
          forecast: row.find('.calendar__forecast').text().trim(),
          previous: row.find('.calendar__previous').text().trim(),
        });
      });
      return events;
    } catch (error) {
      console.error('Error in scraper:', error.message);
      return [];
    }
  };

  if (!dateQuery) return await scrapePage(`${BASE}/calendar`);

  const targetDate = moment(dateQuery, 'MMMD.YYYY');
  const yesterdayQuery = targetDate.clone().subtract(1, 'days').format('MMMD.YYYY').toLowerCase();

  console.log(`Fetching 48-hour window: ${yesterdayQuery} and ${dateQuery}`);

  const [yesterdayEvents, todayEvents] = await Promise.all([
    scrapePage(`${BASE}/calendar?day=${yesterdayQuery}`),
    scrapePage(`${BASE}/calendar?day=${dateQuery}`)
  ]);

  return [...yesterdayEvents, ...todayEvents];
};

module.exports = { fetchCalendar };