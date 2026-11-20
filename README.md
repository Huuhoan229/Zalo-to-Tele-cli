# Zalo-to-Tele CLI

Bridge one or more personal Zalo accounts to Telegram forum groups, using a shared management bot. Accounts inherit the default forum group and can select their own group from Telegram.

Current deployment: this bridge runs on **Koyeb** with **MongoDB**; the separate `9router-tele-render` repository runs on **Render** as the AI API. Keep the two existing services. Render deployment for this bridge is an optional alternative.

> This project uses `zca-js`, an unofficial Zalo Web API. It can break if Zalo changes behavior and may trigger session restrictions.

## What It Does

- Receives messages from Zalo and forwards them into Telegram forum topics.
- Sends Telegram replies, photos, and image documents back to the correct Zalo conversation.
- Creates one Telegram topic per Zalo conversation.
- Supports multiple Zalo accounts with one Telegram bot and one Telegram forum group.
- Stores Zalo sessions and Telegram topic mappings in MongoDB across Koyeb or Render redeploys.
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

In Koyeb, open the bridge service's **Settings → Environment variables and files**. If hosting this bridge on Render instead, use its **Environment** settings. Set:

```env
ALLOWED_TELEGRAM_USER_IDS=123456789
```

Find your numeric Telegram user ID by sending `/id` in the forum group. For multiple users, use a comma-separated list. Save the changes and redeploy the bridge service. This deployment variable overrides any older allowlist value saved in the MongoDB account registry.

To send a Zalo message, send text in the Telegram forum topic linked to that Zalo conversation. Photos and image documents are also forwarded. The Telegram bot and mapped Zalo account must both be running. If sending fails, the bot replies in the topic with the permission or delivery error.

If a message does not reach Zalo, check that it is in the correct mapped topic, the Zalo account is running, and your numeric Telegram user ID is included in `ALLOWED_TELEGRAM_USER_IDS`. Use `/topics` to inspect topic mappings and `/id` to check the sender ID. The bridge service logs show delivery errors; the bot also replies with the returned error in the topic.

## MongoDB Setup

Keep the existing MongoDB connection when updating the Koyeb deployment. MongoDB also provides persistent bridge state if this app is hosted on Render Free.

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

If MongoDB Atlas cannot connect from the bridge host, check the Atlas Network Access/IP allowlist.

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

Paste the `ACCOUNTS_JSON` value as one line in the bridge service's environment settings:

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

## Koyeb Bridge + Render 9Router (Current Setup)

Keep `Zalo-to-Tele-cli` on the existing Koyeb Web Service with build command `npm ci` and run command `npm start`. Use `/healthz` for the health check and retain the existing port configuration.

In Koyeb **Settings → Environment variables and files**, add:

```env
TELEGRAM_ADMIN_IDS=your_numeric_telegram_user_id
AI_BASE_URL=https://your-9router-service.onrender.com/v1
AI_API_KEY=your_9router_api_key
AI_MODEL=your_model_or_combo
```

Keep the existing `MONGODB_URI`, database/collection names, Telegram forum ID, Telegram-to-Zalo allowlist, account IDs, OCR settings, and `WEB_ACCESS_TOKEN`. Keep the Telegram bot token in this Koyeb service; update it here if rotating the token. Open `https://your-bridge.koyeb.app/?token=YOUR_WEB_ACCESS_TOKEN` for web QR login, or use `/menu` in a private chat with the management bot.

On the Render service running `9router-tele-render`, remove or clear `TELEGRAM_BOT_TOKEN` to disable its old Telegram listener. Keep its existing 9Router configuration, API keys, and Gist backup settings. It does not need a new MongoDB configuration.

## Render Deployment (Optional Alternative for the Bridge)

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
- `/ping` confirms that Telegram commands are being received and shows the deployed commit when the host provides it.
- `/allowai <telegram_user_id>`, `/denyai <telegram_user_id>`, `/aiusers` manage AI-only Telegram access.
- `/zaloqr [account_id]`, `/addzalo [label]`, `/zaloaccounts`, `/zalostart <account_id>`, and `/zalostop <account_id>` manage Zalo accounts.
- `/zalomode off|command|dm|all [account_id]` controls AI auto-replies for one account. `/zaloai` still works.
- `/telegram <account_id>` shows the bot and destination group for that account.
- `/telegramtest <account_id>` checks forum access and Manage Topics permission without creating a topic.
- `/setforum <account_id> <-100...>` sets a forum group after checking the bot's Manage Topics permission.
- `/bindtopic <account_id> <zalo_conversation_id> <topic_id>` binds a known conversation to an existing topic.
- `/aitest <account_id>` tests the configured 9Router endpoint, key, and model and reports that account's AI mode.

## Telegram Management Menu and AI

Open a private chat with the bot and use `/start` or `/menu`. The menu provides:

- `Chat với AI`: sends questions to an OpenAI-compatible endpoint, including a 9Router deployment.
- `Kết nối Zalo`: starts QR login for the configured Zalo account.
- `Bật/tắt AI Zalo`: opens the account list. Select an account, then open `Chế độ AI` to choose `off`, `command`, `dm`, or `all`.
- `Trạng thái`: shows the Zalo listener and current AI mode.

When you request QR login, add an account, or start an account from Telegram, the bot reports QR scan/phone confirmation, QR expiry or rejection, login failure, and successful connection in the requesting admin's private chat. Success is sent once the bridge is running and the Zalo listener is connected; it includes the account ID, current AI mode, and MongoDB session storage status. If readiness is still unconfirmed after five minutes, the bot asks you to check `/zalostatus` or request a new QR.

Set `TELEGRAM_ADMIN_IDS` to the administrator Telegram ID(s). Use `/id` to look up an ID, then add it in the bridge service's environment settings on Koyeb (or Render if hosting the bridge there) and redeploy. Admins can grant AI-only access to other IDs with `/allowai <telegram_user_id>`, revoke it with `/denyai <telegram_user_id>`, and list it with `/aiusers`. `ALLOWED_TELEGRAM_USER_IDS` still controls who can send messages from Telegram topics back to Zalo; keep these two lists separate if needed.

Configure the AI service with:

```env
AI_BASE_URL=https://your-9router-service.example.com/v1
AI_API_KEY=your_9router_api_key
AI_MODEL=your_model_or_combo
AI_SYSTEM_PROMPT=Bạn là trợ lý hữu ích. Trả lời bằng ngôn ngữ người dùng sử dụng.
```

Use `/zalomode command zalo-1` in Telegram, then send `/ai Xin chào` or `/ask Xin chào` in Zalo. The `command` mode requires one of these commands with a question; regular messages and group mentions alone do not trigger a reply. The `dm` mode auto-replies to private chats, and in groups it replies to commands or mentions. The `all` mode auto-replies to incoming text and images in private chats and groups. AI defaults to `off` for each account. Image analysis requires a model with vision support. AI chat history and access permissions are stored in a dedicated MongoDB control record; each account's AI mode stays with that account's bridge record.

To test from the connected Zalo account itself, explicitly send `/ask Xin chào` or `/ai Xin chào` in a Zalo conversation while that account's AI mode is enabled. Ordinary self-authored messages and AI-generated replies are ignored to avoid loops. `off` disables even explicit self-authored AI commands. AI delivery to Zalo does not depend on Telegram topic creation succeeding. API/delivery errors appear in `/zalostatus` and are reported to Telegram admins, with repeated identical errors limited to one notification per account per minute.

### Configure a Telegram group or existing topic

Open `/menu` → `Tài khoản Zalo` → select an account → `Nhóm/topic Telegram`. The account uses the same bot token as the management bot by default, so adding a Zalo account does not require entering another token. The settings show the bot username and group ID, with buttons to change the group or list and rebind conversation topics. Use `/id` in the target group/topic to obtain `chat_id` and `message_thread_id`. Numeric input prompts can be cancelled with `/cancel`.

Each Zalo conversation has its own topic to keep Telegram-to-Zalo replies unambiguous. The bot normally creates this topic automatically. To choose an existing topic, open `Xem/gán topic` and select the conversation. A topic already mapped to another conversation/account is rejected. Changing the destination group reconnects the bridge with its saved session and archives that group's mappings/history so switching back can restore them; it preserves Zalo credentials, AI mode, and OCR configuration. Group choices made in Telegram persist across redeploys.

### Troubleshoot missing Telegram messages

If `createForumTopic` returns `400: chat not found`, the bot cannot access the configured group. Verify the group ID by sending `/id` inside that group. Add the exact bot shown by `/telegram <account_id>` to the group (especially if you changed to a new bot), enable Topics, and grant the bot administrator permission to Manage Topics. Use `/setforum <account_id> <chat_id>` if the ID differs, then `/telegramtest <account_id>`. Do not recreate MongoDB or rescan Zalo just to fix a Telegram group error.

Group access errors are reported to Telegram admins and pause automatic forwarding retries for 60 seconds to avoid repeatedly calling a broken destination. A successful `/telegramtest` clears this pause immediately. AI replies to Zalo remain independent of the Telegram bridge.

Telegram's `429 Too Many Requests` is a rate limit. The bridge spaces out topic creation and message delivery across all topics in each Telegram group, and retries rejected requests using Telegram's `retry_after` value. Forwarded messages can arrive later during a burst.

If private management commands are silent, try `/ping` and inspect the protected web `/status` response's `telegram` field. It reports transport status, last error, last update time, and deployed commit when available. Polling restarts with backoff after transient failures and no longer drops pending updates during startup. An invalid token is reported separately. Telegram API calls have bounded timeouts, and AI requests run in the background so `/menu`, `/ping`, and other management commands can respond while AI is busy. Keep the token active in only one running service/replica, as before.

In webhook mode, `running` alone only means registration completed; inspect `lastUpdateAt` to confirm commands reached the bot. The QR page has a separate **Bot Telegram** panel showing the actual bot username, version, last received command, queued updates, and the latest delivery error. `TELEGRAM_WEBHOOK_URL` should be the bridge's public HTTPS origin, without a QR token or `/status` path. The bridge verifies `getWebhookInfo` every 20 seconds and restores a missing/changed webhook without dropping queued updates. It deliberately does not call `deleteWebhook` on shutdown, because an old instance shutting down during a rolling deploy must not delete the new instance's bot-global registration.

### Keep Koyeb and Render as separate deployments

The bridge runs on Koyeb and calls 9Router on Render over its public HTTPS API. In the Koyeb bridge service, set `AI_BASE_URL` to the Render 9Router URL ending in `/v1`, then set its API key and model. Keep the Telegram bot token only in the Koyeb bridge service. To use the Render 9Router service only as the AI API, remove `TELEGRAM_BOT_TOKEN` from its Environment settings; this prevents two services polling updates for the same bot. The 9Router service keeps its existing GitHub Gist backup for its SQLite data.

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
