# Zalo-to-Tele CLI

CLI-only bridge between a personal Zalo account and a Telegram forum group.

> Uses `zca-js`, an unofficial Zalo Web API. It can break if Zalo changes behavior and may trigger session restrictions.

## Setup

1. Copy `.env.example` to `.env`.
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

## Run

```bash
npm install
npm start
```

`npm start` runs the bridge and a small QR/status web page.

Open:

- `/` or `/qr-login` to scan the Zalo QR code when QR login is needed.
- `/status` to view bridge status as JSON.
- `/healthz` for a plain health check.

If `WEB_ACCESS_TOKEN` is set, open `/?token=YOUR_TOKEN`.

## Koyeb

Deploy as a Web Service so the QR/status page is reachable from the Koyeb URL.

Build command can stay empty. Run command:

```bash
npm start
```

Koyeb injects `PORT`, so `WEB_PORT` is optional there.

Recommended env vars:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FORUM_CHAT_ID=-100...
WEB_ACCESS_TOKEN=choose_a_private_token
ZALO_LOGIN_MODE=auto
ZALO_CREDENTIALS_FILE=/data/zalo/zalo-credentials.json
DATA_FILE=/data/zalo/store.json
DOWNLOAD_DIR=/data/zalo/downloads
```

Mount a persistent volume at `/data` if your Koyeb plan supports it. Without a volume, QR credentials and topic data can be lost on rebuild/restart.

## Files

- `data/store.json` stores topic mapping and transcripts.
- `sessions/zalo-credentials.json` stores Zalo login credentials.
- `sessions/zalo-qr.png` appears during first QR login.

## Telegram

- `/id` shows chat/thread identifiers.
- `/topics` lists mapped topics.
