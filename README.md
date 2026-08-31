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
MONGODB_URI=mongodb+srv://...
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
ZALO_CREDENTIALS_FILE=sessions/zalo-credentials.json
MONGODB_URI=mongodb+srv://...
MONGODB_DB_NAME=zalo-to-tele
MONGODB_COLLECTION_NAME=bridge_state
MONGODB_QUEUE_COLLECTION_NAME=ocr_queue
LOCAL_INGEST_ZALO_TITLE=nhom 2
```

With MongoDB enabled, Zalo credentials and topic mappings survive redeploys. If you do not set `MONGODB_URI`, the app falls back to the local `data/store.json` file.

If `MONGODB_QUEUE_COLLECTION_NAME` is set, every non-self Zalo message from the matched `LOCAL_INGEST_ZALO_TITLE` conversation is queued in Mongo for the local OCR worker to pull. The normal Zalo-to-Telegram bridge keeps running even when the OCR worker is offline.

## Public repo notes

- Do not commit `.env`
- Do not commit `sessions/`
- Do not commit `data/`
- Do not publish real tokens or QR/session files

## Telegram

- `/id` shows chat/thread identifiers
- `/topics` lists mapped topics
