import fs from 'node:fs';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalPath(name, fallback) {
  const raw = process.env[name]?.trim() || fallback;
  return path.isAbsolute(raw) ? raw : path.join(rootDir, raw);
}

function parseAllowedUsers(raw) {
  return new Set(
    (raw || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => Number.isSafeInteger(item)),
  );
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  rootDir,
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramForumChatId: Number(required('TELEGRAM_FORUM_CHAT_ID')),
  webPort: parsePort(process.env.PORT || process.env.WEB_PORT, 3000),
  webAccessToken: process.env.WEB_ACCESS_TOKEN?.trim() || '',
  allowedTelegramUserIds: parseAllowedUsers(process.env.ALLOWED_TELEGRAM_USER_IDS),
  mongoUri: process.env.MONGODB_URI?.trim() || '',
  mongoDbName: process.env.MONGODB_DB_NAME?.trim() || 'zalo-to-tele',
  mongoCollectionName: process.env.MONGODB_COLLECTION_NAME?.trim() || 'bridge_state',
  zaloCredentialsFile: optionalPath('ZALO_CREDENTIALS_FILE', 'sessions/zalo-credentials.json'),
  dataFile: optionalPath('DATA_FILE', 'data/store.json'),
  downloadDir: optionalPath('DOWNLOAD_DIR', 'downloads'),
  zaloLoginMode:
    process.env.ZALO_LOGIN_MODE?.trim() === 'qr' &&
    fs.existsSync(optionalPath('ZALO_CREDENTIALS_FILE', 'sessions/zalo-credentials.json'))
      ? 'auto'
      : process.env.ZALO_LOGIN_MODE?.trim() || 'auto',
  zaloSelfListen: process.env.ZALO_SELF_LISTEN?.trim() !== 'false',
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
};
