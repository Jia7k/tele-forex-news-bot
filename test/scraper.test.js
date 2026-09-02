const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCalendarResponse,
  parseCalendarHtml,
  parsePublicCalendarFeed,
  mergeCalendarEvents,
} = require('../src/scraper');

test('classifyCalendarResponse identifies Cloudflare challenge pages as failed scrapes', () => {
  const result = classifyCalendarResponse({
    statusCode: 403,
    headers: { 'cf-mitigated': 'challenge' },
    body: '<title>Just a moment...</title><script>window._cf_chl_opt = {};</script>',
  });

  assert.deepEqual(result, {
    code: 'cloudflare-challenge',
    message: 'Forex Factory returned a Cloudflare challenge',
  });
});

test('classifyCalendarResponse does not reject a valid empty calendar page', () => {
  const result = classifyCalendarResponse({
    statusCode: 200,
    headers: {},
    body: '<html><title>Calendar | Forex Factory</title><table></table></html>',
  });

  assert.equal(result, null);
});

test('parsePublicCalendarFeed converts feed timestamps into Singapore-time event rows', () => {
  const events = parsePublicCalendarFeed(JSON.stringify([{
    title: 'Official Cash Rate',
    country: 'NZD',
    date: '2026-09-02T10:00:00-04:00',
    impact: 'High',
    forecast: '2.75%',
    previous: '2.50%',
  }]));

  assert.equal(events.length, 1);
  assert.equal(events[0].eventName, 'Official Cash Rate');
  assert.equal(events[0].currency, 'NZD');
  assert.equal(events[0].dateStr, 'Wed Sep 2');
  assert.equal(events[0].timeText, '10:00pm');
  assert.equal(events[0].year, 2026);
  assert.equal(events[0].impact, 'High');
  assert.equal(events[0].actual, '');
  assert.equal(events[0].forecast, '2.75%');
  assert.equal(events[0].previous, '2.50%');
  assert.equal(events[0].timestamp, 1788357600);
  assert.match(events[0].id, /^feed:/);
});

test('mergeCalendarEvents keeps feed rows and prefers HTML values for matching releases', () => {
  const feedEvents = parsePublicCalendarFeed(JSON.stringify([{
    title: 'Official Cash Rate',
    country: 'NZD',
    date: '2026-09-02T10:00:00-04:00',
    impact: 'High',
    forecast: '2.75%',
    previous: '2.50%',
  }]));
  const htmlEvents = [{
    ...feedEvents[0],
    id: '148862',
    actual: '2.75%',
  }];

  const mergedEvents = mergeCalendarEvents(feedEvents, htmlEvents);

  assert.equal(mergedEvents.length, 1);
  assert.equal(mergedEvents[0].id, '148862');
  assert.equal(mergedEvents[0].actual, '2.75%');
  assert.equal(mergedEvents[0].forecast, '2.75%');
});

test('parseCalendarHtml extracts Forex Factory event rows', () => {
  const html = `
    <table>
      <tr class="calendar__row calendar__row--day-breaker">
        <td class="calendar__cell">Wed Jul 8</td>
      </tr>
      <tr class="calendar__row" data-event-id="148862">
        <td class="calendar__cell calendar__time">10:00am</td>
        <td class="calendar__cell calendar__currency">NZD</td>
        <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-red"></span></td>
        <td class="calendar__cell calendar__event">
          <span class="calendar__event-title">Official Cash Rate</span>
        </td>
        <td class="calendar__cell calendar__actual"><span>2.25%</span></td>
        <td class="calendar__cell calendar__forecast"><span>2.50%</span></td>
        <td class="calendar__cell calendar__previous"><span>2.25%</span></td>
      </tr>
      <tr class="calendar__row" data-event-id="148863">
        <td class="calendar__cell calendar__time"></td>
        <td class="calendar__cell calendar__currency">NZD</td>
        <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-red"></span></td>
        <td class="calendar__cell calendar__event">
          <span class="calendar__event-title">RBNZ Rate Statement</span>
        </td>
        <td class="calendar__cell calendar__actual"></td>
        <td class="calendar__cell calendar__forecast"></td>
        <td class="calendar__cell calendar__previous"><span></span></td>
      </tr>
    </table>
  `;

  const { events, expectedEventCount } = parseCalendarHtml(html, 'jul8.2026');

  assert.equal(expectedEventCount, 2);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    id: '148862',
    dateStr: 'Wed Jul 8',
    year: 2026,
    timeText: '10:00am',
    currency: 'NZD',
    impact: 'High',
    eventName: 'Official Cash Rate',
    actual: '2.25%',
    forecast: '2.50%',
    previous: '2.25%',
  });
  assert.equal(events[1].timeText, '10:00am');
  assert.equal(events[1].eventName, 'RBNZ Rate Statement');
  assert.equal(events[1].actual, '');
});

test('parseCalendarHtml captures embedded Forex Factory dateline by event id', () => {
  const html = `
    <script>
      window.calendarEvents = [{"id":149940,"name":"PPI y/y","dateline":1783641000,"timeLabel":"7:50am","date":"Jul 10, 2026"}];
    </script>
    <table>
      <tr class="calendar__row calendar__row--day-breaker">
        <td class="calendar__cell">Thu Jul 9</td>
      </tr>
      <tr class="calendar__row" data-event-id="149940">
        <td class="calendar__cell calendar__time">7:50pm</td>
        <td class="calendar__cell calendar__currency">JPY</td>
        <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-yel"></span></td>
        <td class="calendar__cell calendar__event">
          <span class="calendar__event-title">PPI y/y</span>
        </td>
        <td class="calendar__cell calendar__actual"></td>
        <td class="calendar__cell calendar__forecast"><span>6.8%</span></td>
        <td class="calendar__cell calendar__previous"><span>6.3%</span></td>
      </tr>
    </table>
  `;

  const { events } = parseCalendarHtml(html, 'jul9.2026');

  assert.equal(events[0].timestamp, 1783641000);
});
