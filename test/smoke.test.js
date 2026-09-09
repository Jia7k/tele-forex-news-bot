const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const moment = require('moment-timezone');
const TelegramBot = require('node-telegram-bot-api');
const { createTelegramTransport } = require('../src/telegramTransport');

test('real Telegram SDK serializes reply, mute and inline controls correctly against a local endpoint', { timeout: 5000 }, async (t) => {
  const requests = [];
  const fixture = http.createServer((req, res) => {
    let body = '';
    req.on('data', (data) => { body += data; });
    req.on('end', () => {
      requests.push(Object.fromEntries(new URLSearchParams(body)));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 1 }, date: 1788957000, text: 'Result' } }));
    });
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const bot = new TelegramBot('123456:offline-test-token', { polling: false, baseApiUrl: `http://127.0.0.1:${fixture.address().port}` });
  const transport = createTelegramTransport({ bot, config: { mode: 'polling', chatId: '1', sendRetryAttempts: 0 } });
  const messages = await transport.sendTelegramChunks('<b>Result</b>', '1', {
    disable_notification: true,
    reply_parameters: { message_id: 50 },
    reply_markup: { inline_keyboard: [[{ text: 'Why', callback_data: 'why:123' }]] },
  });
  assert.equal(messages[0].message_id, 99);
  assert.equal(requests[0].disable_notification, 'true');
  assert.deepEqual(JSON.parse(requests[0].reply_parameters), { message_id: 50, allow_sending_without_reply: true });
  assert.deepEqual(JSON.parse(requests[0].reply_markup).inline_keyboard[0][0], { text: 'Why', callback_data: 'why:123' });
  assert.equal(requests[0].parse_mode, 'HTML');
});

test('offline smoke: real process refreshes a local calendar, schedules jobs and exposes health', { timeout: 20000 }, async (t) => {
  const event = moment().add(20, 'minutes').tz('Asia/Singapore');
  const feed = [{ title: 'CPI m/m', country: 'USD', date: event.toISOString(), impact: 'High', forecast: '0.3%', previous: '0.2%' }];
  const html = `<title>Calendar | Forex Factory</title><script>window.calendarEvents = [{"id":123,"name":"CPI m/m","dateline":${event.unix()},"timeLabel":"${event.format('h:mma')}","date":"${event.format('MMM D, YYYY')}"}];</script><table>
    <tr class="calendar__row calendar__row--day-breaker"><td class="calendar__cell">${event.format('ddd MMM D')}</td></tr>
    <tr class="calendar__row" data-event-id="123"><td class="calendar__time">${event.format('h:mma')}</td><td class="calendar__currency">USD</td><td class="calendar__impact"><span class="icon--ff-impact-red"></span></td><td class="calendar__event-title">CPI m/m</td><td class="calendar__forecast">0.3%</td><td class="calendar__previous">0.2%</td></tr></table>`;
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/feed' ? 'application/json' : 'text/html');
    res.end(req.url === '/feed' ? JSON.stringify(feed) : html);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telebot-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceUrl = `http://127.0.0.1:${fixture.address().port}`;
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TELEGRAM_MODE: 'disabled', TELEGRAM_BOT_TOKEN: '123456:offline-test-token', TELEGRAM_CHAT_ID: '1', ALLOWED_CHAT_IDS: '1',
      TARGET_TZ: 'Asia/Singapore', BASE_URL: sourceUrl, PUBLIC_CALENDAR_FEED_URL: `${sourceUrl}/feed`, FALLBACK_PROVIDER: 'none',
      PORT: String(port), STORE_PATH: path.join(dir, 'store.json'), RESCHEDULE_INTERVAL_MINUTES: '0',
      ALERT_CURRENCIES: '', ALERT_IMPACTS: '', CURRENCIES: '', IMPACTS: '', WARNING_MINUTES: '10',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { health = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).json(); } catch {}
    if (health?.scheduledJobs.managedJobs >= 2) break;
    if (child.exitCode !== null) assert.fail(`App exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.telegramMode, 'disabled', output);
  assert.equal(health?.timezone, 'Asia/Singapore');
  assert.equal(health?.scheduledJobs.warningJobs, 1, output);
  assert.equal(health?.scheduledJobs.resultJobs, 1, output);
  assert.equal(health?.lastScrape.ok, true, output);
  assert.equal(health?.lastScrape.capturedEventCount, 1, output);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
  assert.ok(Object.values(stored.qol.calendars).some((calendar) => calendar.events[0]?.eventName === 'CPI m/m'));
  assert.equal(Object.keys(stored.qol.records).length, 0);
});
