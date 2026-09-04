import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ACCOUNTS_FILE = path.join(process.cwd(), 'data', 'accounts.json');

function slugify(value) {
  return String(value || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || `account-${crypto.randomUUID().slice(0, 8)}`;
}

export function resolveAccountPaths(id, baseDir = process.cwd()) {
  return {
    zaloCredentialsFile: path.join(baseDir, 'sessions', id, 'zalo-credentials.json'),
    dataFile: path.join(baseDir, 'data', 'accounts', id, 'store.json'),
    downloadDir: path.join(baseDir, 'downloads', id),
  };
}

export function normalizeAccount(input, baseDir = process.cwd()) {
  const id = slugify(input.id || input.label || input.name);
  const defaultPaths = resolveAccountPaths(id, baseDir);
  const credentialsFile = String(input.zaloCredentialsFile || defaultPaths.zaloCredentialsFile);
  const loginMode =
    ['auto', 'cookie', 'qr'].includes(input.zaloLoginMode)
      ? input.zaloLoginMode
      : process.env.ZALO_LOGIN_MODE?.trim() || 'auto';
  const telegramForumChatId = Number(input.telegramForumChatId || process.env.TELEGRAM_FORUM_CHAT_ID);

  return {
    id,
    label: String(input.label || input.name || 'Zalo account'),
    telegramBotToken: String(input.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramForumChatId,
    allowedTelegramUserIds: String(input.allowedTelegramUserIds || process.env.ALLOWED_TELEGRAM_USER_IDS || '').trim(),
    mongoUri: String(input.mongoUri || process.env.MONGODB_URI || '').trim(),
    mongoDbName: String(input.mongoDbName || process.env.MONGODB_DB_NAME || 'zalo-to-tele').trim(),
    mongoCollectionName: String(input.mongoCollectionName || process.env.MONGODB_COLLECTION_NAME || 'bridge_state').trim(),
    ocrQueueCollectionName: String(input.ocrQueueCollectionName || process.env.MONGODB_QUEUE_COLLECTION_NAME || 'ocr_queue').trim(),
    zaloLoginMode:
      loginMode === 'qr' && existsSync(path.resolve(baseDir, credentialsFile)) ? 'auto' : loginMode,
    zaloSelfListen: input.zaloSelfListen !== false,
    zaloCredentialsFile: credentialsFile,
    dataFile: String(input.dataFile || defaultPaths.dataFile),
    downloadDir: String(input.downloadDir || defaultPaths.downloadDir),
    localIngestUrl: String(input.localIngestUrl || process.env.LOCAL_INGEST_URL || '').trim(),
    localIngestToken: String(input.localIngestToken || process.env.LOCAL_INGEST_TOKEN || '').trim(),
    localIngestZaloTitle: String(input.localIngestZaloTitle || process.env.LOCAL_INGEST_ZALO_TITLE || '').trim(),
    autoStart: Boolean(input.autoStart ?? true),
    enabled: Boolean(input.enabled ?? true),
  };
}

export function createAccountDraft(input, baseDir = process.cwd()) {
  return normalizeAccount(input, baseDir);
}

export function createSeedAccountFromEnv(baseDir = process.cwd()) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const forumChatId = process.env.TELEGRAM_FORUM_CHAT_ID?.trim();

  if (!token || !forumChatId) return null;

  return normalizeAccount(
    {
      id: 'primary',
      label: process.env.ACCOUNT_LABEL?.trim() || 'Primary',
      telegramBotToken: token,
      telegramForumChatId: Number(forumChatId),
      allowedTelegramUserIds: process.env.ALLOWED_TELEGRAM_USER_IDS?.trim() || '',
      mongoUri: process.env.MONGODB_URI?.trim() || '',
      mongoDbName: process.env.MONGODB_DB_NAME?.trim() || 'zalo-to-tele',
      mongoCollectionName: process.env.MONGODB_COLLECTION_NAME?.trim() || 'bridge_state',
      ocrQueueCollectionName: process.env.MONGODB_QUEUE_COLLECTION_NAME?.trim() || 'ocr_queue',
      zaloLoginMode: process.env.ZALO_LOGIN_MODE?.trim() || 'auto',
      zaloSelfListen: process.env.ZALO_SELF_LISTEN?.trim() !== 'false',
      zaloCredentialsFile: process.env.ZALO_CREDENTIALS_FILE?.trim() || '',
      dataFile: process.env.DATA_FILE?.trim() || '',
      downloadDir: process.env.DOWNLOAD_DIR?.trim() || '',
      localIngestUrl: process.env.LOCAL_INGEST_URL?.trim() || '',
      localIngestToken: process.env.LOCAL_INGEST_TOKEN?.trim() || '',
      localIngestZaloTitle: process.env.LOCAL_INGEST_ZALO_TITLE?.trim() || '',
      autoStart: true,
      enabled: true,
    },
    baseDir,
  );
}

function loadAccountsFromEnv() {
  const raw = process.env.ACCOUNTS_JSON?.trim();
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  const accounts = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(accounts)) {
    throw new Error('ACCOUNTS_JSON must be a JSON array or an object with an accounts array.');
  }

  return {
    filePath: 'ACCOUNTS_JSON',
    version: parsed.version || 1,
    accounts,
  };
}

export async function loadAccountsFile(baseDir = process.cwd()) {
  const envAccounts = loadAccountsFromEnv();
  if (envAccounts) return envAccounts;

  const filePath = path.join(baseDir, 'data', 'accounts.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    return {
      filePath,
      version: parsed.version || 1,
      accounts,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const seeded = createSeedAccountFromEnv(baseDir);
    return {
      filePath,
      version: 1,
      accounts: seeded ? [seeded] : [],
    };
  }
}

export async function saveAccountsFile(baseDir = process.cwd(), accounts = []) {
  const filePath = path.join(baseDir, 'data', 'accounts.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    version: 1,
    accounts,
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}
