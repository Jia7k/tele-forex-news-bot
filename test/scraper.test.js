const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCalendarHtml } = require('../src/scraper');

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
