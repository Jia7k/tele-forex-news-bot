# Telegram Forex News Bot

A Node.js Telegram bot that monitors the Forex Factory economic calendar and sends Singapore-time market event summaries, pre-release warnings, and post-release result updates.

## Features

- Scrapes Forex Factory calendar events in `Asia/Singapore` by default.
- Sends daily summaries with complete event counts.
- Sends 10-minute pre-release warnings for timed events.
- Updates released values 2 minutes after release, then keeps retrying if `Actual` is still a placeholder.
- Sends release updates only after an actual value is available.
- Keeps same-time release groups together, so statement-only rows do not get sent while a related numeric value is still pending.
- Catches up on recently missed releases after restarts.
- Provides `/pending` diagnostics for releases still waiting on actual values.
- Supports an optional Trading Economics fallback provider for missing actual values.
- Cleans old sent-release dedupe entries automatically.
- Labels all event times in SGT.
- Includes tentative events in summaries and `/check` reports.
- Supports alert filters by currency and impact.
- Detects actual-vs-forecast surprises where numeric values are available.
- Provides `/status`, `/health`, and JSON runtime diagnostics.
- Supports Telegram polling, webhook mode, and disabled mode for local smoke tests.
- Persists sent release IDs to avoid duplicate result alerts across restarts.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from BotFather
- A Telegram chat ID where alerts should be delivered

## Quick Start

```bash
git clone git@github.com:Jia7k/tele-forex-news-bot.git
cd tele-forex-news-bot
npm install
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
| `ALLOWED_CHAT_IDS` | No | `TELEGRAM_CHAT_ID` | Comma-separated chats allowed to run `/check`, `/status`, and `/pending`. |
| `TELEGRAM_MODE` | No | `polling` | `polling`, `webhook`, or `disabled`. |
| `TELEGRAM_WEBHOOK_URL` | Webhook only | | Full public webhook URL. |
| `TELEGRAM_WEBHOOK_PATH` | No | `/telegram/webhook` | Express route used for Telegram webhook updates. |
| `TELEGRAM_WEBHOOK_SECRET` | No | | Secret token checked on webhook requests. |
| `TELEGRAM_SEND_RETRY_ATTEMPTS` | No | `2` | Retries for failed Telegram sends. |
| `TELEGRAM_SEND_RETRY_DELAY_SECONDS` | No | `2` | Delay between Telegram send retries. |
| `SCRAPE_DELAY_MINUTES` | No | `2` | First result scrape after event release. Runtime uses at least `2` minutes even if this is configured lower. |
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

See [.env.example](.env.example) for a complete template.

## Telegram Commands

```text
/check
/status
/pending
```

`/check` sends the current day report. `/status` shows runtime diagnostics such as last scrape, scheduled jobs, filters, pending groups, and Telegram mode. `/pending` lists release groups still waiting for actual values.

## Optional Fallback Provider

Forex Factory is still the primary source. If it lags on `Actual` values, you can optionally enable Trading Economics as a secondary source:

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

## Runtime Data

Runtime state is stored in `data/store.json` by default. This file is intentionally ignored by Git because it contains mutable deployment state such as sent release IDs and last fetch time.

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

## License

MIT. See [LICENSE](LICENSE).
