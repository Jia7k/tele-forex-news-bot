// src/scraper.js
const cheerio = require('cheerio');
require('dotenv').config();

const BASE = process.env.BASE_URL || 'https://www.forexfactory.com';

// NOW ACCEPTS AN OPTIONAL DATE STRING
const fetchCalendar = async (dateQuery = '') => {
  console.log(`Fetching calendar via HTTP... ${dateQuery ? '(Target: ' + dateQuery + ')' : '(Default Week)'}`);
  
  const { gotScraping } = await import('got-scraping');

  // If a specific date is requested, append it. e.g. /calendar?day=dec15.2025
  const url = dateQuery ? `${BASE}/calendar?day=${dateQuery}` : `${BASE}/calendar`;

  try {
    const response = await gotScraping({
      url,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 110 }],
        devices: ['desktop'],
        locales: ['en-US'],
        operatingSystems: ['windows'],
      },
      retry: {
        limit: 2,
        methods: ['GET'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
      },
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

      if (row.hasClass('calendar__row--new-day')) {
        const dateText = row.find('.date').text().trim(); 
        if (dateText) {
          currentDateStr = dateText;
          lastTimeText = ""; 
        }
        return; 
      }

      if (!currentDateStr) return;

      const id = row.data('event-id');
      if (!id) return;

      let timeText = row.find('.calendar__time').text().trim();
      if (timeText && timeText !== '') {
        lastTimeText = timeText;
      } else if (lastTimeText !== '') {
        timeText = lastTimeText;
      } else {
        return;
      }

      const currency = row.find('.calendar__currency').text().trim();
      const eventName = row.find('.calendar__event').text().trim();
      
      const impactEl = row.find('.calendar__impact span');
      const impactClass = impactEl.attr('class') || '';
      let impact = 'Low';
      if (impactClass.includes('red')) impact = 'High';
      else if (impactClass.includes('orange')) impact = 'Medium';
      else if (impactClass.includes('yellow')) impact = 'Low';

      const actual = row.find('.calendar__actual').text().trim();
      const forecast = row.find('.calendar__forecast').text().trim();
      const previous = row.find('.calendar__previous').text().trim();

      events.push({
        id,
        dateStr: currentDateStr, 
        year: currentYear,
        timeText, 
        currency,
        impact,
        eventName,
        actual,
        forecast,
        previous,
      });
    });

    console.log(`HTTP Scraper found ${events.length} events.`);
    return events;

  } catch (error) {
    console.error('Error in scraper:', error.message);
    return [];
  }
};

module.exports = { fetchCalendar };