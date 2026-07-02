# Contributing

Thanks for improving this bot. Keep changes small, tested, and easy to deploy.

## Local Setup

```bash
npm install
cp .env.example .env
```

Fill in your local `.env`. Do not commit `.env` or `data/store.json`.

## Checks

Before opening a pull request or pushing to `main`, run:

```bash
npm test
```

This runs syntax checks and the Node test suite.

## Runtime Safety

- Use `TELEGRAM_MODE=disabled` for local smoke tests when a deployed bot is already polling the same token.
- Keep `data/store.json` local; it stores deployment state and release-alert dedupe IDs.
- Add tests for parser, time, config, or formatting changes whenever possible.

## Pull Requests

Include:

- What changed
- How it was tested
- Any deployment or environment variable changes
