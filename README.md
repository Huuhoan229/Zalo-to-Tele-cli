# Zalo-to-Tele CLI

Bridge one or more personal Zalo accounts to one Telegram forum group.

> This project uses `zca-js`, an unofficial Zalo Web API. It can break if Zalo changes behavior and may trigger session restrictions.

## What It Does

- Receives messages from Zalo and forwards them into Telegram forum topics.
- Sends Telegram replies, photos, and image documents back to the correct Zalo conversation.
- Creates one Telegram topic per Zalo conversation.
- Supports multiple Zalo accounts with one Telegram bot and one Telegram forum group.
- Stores Zalo sessions and Telegram topic mappings in MongoDB, so Koyeb free redeploys do not wipe the bridge state.
- Queues matched Zalo messages into MongoDB for a separate local OCR worker.

## Message Flow

```text
Zalo account -> Zalo conversation -> Telegram forum topic
Telegram topic reply/photo -> same Zalo account -> same Zalo conversation
```

When a Zalo message arrives for the first time, the bot creates a Telegram topic.

For one Zalo account:

```text
Zalo - nhom 2
```

For multiple Zalo accounts:

```text
[Zalo 1] Zalo - nhom 2
[Zalo 2] Zalo - nhom 2
```

So if two different Zalo accounts both have a conversation named `nhom 2`, Telegram still receives them in two separate topics. Replying inside `[Zalo 1] Zalo - nhom 2` sends the message back through Zalo account `zalo-1`; replying inside `[Zalo 2] Zalo - nhom 2` sends it through Zalo account `zalo-2`.

Incoming group messages look like:

```text
[Sender name]
Message text
```

Incoming private messages use the conversation title as the prefix. Images from Zalo are sent to Telegram as photos when possible. If Telegram cannot fetch the image URL, the bot falls back to a text message containing the URL.

## Telegram Setup

1. Create a bot with `@BotFather`.
2. Create a Telegram group and enable Topics, so it becomes a forum group.
3. Add the bot to the group.
4. Give the bot permission to read/send messages and manage topics.
5. Get the forum group `chat_id`.

To get IDs locally:

```bash
npm install
npm run telegram:id
```

Then send `/id` inside the Telegram group. Use the `chat_id` value for `TELEGRAM_FORUM_CHAT_ID`. It usually starts with `-100`.

## MongoDB Setup

MongoDB is recommended for Koyeb free because Koyeb free does not provide a persistent volume.

MongoDB stores:

- Zalo login credentials/session
- Zalo conversation to Telegram topic mapping
- Recent bridge messages
- OCR queue documents

Use MongoDB Atlas or another MongoDB server, then set:

```env
MONGODB_URI=mongodb+srv://user:password@cluster0.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=zalo-to-tele
MONGODB_COLLECTION_NAME=bridge_state
MONGODB_QUEUE_COLLECTION_NAME=ocr_queue
```

If MongoDB Atlas cannot connect from Koyeb, check the Atlas Network Access/IP allowlist.

## Single Zalo Account

Use this when you only need one Zalo account.

```env
TELEGRAM_BOT_TOKEN=123456789:replace_me
TELEGRAM_FORUM_CHAT_ID=-1001234567890
WEB_ACCESS_TOKEN=choose_a_private_token

MONGODB_URI=mongodb+srv://user:password@cluster0.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=zalo-to-tele
MONGODB_COLLECTION_NAME=bridge_state
MONGODB_QUEUE_COLLECTION_NAME=ocr_queue

ZALO_LOGIN_MODE=qr
ZALO_CREDENTIALS_FILE=/tmp/zalo/zalo-credentials.json
DATA_FILE=/tmp/zalo/store.json
DOWNLOAD_DIR=/tmp/zalo/downloads

LOCAL_INGEST_ZALO_TITLE=nhom 2
LOG_LEVEL=info
```

Open the web URL and scan the QR with Zalo mobile. After login, the session is saved to MongoDB.

## Multiple Zalo Accounts, One Telegram

Keep the global Telegram and MongoDB env vars, then add `ACCOUNTS_JSON`.

Each account must have a stable unique `id`. Do not rename the `id` after login unless you want it to behave like a new Zalo account with new session/mapping data.

Pretty JSON:

```json
[
  {
    "id": "zalo-1",
    "label": "Zalo 1",
    "zaloLoginMode": "qr",
    "localIngestZaloTitle": "nhom 2"
  },
  {
    "id": "zalo-2",
    "label": "Zalo 2",
    "zaloLoginMode": "qr",
    "localIngestZaloTitle": "nhom 2"
  }
]
```

Koyeb env value can be pasted as one line:

```env
ACCOUNTS_JSON=[{"id":"zalo-1","label":"Zalo 1","zaloLoginMode":"qr","localIngestZaloTitle":"nhom 2"},{"id":"zalo-2","label":"Zalo 2","zaloLoginMode":"qr","localIngestZaloTitle":"nhom 2"}]
```

The accounts inherit these global env vars unless overridden per account:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FORUM_CHAT_ID=-100...
MONGODB_URI=...
MONGODB_DB_NAME=zalo-to-tele
MONGODB_COLLECTION_NAME=bridge_state
MONGODB_QUEUE_COLLECTION_NAME=ocr_queue
ALLOWED_TELEGRAM_USER_IDS=
DOWNLOAD_DIR=/tmp/zalo/downloads
```

Per-account optional fields:

```json
{
  "id": "zalo-1",
  "label": "Zalo 1",
  "zaloLoginMode": "qr",
  "zaloSelfListen": true,
  "zaloCredentialsFile": "/tmp/zalo/zalo-1/zalo-credentials.json",
  "dataFile": "/tmp/zalo/zalo-1/store.json",
  "downloadDir": "/tmp/zalo/zalo-1/downloads",
  "localIngestZaloTitle": "nhom 2",
  "allowedTelegramUserIds": "111111111,222222222"
}
```

## Koyeb Deployment

Deploy this repository as a Koyeb Web Service.

Build command:

```bash
npm install
```

Run command:

```bash
npm start
```

Koyeb sets `PORT` automatically. The app listens on `0.0.0.0`.

Recommended Koyeb env vars:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FORUM_CHAT_ID=-100...
WEB_ACCESS_TOKEN=choose_a_private_token

MONGODB_URI=mongodb+srv://user:password@cluster0.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=zalo-to-tele
MONGODB_COLLECTION_NAME=bridge_state
MONGODB_QUEUE_COLLECTION_NAME=ocr_queue

ZALO_LOGIN_MODE=qr
ZALO_CREDENTIALS_FILE=/tmp/zalo/zalo-credentials.json
DATA_FILE=/tmp/zalo/store.json
DOWNLOAD_DIR=/tmp/zalo/downloads

LOCAL_INGEST_ZALO_TITLE=nhom 2
LOG_LEVEL=info
```

For multiple Zalo accounts, add `ACCOUNTS_JSON` from the section above.

After deploy:

1. Open `https://your-koyeb-app.koyeb.app/?token=YOUR_WEB_ACCESS_TOKEN`.
2. Scan the QR card for each Zalo account.
3. Confirm login on each Zalo mobile account.
4. Send a message in the watched Zalo conversation.
5. The bot creates or reuses the correct Telegram topic and forwards the message.
6. Reply inside that Telegram topic to send back to the same Zalo conversation.

With MongoDB enabled, redeploying Koyeb does not lose Zalo sessions or topic mappings. Temporary downloaded images may be stored in `/tmp` while forwarding, then deleted after use.

## Web Endpoints

- `/` or `/qr-login` shows QR login cards and runtime status.
- `/status` returns JSON status.
- `/qr?account=zalo-1` returns the QR image for one account.
- `/healthz` returns `ok` for health checks.

If `WEB_ACCESS_TOKEN` is set, open URLs with `?token=YOUR_TOKEN` or send it as a bearer token.

## Telegram Commands

- `/id` shows `chat_id`, `message_thread_id`, and sender ID.
- `/topics` lists mapped Telegram topics and Zalo conversations.

## OCR Queue

This bridge only queues OCR jobs. OCR processing should run in a separate local worker.

If `LOCAL_INGEST_ZALO_TITLE=nhom 2`, only non-self messages from Zalo conversations whose title contains `nhom 2` are queued.

Queue documents are stored in MongoDB collection `ocr_queue` by default.

The normal Zalo-to-Telegram bridge keeps running even when the OCR worker is offline.

## Local Run

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:3000/?token=YOUR_WEB_ACCESS_TOKEN
```

## Notes

- Do not commit `.env`.
- Do not commit `sessions/`.
- Do not commit `data/`.
- Do not publish real tokens, QR images, or Zalo session files.
- Keep account `id` values stable when using `ACCOUNTS_JSON`.
