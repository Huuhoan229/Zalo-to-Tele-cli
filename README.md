# Zalo-to-Tele CLI

Bridge one or more personal Zalo accounts to one Telegram forum group.

> This project uses `zca-js`, an unofficial Zalo Web API. It can break if Zalo changes behavior and may trigger session restrictions.

## What It Does

- Receives messages from Zalo and forwards them into Telegram forum topics.
- Sends Telegram replies, photos, and image documents back to the correct Zalo conversation.
- Creates one Telegram topic per Zalo conversation.
- Supports multiple Zalo accounts with one Telegram bot and one Telegram forum group.
- Stores Zalo sessions and Telegram topic mappings in MongoDB, so Render redeploys do not wipe the bridge state.
- Queues matched Zalo messages into MongoDB for a separate local OCR worker.
- Provides a private Telegram management menu for AI chat, Zalo QR login, status, and AI auto-reply mode.

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
Put each authorized Telegram user ID in `ALLOWED_TELEGRAM_USER_IDS`. An empty allowlist disables Telegram-to-Zalo forwarding; `/id` remains available so you can look up the ID.

### Allow Telegram replies to reach Zalo

In the Render dashboard, open the service's **Environment** settings and set:

```env
ALLOWED_TELEGRAM_USER_IDS=123456789
```

Find your numeric Telegram user ID by sending `/id` in the forum group. For multiple users, use a comma-separated list. Save the changes and redeploy the Render service. This deployment variable overrides any older allowlist value saved in the MongoDB account registry.

To send a Zalo message, send text in the Telegram forum topic linked to that Zalo conversation. Photos and image documents are also forwarded. The Telegram bot and mapped Zalo account must both be running. If sending fails, the bot replies in the topic with the permission or delivery error.

If a message does not reach Zalo, check that it is in the correct mapped topic, the Zalo account is running, and your numeric Telegram user ID is included in `ALLOWED_TELEGRAM_USER_IDS`. Use `/topics` to inspect topic mappings and `/id` to check the sender ID. Render's service logs show delivery errors; the bot also replies with the returned error in the topic.

## MongoDB Setup

MongoDB is recommended for Render Free because the service filesystem is ephemeral.

MongoDB stores:

- Zalo login credentials/session
- Zalo conversation to Telegram topic mapping
- Recent bridge messages
- OCR queue documents

Bridge transcript records are automatically compacted after one day and removed after seven days. The bridge keeps at most 500 recent message records per account for duplicate detection and Telegram-to-Zalo quote replies. These limits can be changed with `TRANSCRIPT_FULL_RETENTION_DAYS` and `TRANSCRIPT_RETENTION_DAYS`. Zalo attachments and stickers are stored as small URL/metadata references, not image bytes.

Use MongoDB Atlas or another MongoDB server, then set:

```env
MONGODB_URI=mongodb+srv://user:password@cluster0.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=zalo-to-tele
MONGODB_COLLECTION_NAME=bridge_state
MONGODB_QUEUE_COLLECTION_NAME=ocr_queue
TRANSCRIPT_FULL_RETENTION_DAYS=1
TRANSCRIPT_RETENTION_DAYS=7
```

If MongoDB Atlas cannot connect from Render, check the Atlas Network Access/IP allowlist.

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

Paste the `ACCOUNTS_JSON` value as one line in the Render environment settings:

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

## Render Deployment

Deploy this repository as a Render Web Service using the included `render.yaml` Blueprint.

Build command:

```bash
npm install
```

Run command:

```bash
npm start
```

Render sets `PORT` automatically. The app listens on `0.0.0.0`.

Set the required Render environment variables:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FORUM_CHAT_ID=-100...
TELEGRAM_ADMIN_IDS=123456789
WEB_ACCESS_TOKEN=choose_a_private_token

AI_BASE_URL=https://your-9router-service.onrender.com/v1
AI_API_KEY=your_9router_api_key
AI_MODEL=your_model_or_combo

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

After deployment:

1. Open `https://<your-service>.onrender.com/?token=YOUR_WEB_ACCESS_TOKEN`.
2. Scan the QR card for each Zalo account.
3. Confirm login on each Zalo mobile account.
4. Send a message in the watched Zalo conversation.
5. The bot creates or reuses the correct Telegram topic and forwards the message.
6. Reply inside that Telegram topic to send back to the same Zalo conversation.

With MongoDB enabled, redeploying Render does not lose Zalo sessions or topic mappings. Temporary downloaded images may be stored in `/tmp` while forwarding, then deleted after use.

Render Free services may sleep after a period without inbound web traffic. A periodic external request to `/healthz` can keep the service active, but uses its free instance hours. When the service sleeps, Telegram polling and the Zalo listener pause until it wakes.

## Keep Render Awake With Cron

You can use an external cron monitor to ping the health endpoint every few minutes:

```text
https://<your-service>.onrender.com/healthz
```

Suggested interval:

```text
*/5 * * * *
```

Any cron/uptime service that can send an HTTP GET request is fine. Examples:

- cron-job.org
- UptimeRobot
- EasyCron
- GitHub Actions scheduled workflow

The `/healthz` endpoint returns:

```text
ok
```

`/healthz` does not require `WEB_ACCESS_TOKEN`, so uptime monitors can call it directly. Keep `WEB_ACCESS_TOKEN` enabled for the QR/status pages:

```text
https://<your-service>.onrender.com/?token=YOUR_WEB_ACCESS_TOKEN
```

This ping keeps the web service responsive and may consume Render's free instance hours. The persistent data still comes from MongoDB, so keep `MONGODB_URI` configured.

## Web Endpoints

- `/` or `/qr-login` shows QR login cards and runtime status.
- `/status` returns JSON status.
- `/qr?account=zalo-1` returns the QR image for one account.
- `/healthz` returns `ok` for health checks.

If `WEB_ACCESS_TOKEN` is set, open URLs with `?token=YOUR_TOKEN` or send it as a bearer token.

## Telegram Commands

- `/id` shows `chat_id`, `message_thread_id`, and sender ID.
- `/topics` lists mapped Telegram topics and Zalo conversations.
- `/menu` opens the private management menu.
- `/allowai <telegram_user_id>`, `/denyai <telegram_user_id>`, `/aiusers` manage AI-only Telegram access.
- `/zaloqr [account_id]`, `/addzalo [label]`, `/zaloaccounts`, `/zalostart <account_id>`, and `/zalostop <account_id>` manage Zalo accounts.
- `/zaloai off|command|dm|all [account_id]` controls AI auto-replies for one account.

## Telegram Management Menu and AI

Open a private chat with the bot and use `/start` or `/menu`. The menu provides:

- `Chat với AI`: sends questions to an OpenAI-compatible endpoint, including a 9Router deployment.
- `Kết nối Zalo`: starts QR login for the configured Zalo account.
- `Bật/tắt AI Zalo`: opens the account list; each account has an AI toggle between `dm` and `off`.
- `Trạng thái`: shows the Zalo listener and current AI mode.

Set `TELEGRAM_ADMIN_IDS` to the administrator Telegram ID(s). Use `/id` to look up an ID, then add it in Render's Environment settings and redeploy. Admins can grant AI-only access to other IDs with `/allowai <telegram_user_id>`, revoke it with `/denyai <telegram_user_id>`, and list it with `/aiusers`. `ALLOWED_TELEGRAM_USER_IDS` still controls who can send messages from Telegram topics back to Zalo; keep these two lists separate if needed.

Configure the AI service with:

```env
AI_BASE_URL=https://your-9router-service.example.com/v1
AI_API_KEY=your_9router_api_key
AI_MODEL=your_model_or_combo
AI_SYSTEM_PROMPT=Bạn là trợ lý hữu ích. Trả lời bằng ngôn ngữ người dùng sử dụng.
```

The bot supports `/ask <câu hỏi>` and `/zaloai off|command|dm|all [account_id]`. In `command` mode, Zalo replies require `/ask`, `/ai`, or an explicit group mention; `dm` also replies to private chats; `all` replies to all incoming text messages and images. AI defaults to `off` for each Zalo account. Image analysis requires a model with vision support. AI chat history and AI access permissions are stored in a dedicated MongoDB control record; each account's Zalo AI mode stays with that account's bridge record.

### Keep the two Render deployments

The bridge and 9Router can remain separate Render services. Set `AI_BASE_URL` to the 9Router service URL ending in `/v1`, then set its API key and model in the bridge service. Keep the Telegram bot token only in this bridge service. To use the 9Router service only as the AI API, remove `TELEGRAM_BOT_TOKEN` from its Environment settings; this prevents two services polling updates for the same bot. The 9Router service can keep its existing GitHub Gist backup for its SQLite data.

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
