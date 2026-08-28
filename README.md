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

`npm start` runs the CLI bridge only.

## Files

- `data/store.json` stores topic mapping and transcripts.
- `sessions/zalo-credentials.json` stores Zalo login credentials.
- `sessions/zalo-qr.png` appears during first QR login.

## Telegram

- `/id` shows chat/thread identifiers.
- `/topics` lists mapped topics.

