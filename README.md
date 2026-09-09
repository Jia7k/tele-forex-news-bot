# Telegram Forex News Bot

A Node.js Telegram bot that monitors the Forex Factory economic calendar and sends Singapore-time market event summaries, pre-release warnings, and post-release result updates.

## Features

- **Singapore-time calendar:** daily summaries, tentative events, and `/next` with the complete next release group and countdown.
- **Release tracking:** pre-release warnings, repeated actual-value checks, threaded results and corrections, and restart catch-up.
- **Compact Gold outlook:** actual-versus-forecast surprises and a data-based XAUUSD bias, with saved explanations for each alert.
- **Notification controls:** per-occurrence mute buttons, silent low-impact delivery, and restart-safe timed pauses without dropping held alerts.
- **Responsive commands:** immediate `/check` acknowledgement, labelled cached data, and shared refresh requests.
- **Schedule integrity:** confirmed moved, tentative, or cancelled event notices; missing rows and blocked sources never establish cancellation.
- **Visible diagnostics:** compact `/status` with expandable details, `/pending` retry information, late-result labels, and HTTP health endpoints.
- **Deployment options:** polling, webhooks, persistent state, currency/impact filters, a public calendar-feed baseline, and optional Trading Economics enrichment.

Calendar availability and actual-value availability are separate: the public feed can preserve the schedule while Forex Factory HTML is blocked, but it cannot guarantee released actual values. See [Data Sources](#data-sources).

## Requirements

- Node.js 20 or newer
- A Telegram bot token from BotFather
- A Telegram chat ID where alerts should be delivered

## Quick Start

```bash
git clone git@github.com:Jia7k/tele-forex-news-bot.git
cd tele-forex-news-bot
npm ci
cp .env.example .env
```

Edit `.env`, then start the bot:

```bash
npm start
```

For local smoke tests while another deployment is already polling the same Telegram token:

```bash
TELEGRAM_MODE=disabled npm start
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | | Telegram bot token. `TELEGRAM_TOKEN` is also supported. |
| `TELEGRAM_CHAT_ID` | Yes | | Default chat for scheduled alerts. `CHAT_ID` is also supported. |
| `TARGET_TZ` | No | `Asia/Singapore` | IANA timezone used for parsing, reports, and scheduling. |
| `STORE_PATH` | No | `data/store.json` | Persistent state file. Use an absolute path on a persistent volume in hosted deployments. |
| `PUBLIC_CALENDAR_FEED_URL` | No | `https://nfs.faireconomy.media/ff_calendar_thisweek.json` | Calendar-feed baseline enriched with HTML data when available. |
| `ALLOWED_CHAT_IDS` | No | `TELEGRAM_CHAT_ID` | Comma-separated chats allowed to use commands. Notification preferences can only be changed in the configured notification chat. |
| `TELEGRAM_MODE` | No | `polling` | `polling`, `webhook`, or `disabled`. |
| `TELEGRAM_POLLING_INTERVAL_MS` | No | `5000` | Delay between Telegram polling requests. Keeps transient gateway errors from retrying too aggressively. |
| `TELEGRAM_POLLING_TIMEOUT_SECONDS` | No | `30` | Telegram long-poll timeout. |
| `TELEGRAM_POLLING_ERROR_LOG_THROTTLE_SECONDS` | No | `60` | Minimum seconds between repeated transient polling error logs. |
| `TELEGRAM_WEBHOOK_URL` | Webhook only | | Full public webhook URL. |
| `TELEGRAM_WEBHOOK_PATH` | No | `/telegram/webhook` | Express route used for Telegram webhook updates. |
| `TELEGRAM_WEBHOOK_SECRET` | No | | Secret token checked on webhook requests. |
| `TELEGRAM_SEND_RETRY_ATTEMPTS` | No | `2` | Retries for failed Telegram sends. |
| `TELEGRAM_SEND_RETRY_DELAY_SECONDS` | No | `2` | Delay between Telegram send retries. |
| `TELEGRAM_MESSAGE_CHUNK_SIZE` | No | `3800` | Target maximum HTML message size; accepts `1000` through `4096`. Long messages are split safely. |
| `SCRAPE_DELAY_SECONDS` | No | `5` | First result scrape after event release. |
| `RESULT_RETRY_ATTEMPTS` | No | `60` | Retries if released values are still blank. Runtime uses at least `60` attempts even if this is configured lower. |
| `RESULT_RETRY_DELAY_SECONDS` | No | `30` | Delay between result retries. |
| `RELEASE_CATCHUP_MINUTES` | No | `60` | On startup/reschedule, retry recently released events from this many minutes back. |
| `WARNING_MINUTES` | No | `10` | Pre-release warning lead time. |
| `SUMMARY_HOUR` | No | `6` | Daily summary hour in target timezone. |
| `RESCHEDULE_INTERVAL_MINUTES` | No | `30` | How often the bot refreshes calendar schedules. |
| `SENT_EVENT_TTL_DAYS` | No | `14` | Removes timestamped release dedupe entries older than this many days. |
| `FALLBACK_PROVIDER` | No | `none` | Optional fallback provider. Use `tradingeconomics` to enable Trading Economics lookups. |
| `TRADING_ECONOMICS_API_KEY` | Fallback only | | API key used when `FALLBACK_PROVIDER=tradingeconomics`. |
| `FALLBACK_MATCH_WINDOW_MINUTES` | No | `180` | Maximum time difference for matching fallback calendar rows. |
| `SUMMARY_CURRENCIES` | No | all | Optional comma-separated currencies for summary and `/check`. |
| `SUMMARY_IMPACTS` | No | all | Optional comma-separated impacts for summary and `/check`. |
| `ALERT_CURRENCIES` | No | all | Optional comma-separated currencies for warnings/results. |
| `ALERT_IMPACTS` | No | all | Optional comma-separated impacts for warnings/results. |

See [.env.example](.env.example) for the main configuration template. Additional settings above can be added to `.env` as needed.

## Telegram Commands

| Command | Behavior |
| --- | --- |
| `/next` | Show the full next timed release group, SGT countdown, and cache age. |
| `/check` | Acknowledge immediately, show available cached data, then refresh the calendar report. Plain `check` also works. |
| `/status` | Show compact health and notification settings; use **Details** for full diagnostics. |
| `/pending` | List releases waiting for values and their next retry times. |
| `/pause 1h` | Hold automatic notifications for a duration from `1m` to `24h`. Data collection continues. |
| `/resume` | End a pause early and deliver queued catch-up. |
| `/noise low` | Deliver low-impact and non-economic event alerts silently. |
| `/noise normal` | Restore normal notification requests; individual event mutes remain active. |
| `/help` or `/start` | Show the command guide. |

`/next` shows all events at the next timed release in the cached calendar, including currencies or impacts filtered out of automatic alerts. It discloses cache age. `/check` acknowledges immediately, shows a labelled cached calendar when available, then refreshes the response. Repeated checks share one in-flight request. Weekends retain the existing Monday advance view.

`/status` summarizes calendar availability, pending values, delivery, and notification settings. Its **Details** button shows jobs, source errors, and counters. `/pending` lists delayed values and retry times. All user-facing timestamps use the configured timezone (SGT by default); health JSON retains machine-readable ISO timestamps.

## Notification Controls

`/pause 1h` or `/pause 30m` accepts 1 minute through 24 hours. Data collection continues while warnings, results, summaries and schedule notices are held. The bot checks for automatic resume every 15 seconds, including after a restart. `/resume` resumes early. Catch-up consolidates held warnings into their results, includes actual values and Gold bias, and remains queued on send failure. Large catch-up reports span multiple messages.

`/noise low` makes low-impact and non-economic event alerts silent. `/noise normal` restores normal notification requests. **Mute this event** silences that particular occurrence, including later corrections; it does not delete the event or mute future monthly releases. Telegram's own chat notification settings still apply.

Notification settings can only be changed in `TELEGRAM_CHAT_ID`. Other chats in `ALLOWED_CHAT_IDS` may use read-only commands. Explicit `ALERT_CURRENCIES` and `ALERT_IMPACTS` filters still control which automatic event alerts are sent; noise and mute controls only change their notification sound.

## Alert Lifecycle

1. **Warning:** timed events receive a warning `WARNING_MINUTES` before release, 10 minutes by default.
2. **Value checks:** the first check runs after `SCRAPE_DELAY_SECONDS`, 5 seconds by default. Set `SCRAPE_DELAY_SECONDS=120` for a two-minute first check. Missing numeric actuals are retried rather than sent as confirmed results. Statement-only rows wait while a related numeric result is pending.
3. **Result:** each event gets its own message, replying to its warning when a saved Telegram message ID is available. Simultaneous releases still contribute to the shared Gold analysis. Results delivered at least five minutes after release are labelled **LATE**, with release and observation times shown separately.
4. **Correction:** changed actual, forecast, or previous values produce a new reply to the last result when observed. Delivered releases are checked during regular schedule refreshes for up to 48 hours; this is not a historical revision archive.

Each event has **Why this bias?**, **Open source**, and **Mute/Unmute** controls. Why explains the saved snapshot used for that exact alert, including simultaneous releases, rather than recalculating from newer data. Buttons expire when their saved records are cleaned after 14 days. Results sent before this upgrade may have no reply parent because the old store did not retain Telegram message IDs.

Schedule changes are detected on successful refreshes. Explicit time/status changes replace reminders; a missing row, partial response, or blocked source does **not** establish cancellation. Unknown schedules cannot have timed reminders until the source publishes a time.

## Gold Outlook

Every event in pre-release warnings and result alerts ends with a compact **Gold** line for XAUUSD, including non-US events, low-impact releases, and statements. Daily summaries stay unchanged.

- US inflation, employment, activity, and Fed rate surprises get a data-based **LONG** or **SHORT** bias, with no explanatory paragraph in the alert.
- Unemployment and jobless claims use the opposite direction to employment growth. Only valid, comparable actual/forecast numbers are used; previous values are never treated as consensus.
- Non-US events, ambiguous indicators, in-line results, and conflicting same-time US releases get **NEUTRAL**, not a forced trade recommendation.
- Pre-release warnings for supported numeric indicators and missing or incomplete comparable release data show **WAIT**. Events without a supported directional rule remain **NEUTRAL**.
- Outlooks use all available same-time data, including rows filtered out of alerts or already delivered. Each alert has its own saved context, reply chain and controls. Long messages are split with Telegram HTML formatting preserved.

Example layout using illustrative CPI values:

```text
USD - CPI m/m
├ Act: 0.4%
├ Fcst: 0.3%
├ Prev: 0.2%
├ Surprise: Higher than forecast (+0.1%)
└ Gold : SHORT
```

The French Trade Balance example (`-6.7B` actual versus `-6.0B` forecast) ends with `Gold : NEUTRAL` because its relevance is indirect.

These are transparent economic heuristics, not backtested predictions or measured probabilities. **LONG/SHORT is a data bias, not a confirmed trade entry.** The bot does not fetch live gold, dollar or yield prices, analyze speeches, or account for historical revisions in its bias. Live market confirmation must be checked separately. A missing actual value remains missing; the outlook does not resolve an unavailable data source.

The rate/USD-channel scenarios are an implementation inference informed by the [Federal Reserve's employment and price-stability objectives](https://www.federalreserve.gov/faqs/what-economic-goals-does-federal-reserve-seek-to-achieve-through-monetary-policy.htm). They are not a rule that higher inflation always means lower gold: [World Gold Council research](https://www.gold.org/goldhub/research/beyond-cpi-gold-as-a-strategic-inflation-hedge) highlights the weak, context-dependent relationship between CPI and gold returns.

## Data Sources

The public calendar feed provides a resilient baseline for event times, impact, forecasts, and previous values. The bot then enriches those rows with Forex Factory HTML when available, preserving released `Actual` values. If Cloudflare blocks the HTML page, the feed still keeps the event schedule populated and the bot continues retrying HTML for released `Actual` values.

If Forex Factory lags on `Actual` values, you can optionally enable Trading Economics as an additional secondary source:

```env
FALLBACK_PROVIDER=tradingeconomics
TRADING_ECONOMICS_API_KEY=your_api_key
```

The fallback only fills missing actual values for value-bearing events when country, event time, and event name match confidently. Trading Economics documents calendar snapshot fields such as `Actual`, `Previous`, `Forecast`, `Date`, `Event`, `Country`, `Unit`, and `CalendarId`.

## Health Checks

The bot exposes JSON status at:

```text
/
/health
```

Example fields include `timezone`, `telegramMode`, `lastScrape`, `scrapeWarningCount`, `scheduledJobs`, and active filters.

## Deployment Notes

Use polling mode for a single long-running process. Telegram allows only one active poller per bot token; if another instance is already polling, Telegram returns a `409 Conflict`.

For hosted deployments that expose HTTPS, webhook mode avoids polling conflicts:

```env
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://your-domain.example/telegram/webhook
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=replace_me
```

For local health checks without consuming Telegram updates:

```env
TELEGRAM_MODE=disabled
```

### Updating An Existing Deployment

1. Stop the existing bot process and back up its state file, `data/store.json` or the path set by `STORE_PATH`.
2. Update the deployed code and run `npm ci`, then `npm test`. The tests use local fixtures and do not send live Telegram alerts.
3. Keep the existing state file and point `STORE_PATH` at it if needed. New notification and calendar fields are added automatically; do not replace the file with the example store.
4. Restart a single bot instance using your existing process manager or host. Keep the state file on persistent storage.
5. Run `/status` and `/check` in Telegram. Check calendar freshness and source warnings, then use `/next` and `/pending` to inspect upcoming releases and outstanding values.

Merging or pushing code alone does not restart a running bot unless your deployment is configured to do so. Offline tests verify application behavior, not live provider availability or production Telegram delivery.

## Runtime Data

Runtime state is stored in `data/store.json` by default. This file is intentionally ignored by Git because it contains mutable deployment state such as sent release IDs and last fetch time.

The `qol` section also stores calendar snapshots, sent message IDs, event/context snapshots, deferred alerts and notification preferences. Existing stores migrate automatically without deleting old dedupe entries. **Use a persistent volume for this file in hosted deployments**, or pauses, reply chains and queued catch-up will be lost when the host replaces its filesystem. Only run one process against a store. Completed QOL history is retained for 14 days; deferred entries remain until delivered.

Delivery is at-least-once, not exactly-once: an ambiguous Telegram network timeout or a crash after Telegram accepts a message but before the store write may cause a duplicate. No actual value is invented when providers are unavailable; these QOL changes do not bypass Cloudflare or provide a new market-data source.

Use [data/store.example.json](data/store.example.json) as the initial shape if you need to create the file manually.

## Development

Run tests and syntax checks:

```bash
npm test
```

Run syntax checks only:

```bash
npm run check
```

CI runs the same checks on pushes and pull requests through GitHub Actions.

The suite includes command/service regression tests and an offline smoke test that starts the real app with Telegram disabled, temporary storage and a localhost calendar fixture. The smoke test needs permission to bind localhost ports but does not call Forex Factory or Telegram.

## License

MIT. See [LICENSE](LICENSE).
