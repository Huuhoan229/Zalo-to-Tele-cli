# Zalo-to-Tele CLI

Bridge a personal Zalo account to a Telegram forum group.

> Uses `zca-js`, an unofficial Zalo Web API. It can break if Zalo changes behavior and may trigger session restrictions.

## Quick Start

1. Create a Telegram bot with `@BotFather` and copy the bot token.
2. Create a Telegram forum group, then get its `chat_id` with `npm run telegram:id`.
3. Copy `.env.example` to `.env` and fill `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_FORUM_CHAT_ID`.
4. Run `npm install` then `npm start`.
5. Open the QR page, scan with Zalo mobile, and confirm login.

## Features

- Zalo to Telegram forum-topic sync
- Telegram to Zalo reply support
- image forwarding
- QR login page for headless deploys
- status endpoint for health checks

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FORUM_CHAT_ID=-100...
```

3. Get the forum chat id:

```bash
npm run telegram:id
```

Send `/id` inside the target forum topic.

## Run locally

```bash
npm install
npm start
```

Open:

- `/` or `/qr-login` to scan Zalo QR
- `/status` for JSON status
- `/healthz` for health checks

If `WEB_ACCESS_TOKEN` is set, open `/?token=YOUR_TOKEN`.

## Koyeb

Deploy as a Web Service.

Run command:

```bash
npm start
```

Recommended env vars on Koyeb:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FORUM_CHAT_ID=-100...
WEB_ACCESS_TOKEN=choose_a_private_token
ZALO_LOGIN_MODE=qr
DOWNLOAD_DIR=downloads
DATA_FILE=data/store.json
ZALO_CREDENTIALS_FILE=sessions/zalo-credentials.json
```

If your plan supports volumes, mount one for persistent credentials and transcripts. On free instances, keep `DOWNLOAD_DIR` small because forwarded media is deleted after a successful handoff.

## Public repo notes

- Do not commit `.env`
- Do not commit `sessions/`
- Do not commit `data/`
- Do not publish real tokens or QR/session files

## Telegram

- `/id` shows chat/thread identifiers
- `/topics` lists mapped topics
