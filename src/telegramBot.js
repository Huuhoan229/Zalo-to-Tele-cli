import crypto from 'node:crypto';
import { Input, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'node:fs/promises';
import { ensureDir, uniqueDownloadPath } from './media.js';
import { boundTelegramApi, BoundedTelegramContext, normalizedMenuText } from './telegramTransport.js';
import { TelegramGroupQueue, telegramRateLimitSeconds } from './telegramGroupQueue.js';
import { getVietnamDateParts } from './evn.js';
import { PRESET_VIETNAM_LOCATIONS } from './weather.js';

const runtimes = new Map();
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Global registry: webhookPath → Telegraf webhookCallback handler.
 * The HTTP server reads this Map to route incoming Telegram updates.
 * Exported so cli.js can pass it to startWebServer().
 */
export const webhookHandlers = new Map();

const MANAGEMENT_MENU = Markup.keyboard([
  ['💬 Chat với AI', '🔗 Kết nối Zalo'],
  ['➕ Thêm tài khoản Zalo', '📋 Tài khoản Zalo'],
  ['🤖 Bật/tắt AI Zalo', '📊 Trạng thái'],
  ['⚡ Tiền điện EVN', '🌤 Thời tiết'],
  ['🔐 Quyền chat AI', '🧹 Xóa lịch sử AI'],
]).resize();
const AI_USER_MENU = Markup.keyboard([['💬 Chat với AI'], ['🧹 Xóa lịch sử AI']]).resize();

function splitTelegramText(value, maxLength = 4000) {
  const text = String(value || '');
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxLength) chunks.push(text.slice(offset, offset + maxLength));
  return chunks.length ? chunks : [''];
}

async function telegramPhotoDataUrl(ctx) {
  const photo = ctx.message?.photo?.at(-1);
  if (!photo) throw new Error('Không tìm thấy ảnh Telegram.');
  const link = await ctx.telegram.getFileLink(photo.file_id);
  const response = await fetch(link, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Không tải được ảnh Telegram: HTTP ${response.status}`);
  const mime = response.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Webhook body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function updateChatKey(update) {
  const chat = update?.message?.chat || update?.callback_query?.message?.chat || update?.edited_message?.chat || update?.message_reaction?.chat;
  return chat?.id !== undefined ? String(chat.id) : 'global';
}

const MAX_ZALO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v']);
const VOICE_EXTENSIONS = new Set(['ogg', 'opus', 'm4a', 'aac']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac']);
const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip',
};

const TELEGRAM_TO_ZALO_REACTION = new Map([
  ['❤️', '/-heart'], ['❤', '/-heart'], ['♥️', '/-heart'], ['♥', '/-heart'], ['😍', '/-heart'], ['🥰', '/-heart'], ['💕', '/-heart'], ['💖', '/-heart'],
  ['👍', '/-strong'], ['🔥', '/-strong'], ['💯', '/-strong'], ['⚡', '/-strong'], ['🫡', '/-strong'],
  ['😂', ':>'], ['🤣', ':>'], ['😄', ':>'], ['😆', ':>'], ['😁', ':>'],
  ['😮', ':o'], ['😱', ':o'], ['🤯', ':o'], ['😲', ':o'],
  ['😢', ':-(( '].map((s) => s.trim()), ['😭', ':-(( '].map((s) => s.trim()), ['😥', ':-(( '].map((s) => s.trim()),
  ['😡', ':-h'], ['🤬', ':-h'], ['😠', ':-h'],
  ['👎', '/-weak'],
  ['😘', ':-*'], ['💋', ':-*'],
  ['💔', '/-break'],
  ['💩', '/-shit'],
  ['🌹', '/-rose'], ['🌸', '/-rose'],
  ['🙏', '_()_'],
  ['👏', ':handclap'], ['🙌', ':handclap'],
  ['🎉', '/-bd'], ['🎂', '/-bd'], ['🥳', '/-bd'],
  ['🍺', '/-beer'], ['🍻', '/-beer'],
  ['👌', '/-ok'], ['✅', '/-ok'],
  ['✌️', '/-v'], ['✌', '/-v'],
  ['😎', 'x-)'], ['🤓', '8-)'],
  ['🤔', ';-/'], ['😉', ';-)'],
  ['heart', '/-heart'], ['tim', '/-heart'], ['love', '/-heart'],
  ['like', '/-strong'],
  ['haha', ':>'], ['cuoi', ':>'],
  ['wow', ':o'],
  ['sad', ':-(('], ['cry', ':-(('], ['buon', ':-(('],
  ['angry', ':-h'], ['gian', ':-h'],
  ['dislike', '/-weak'],
  ['ok', '/-ok'],
  ['off', ''], ['none', ''], ['clear', ''], ['xoa', ''],
]);

const ZALO_TO_TELEGRAM_REACTION = new Map([
  ['/-heart', '❤'], [';xx', '❤'], ['/-loveu', '❤'],
  ['/-strong', '👍'], ['/-ok', '👌'], ['/-v', '👍'], ['/-thanks', '🙏'],
  [':>', '🤣'], [":')", '🤣'], [';-d', '🤣'], [':))', '🤣'],
  [':o', '😱'], [':-o', '😱'],
  [':-((', '😢'], ['--b', '😢'], [':((', '😢'], ['p-(', '😢'], [':-<', '😢'], ['&-(', '😢'],
  [':-h', '😡'], ['>-|', '😡'],
  ['/-weak', '👎'], ['/-no', '👎'], ['/-bad', '👎'],
  [':-*', '😘'],
  ['/-break', '💔'],
  ['/-shit', '💩'],
  ['/-rose', '❤'],
  ['_()_', '🙏'],
  [':handclap', '👏'],
  ['/-bd', '🎉'],
  ['/-beer', '🎉'],
  ['x-)', '😎'], ['b-)', '😎'], ['8-)', '🤓'],
  [';-/', '🤔'],
  [';-)', '👌'],
]);

export function telegramReactionToZalo(input) {
  if (input === '' || input === null || input === undefined) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  if (TELEGRAM_TO_ZALO_REACTION.has(raw)) return TELEGRAM_TO_ZALO_REACTION.get(raw);
  const normalized = raw.replace(/[\uFE0E\uFE0F]/g, '').toLowerCase();
  if (TELEGRAM_TO_ZALO_REACTION.has(normalized)) return TELEGRAM_TO_ZALO_REACTION.get(normalized);
  return '/-heart';
}

export function zaloReactionToTelegram(rIcon) {
  const raw = String(rIcon || '').trim();
  if (!raw) return null;
  return ZALO_TO_TELEGRAM_REACTION.get(raw) || '❤';
}

function fileExtension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : '';
}

function safeFilename(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
}

// Download a Zalo attachment on our server, so Telegram does not have to fetch
// Zalo's CDN itself (it often fails with "failed to get HTTP URL content").
export async function downloadZaloAttachment(attachment, { fetchImpl = fetch, timeoutMs = 30000, maxBytes = MAX_ZALO_ATTACHMENT_BYTES } = {}) {
  const response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Không tải được tệp Zalo: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw Object.assign(new Error('Tệp Zalo lớn hơn 20 MB'), { tooLarge: true });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error('Tệp Zalo lớn hơn 20 MB'), { tooLarge: true });
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let filename = safeFilename(attachment.title && attachment.title !== 'attachment' && attachment.title !== 'sticker' ? attachment.title : '');
  let ext = fileExtension(filename);
  if (!ext) {
    const fallbackExt = attachment.type === 'voice' ? 'm4a' : attachment.type === 'video' ? 'mp4' : mime.startsWith('image/') ? 'jpg' : 'bin';
    ext = MIME_EXTENSIONS[mime] || fileExtension(new URL(attachment.url).pathname) || fallbackExt;
    const baseName = filename || (attachment.type === 'sticker' ? 'sticker' : attachment.type === 'voice' ? 'voice' : attachment.type === 'video' ? 'video' : 'zalo-file');
    filename = `${baseName}.${ext}`;
  }
  let kind = 'document';
  if (attachment.type === 'sticker' || IMAGE_EXTENSIONS.has(ext) || (mime.startsWith('image/') && mime !== 'image/gif')) kind = 'photo';
  else if (attachment.type === 'video' || VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) kind = 'video';
  else if (attachment.type === 'voice' || VOICE_EXTENSIONS.has(ext) || mime === 'audio/ogg' || mime === 'audio/opus' || mime === 'audio/aac' || mime === 'audio/mp4' || mime === 'audio/x-m4a') kind = 'voice';
  else if (AUDIO_EXTENSIONS.has(ext) || mime.startsWith('audio/')) kind = 'audio';
  return { buffer, filename, kind, mime };
}

function webhookPathForToken(token) {
  // Derive a secret path from the bot token so random HTTP clients can't
  // fake Telegram updates. 24 hex chars = 96-bit entropy.
  return `/telegram-webhook/${crypto.createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
}

function topicName(title, accountLabel = '') {
  const prefix = accountLabel ? `[${accountLabel}] ` : '';
  return `${prefix}Zalo - ${String(title || 'Unknown')}`.slice(0, 128);
}

function isAllowed(config, userId) {
  return config.allowedTelegramUserIds.has(userId);
}

function isTelegramThreadNotFound(error) {
  const description = String(error?.response?.description || error?.description || error?.message || '');
  return error?.response?.error_code === 400 && /message thread not found/i.test(description);
}

function isTelegramDestinationError(error) {
  const code = error?.response?.error_code;
  const description = String(error?.response?.description || error?.message || '');
  return (code === 400 || code === 403) && /chat not found|bot was kicked|bot is not a member|not enough rights|need administrator|CHAT_ADMIN_REQUIRED|forbidden/i.test(description);
}

function formatZaloMessage(zaloMessage) {
  const prefix = zaloMessage.isGroup
    ? `[${zaloMessage.senderName}]`
    : `[${zaloMessage.title || zaloMessage.senderName}]`;
  const quoted = zaloMessage.replyTo?.text
    ? `↪ Trả lời ${zaloMessage.replyTo.senderName ? `[${zaloMessage.replyTo.senderName}]` : ''}: ${zaloMessage.replyTo.text}\n\n`
    : '';
  const defaultAttachmentLabel =
    zaloMessage.attachment?.type === 'sticker'
      ? '🎭 Sticker'
      : zaloMessage.attachment?.type === 'voice'
        ? '🎤 Tin nhắn thoại'
        : zaloMessage.attachment?.type === 'video'
          ? '🎬 Video'
          : zaloMessage.attachment?.title;
  const body = zaloMessage.text || defaultAttachmentLabel || '(non-text message)';
  return `${prefix}\n${quoted}${body}`;
}

function quoteDataForZalo(zaloMessage) {
  const data = zaloMessage.raw?.data;
  if (!data || (!data.msgId && !data.cliMsgId)) return null;
  const keys = ['content', 'msgType', 'propertyExt', 'uidFrom', 'msgId', 'cliMsgId', 'ts', 'ttl'];
  return Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

function telegramSenderName(ctx) {
  const parts = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean);
  return ctx.from?.username || parts.join(' ') || String(ctx.from?.id || 'Telegram');
}

function humanError(error) {
  let text = String(error?.response?.description || error?.message || error || 'Unknown error');
  for (const key of [process.env.AI_API_KEY, process.env.ROUTER_API_KEY, process.env.TELEGRAM_BOT_TOKEN, process.env.EVN_PASSWORD]) {
    if (key) text = text.replaceAll(key, '[redacted]');
  }
  return text.slice(0, 500);
}

function runtimeKey(config) {
  // A token owns exactly one getUpdates/webhook consumer, even across groups.
  return config.telegramBotToken;
}

class SharedTelegramRuntime {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.bot = this.createBot();
    this.bridges = new Set();
    this.handlersRegistered = false;
    this.started = false;
    this.startingPromise = null;
    this.processedUpdates = new Map();
    this.inFlightUpdates = new Set();
    this.updateChains = new Map();
    this.manager = null;
    this.controlStarted = false;
    this.pendingSettings = new Map();
    this.pollingTask = null;
    this.retryTimer = null;
    this.retryCount = 0;
    this.generation = 0;
    this.lastTransportError = null;
    this.lastUpdateAt = null;
    this.transportStatus = 'stopped';
    this.aiJobs = new Map();
    this.groupQueue = new TelegramGroupQueue();
    this.webhookTimer = null;
    this.webhookCheck = null;
    this.webhookState = null;
    this.lastWebhookRequestAt = null;
    this.evnTimer = null;
    this.evnCheckPromise = null;
    // Webhook mode: đọc TELEGRAM_WEBHOOK_URL từ env (setting toàn deployment).
    // Nếu không set → fallback về long polling (chạy local).
    const webhookInput = process.env.TELEGRAM_WEBHOOK_URL?.trim() || '';
    // Our HTTP server serves webhook paths at the origin root. A QR-page query
    // or copied /status path must never become part of the Telegram endpoint.
    const webhookBaseUrl = webhookInput ? new URL(webhookInput).origin : '';
    this.webhookBaseUrl = webhookBaseUrl;
    this.webhookPath = webhookBaseUrl ? webhookPathForToken(config.telegramBotToken) : null;
    // update_id is only unique per bot; scope durable claims to this token.
    this.updateKeyPrefix = crypto.createHash('sha256').update(String(config.telegramBotToken)).digest('hex').slice(0, 12);
  }

  get isWebhookMode() {
    return Boolean(this.webhookBaseUrl && this.webhookPath);
  }

  createBot() {
    const bot = new Telegraf(this.config.telegramBotToken, { contextType: BoundedTelegramContext, handlerTimeout: 25000 });
    boundTelegramApi(bot.telegram);
    return bot;
  }

  snapshot() {
    return {
      status: this.transportStatus,
      mode: this.isWebhookMode ? 'webhook' : 'polling',
      lastError: this.lastTransportError,
      lastUpdateAt: this.lastUpdateAt,
      retryCount: this.retryCount,
      aiJobs: this.aiJobs.size,
      version: (process.env.KOYEB_GIT_SHA || process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
      botUsername: this.bot.botInfo?.username || null,
      botId: this.bot.botInfo?.id || null,
      webhook: this.webhookState,
      lastWebhookRequestAt: this.lastWebhookRequestAt,
    };
  }

  stopTransport(reason = 'manual') {
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.webhookTimer);
    this.webhookTimer = null;
    clearInterval(this.evnTimer);
    this.evnTimer = null;
    if (this.isWebhookMode) {
      webhookHandlers.delete(this.webhookPath);
      // Do not delete a bot-global webhook here: a newer deployment may have
      // registered the same bot before this old instance receives SIGTERM.
    } else {
      try { this.bot.stop(reason); } catch { /* launch may still be awaiting getMe */ }
    }
    this.started = false;
    this.transportStatus = 'stopped';
  }

  async refreshWebhook() {
    if (!this.isWebhookMode || !this.started) return;
    if (this.webhookCheck) return this.webhookCheck;
    const generation = this.generation;
    this.webhookCheck = (async () => {
      const expectedUrl = `${this.webhookBaseUrl}${this.webhookPath}`;
      try {
        let info = await this.bot.telegram.getWebhookInfo();
        if (generation !== this.generation || !this.started) return;
        let repaired = false;
        if (info.url !== expectedUrl) {
          this.logger.warn('Telegram webhook was removed or changed; restoring this deployment endpoint.');
          await this.bot.telegram.setWebhook(expectedUrl, { drop_pending_updates: false, allowed_updates: ['message', 'callback_query', 'message_reaction'] });
          if (generation !== this.generation || !this.started) return;
          info = await this.bot.telegram.getWebhookInfo();
          repaired = true;
        }
        if (generation !== this.generation || !this.started) return;
        const lastError = info.last_error_message ? humanError(info.last_error_message) : null;
        this.webhookState = {
          registered: Boolean(info.url),
          matchesExpectedUrl: info.url === expectedUrl,
          pendingUpdateCount: info.pending_update_count || 0,
          lastDeliveryError: lastError,
          lastDeliveryErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
          checkedAt: new Date().toISOString(),
          ...(repaired ? { restoredAt: new Date().toISOString() } : {}),
        };
        if (lastError) this.logger.warn({ error: lastError, pendingUpdates: this.webhookState.pendingUpdateCount }, 'Telegram reports a webhook delivery error.');
      } catch (error) {
        if (generation !== this.generation || !this.started) return;
        this.webhookState = { ...this.webhookState, checkError: humanError(error), checkedAt: new Date().toISOString() };
        this.logger.warn({ error: humanError(error) }, 'Could not verify Telegram webhook registration.');
      }
    })().finally(() => { this.webhookCheck = null; });
    return this.webhookCheck;
  }

  scheduleReconnect(error, generation = this.generation) {
    if (generation !== this.generation || this.retryTimer || (!this.controlStarted && this.bridges.size === 0)) return;
    this.started = false;
    this.lastTransportError = humanError(error);
    const code = error?.response?.error_code || error?.code;
    if (code === 401 || code === 404) {
      this.transportStatus = 'invalid-token';
      this.logger.error({ error: this.lastTransportError }, 'Telegram bot token was rejected; update TELEGRAM_BOT_TOKEN.');
      return;
    }
    this.transportStatus = 'reconnecting';
    const delay = Math.min(2000 * (2 ** this.retryCount), 60000);
    this.retryCount += 1;
    this.logger.warn({ error: this.lastTransportError, retryInMs: delay }, 'Telegram transport stopped; scheduling reconnect.');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start().catch((nextError) => this.scheduleReconnect(nextError));
    }, delay);
    this.retryTimer.unref?.();
  }

  async runAiJob(ctx, action) {
    const key = String(ctx.from.id);
    if (this.aiJobs.has(key)) return ctx.reply('AI đang xử lý yêu cầu trước. Bạn vẫn có thể dùng /menu hoặc /ping.');
    // Return the update promptly so long polling can fetch management commands.
    const task = Promise.resolve().then(action).catch(async (error) => {
      await ctx.reply(`Không gọi được AI: ${humanError(error)}`).catch(() => {});
    }).finally(() => { this.aiJobs.delete(key); });
    this.aiJobs.set(key, task);
  }

  _recreateBot() {
    // Tạo mới Telegraf instance để tránh state cũ gây lỗi sau khi stop.
    this.bot = this.createBot();
    this.handlersRegistered = false;
    // Cập nhật lại reference bot cho tất cả bridges đang dùng runtime này.
    for (const bridge of this.bridges) {
      bridge.bot = this.bot;
    }
  }

  addBridge(bridge) {
    this.bridges.add(bridge);
    this.registerHandlers();
  }

  removeBridge(bridge, reason = 'manual') {
    this.bridges.delete(bridge);
    if (this.bridges.size === 0 && !this.controlStarted) {
      this.stopTransport(reason);
      this.handlersRegistered = false;
      this._recreateBot();
    }
  }

  async start() {
    if (this.started) return;
    if (this.startingPromise) return this.startingPromise;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    this.startingPromise = (async () => {
      if (!this.handlersRegistered) this._recreateBot();
      this.registerHandlers();
      const generation = ++this.generation;
      this.transportStatus = 'connecting';

      if (this.isWebhookMode) {
        const fullUrl = `${this.webhookBaseUrl}${this.webhookPath}`;
        this.bot.botInfo = await this.bot.telegram.getMe();
        if (generation !== this.generation) return;
        const bot = this.bot;
        webhookHandlers.set(this.webhookPath, async (req, res) => {
          this.lastWebhookRequestAt = new Date().toISOString();
          let update;
          try {
            update = await readJsonBody(req);
          } catch (error) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Bad Request\n');
            this.logger.warn({ error: humanError(error) }, 'Rejected malformed Telegram webhook body.');
            return;
          }
          // Acknowledge immediately so Telegram never times out and redelivers
          // the same update while we are still sending it to Zalo.
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('ok');
          // Keep per-chat order (messages to Zalo stay in sequence) without
          // letting one slow chat block management commands in another chat.
          const chatKey = updateChatKey(update);
          const previous = this.updateChains.get(chatKey) || Promise.resolve();
          const current = previous.then(() => bot.handleUpdate(update)).catch((error) => {
            this.logger.error({ error, updateId: update?.update_id }, 'Telegram update failed after webhook acknowledgement.');
          });
          this.updateChains.set(chatKey, current);
          current.finally(() => {
            if (this.updateChains.get(chatKey) === current) this.updateChains.delete(chatKey);
          });
        });
        await this.bot.telegram.setWebhook(fullUrl, { drop_pending_updates: false, allowed_updates: ['message', 'callback_query', 'message_reaction'] });
        if (generation !== this.generation) return;
        this.started = true;
        this.transportStatus = 'running';
        this.lastTransportError = null;
        this.bot.telegram.setMyCommands([
          { command: 'start', description: 'Mở menu quản lý bot' },
          { command: 'menu', description: 'Hiện menu chức năng' },
          { command: 'ping', description: 'Kiểm tra bot còn nhận lệnh và phiên bản' },
          { command: 'ask', description: 'Hỏi AI: /ask câu hỏi' },
          { command: 'clear', description: 'Xóa lịch sử chat AI của bạn' },
          { command: 'zaloqr', description: 'Kết nối tài khoản Zalo bằng QR' },
          { command: 'addzalo', description: 'Thêm tài khoản Zalo mới' },
          { command: 'zaloaccounts', description: 'Quản lý tài khoản Zalo' },
          { command: 'zalostart', description: 'Khởi động tài khoản Zalo' },
          { command: 'zalostop', description: 'Dừng tài khoản Zalo' },
          { command: 'zalostatus', description: 'Xem trạng thái Zalo và AI' },
          { command: 'zaloai', description: 'Chế độ AI Zalo: off/command/dm/all' },
          { command: 'zalomode', description: 'Đặt chế độ trả lời AI Zalo' },
          { command: 'allowai', description: 'Cấp quyền chat AI cho Telegram ID' },
          { command: 'denyai', description: 'Thu hồi quyền chat AI của Telegram ID' },
          { command: 'aiusers', description: 'Liệt kê ID được phép chat AI' },
          { command: 'telegram', description: 'Xem nhóm và topic của tài khoản' },
          { command: 'telegramtest', description: 'Kiểm tra bot truy cập nhóm và quyền Topics' },
          { command: 'setforum', description: 'Đặt ID nhóm Telegram cho Zalo' },
          { command: 'bindtopic', description: 'Gán cuộc trò chuyện vào topic có sẵn' },
          { command: 'aitest', description: 'Kiểm tra kết nối 9Router và chế độ AI' },
          { command: 'dien', description: 'Xem số điện và tiền điện EVN' },
          { command: 'evnset', description: 'Cài tài khoản EVN: /evnset user pass PD...' },
          { command: 'evnzalo', description: 'Gõ trong topic Zalo để chọn nơi nhận báo cáo điện' },
          { command: 'undo', description: 'Thu hồi tin nhắn Zalo trong topic' },
          { command: 'topics', description: 'Liệt kê topic Zalo đã liên kết' },
          { command: 'id', description: 'Xem Telegram ID' },
        ]).catch((error) => this.logger.warn({ error }, 'Could not register Telegram command menu.'));
        this.logger.info({ bot: this.bot.botInfo.username, origin: this.webhookBaseUrl }, 'Telegram webhook registered.');
        await this.refreshWebhook();
        clearInterval(this.webhookTimer);
        this.webhookTimer = setInterval(() => { void this.refreshWebhook(); }, 20000);
        this.webhookTimer.unref?.();
        this.startEvnScheduler();
        return;
      }

      // Telegraf's polling launch promise can stay pending for the bot lifetime.
      // Mark the runtime started before launching and observe failures separately.
      this.started = true;
      this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Mở menu quản lý bot' },
        { command: 'menu', description: 'Hiện menu chức năng' },
        { command: 'ping', description: 'Kiểm tra bot còn nhận lệnh và phiên bản' },
        { command: 'ask', description: 'Hỏi AI: /ask câu hỏi' },
        { command: 'clear', description: 'Xóa lịch sử chat AI của bạn' },
        { command: 'zaloqr', description: 'Kết nối tài khoản Zalo bằng QR' },
        { command: 'addzalo', description: 'Thêm tài khoản Zalo mới' },
        { command: 'zaloaccounts', description: 'Quản lý tài khoản Zalo' },
        { command: 'zalostart', description: 'Khởi động tài khoản Zalo' },
        { command: 'zalostop', description: 'Dừng tài khoản Zalo' },
        { command: 'zalostatus', description: 'Xem trạng thái Zalo và AI' },
        { command: 'zaloai', description: 'Chế độ AI Zalo: off/command/dm/all' },
        { command: 'zalomode', description: 'Đặt chế độ trả lời AI Zalo' },
        { command: 'allowai', description: 'Cấp quyền chat AI cho Telegram ID' },
        { command: 'denyai', description: 'Thu hồi quyền chat AI của Telegram ID' },
        { command: 'aiusers', description: 'Liệt kê ID được phép chat AI' },
        { command: 'telegram', description: 'Xem nhóm và topic của tài khoản' },
        { command: 'telegramtest', description: 'Kiểm tra bot truy cập nhóm và quyền Topics' },
        { command: 'setforum', description: 'Đặt ID nhóm Telegram cho Zalo' },
        { command: 'bindtopic', description: 'Gán cuộc trò chuyện vào topic có sẵn' },
        { command: 'aitest', description: 'Kiểm tra kết nối 9Router và chế độ AI' },
        { command: 'dien', description: 'Xem số điện và tiền điện EVN' },
        { command: 'evnset', description: 'Cài tài khoản EVN: /evnset user pass PD...' },
        { command: 'evnzalo', description: 'Gõ trong topic Zalo để chọn nơi nhận báo cáo điện' },
        { command: 'undo', description: 'Thu hồi tin nhắn Zalo trong topic' },
        { command: 'topics', description: 'Liệt kê topic Zalo đã liên kết' },
        { command: 'id', description: 'Xem Telegram ID' },
      ]).catch((error) => this.logger.warn({ error }, 'Could not register Telegram command menu.'));
      this.startEvnScheduler();
      this.pollingTask = this.bot.launch({ dropPendingUpdates: false, allowedUpdates: ['message', 'callback_query', 'message_reaction'] }, () => {
        if (generation !== this.generation) throw new Error('Telegram launch cancelled');
        this.transportStatus = 'running';
        this.lastTransportError = null;
        this.logger.info('Telegram bot connected (long polling).');
      }).then(() => {
        this.scheduleReconnect(new Error('Telegram polling ended unexpectedly.'), generation);
      }).catch((error) => this.scheduleReconnect(error, generation));
    })().catch((error) => {
      this.scheduleReconnect(error);
    }).finally(() => {
      this.startingPromise = null;
    });

    return this.startingPromise;
  }

  findBridgeByTopic(topicId, chatId) {
    for (const bridge of this.bridges) {
      if (Number(bridge.config.telegramForumChatId) !== Number(chatId)) continue;
      const mapping = bridge.store.getByTopic(topicId);
      if (mapping) return { bridge, mapping };
    }
    return null;
  }

  startEvnScheduler() {
    clearInterval(this.evnTimer);
    this.evnTimer = setInterval(() => {
      void this.checkEvnSchedule().catch((error) => {
        this.logger.warn({ error: humanError(error) }, 'Scheduled EVN check failed.');
      });
    }, 10 * 60 * 1000);
    this.evnTimer.unref?.();
  }

  async checkEvnSchedule(now = new Date()) {
    if (!this.manager?.getEvnConfig) return { skipped: 'no-manager' };
    if (this.evnCheckPromise) return this.evnCheckPromise;
    this.evnCheckPromise = (async () => {
      const config = await this.manager.getEvnConfig();
      if (config.enabled === false || !config.username || !config.password || !config.customerId) {
        return { skipped: 'not-configured' };
      }
      const vn = getVietnamDateParts(now);
      const reportHour = Number.isFinite(Number(config.reportHour)) ? Number(config.reportHour) : 6;
      if (vn.hour < reportHour || vn.hour >= reportHour + 4) {
        return { skipped: 'outside-window', hour: vn.hour, reportHour };
      }
      if (config.lastReportDate === vn.isoDate) {
        return { skipped: 'already-sent-today', date: vn.isoDate };
      }
      const { report, text, fromCache } = await this.manager.fetchEvnReport({ now });
      if (
        (fromCache || vn.hour < reportHour + 2) &&
        config.lastReportedReadingDate &&
        report.latestReadingDate === config.lastReportedReadingDate
      ) {
        this.logger.info(
          { latestReadingDate: report.latestReadingDate, fromCache: Boolean(fromCache) },
          'EVN has not published a newer daily reading yet; waiting for next check or sync.',
        );
        return { skipped: 'waiting-new-reading', latestReadingDate: report.latestReadingDate };
      }
      let weatherText = null;
      if (config.weatherEnabled !== false && typeof this.manager.fetchWeatherReport === 'function') {
        try {
          const w = await this.manager.fetchWeatherReport({ now });
          weatherText = w?.text || null;
        } catch (weatherError) {
          this.logger.warn({ error: humanError(weatherError) }, 'Could not fetch daily weather report.');
        }
      }
      const delivery = await this.deliverEvnReport({ report, text, weatherText, config });
      await this.manager.updateEvnConfig({
        lastReportDate: vn.isoDate,
        lastReportedReadingDate: report.latestReadingDate,
      });
      return { delivered: true, report, text, weatherText, delivery };
    })().finally(() => {
      this.evnCheckPromise = null;
    });
    return this.evnCheckPromise;
  }

  async deliverEvnReport({
    report,
    text,
    weatherText = null,
    config = null,
    destinations = { privateChat: true, forumTopic: true, zalo: true },
  }) {
    const evnConfig = config || (await this.manager.getEvnConfig());
    const results = { privateChat: false, forumTopic: false, zalo: false, errors: [] };
    const messagesToSend = [text, weatherText].filter(Boolean);
    if (messagesToSend.length === 0) return results;

    // 1. Chat riêng Bot Telegram quản lý (gửi 2 tin nhắn riêng biệt: 1 tin điện + 1 tin thời tiết)
    if (destinations.privateChat) {
      const admins = [...(this.config.telegramAdminIds || [])];
      for (const adminId of admins) {
        try {
          for (const msg of messagesToSend) {
            await this.bot.telegram.sendMessage(adminId, msg);
          }
          results.privateChat = true;
        } catch (error) {
          results.errors.push(`Chat riêng (${adminId}): ${humanError(error)}`);
        }
      }
    }

    // 2. Topic riêng trong nhóm Forum Telegram (gửi 2 tin nhắn riêng biệt)
    if (destinations.forumTopic) {
      const candidateChatIds = [
        evnConfig.telegramForumChatId,
        ...[...this.bridges]
          .sort((a, b) => (a.config.accountId === evnConfig.zaloAccountId ? -1 : b.config.accountId === evnConfig.zaloAccountId ? 1 : 0))
          .map((b) => b.config?.telegramForumChatId),
        this.config.telegramForumChatId,
      ]
        .map((id) => Number(id))
        .filter((id, idx, arr) => Number.isSafeInteger(id) && id < 0 && arr.indexOf(id) === idx);

      let lastForumError = null;
      for (const chatId of candidateChatIds) {
        const send = (action) => this.groupQueue.run(chatId, action);
        let topicId =
          evnConfig.telegramEvnTopicId && Number(evnConfig.telegramForumChatId) === chatId
            ? Number(evnConfig.telegramEvnTopicId)
            : null;
        const createEvnTopic = async () => {
          const created = await send(() => this.bot.telegram.createForumTopic(
            chatId,
            `⚡ Điện lực ${report?.area || 'EVN'} - ${evnConfig.customerId || ''}`.trim().slice(0, 128),
          ));
          topicId = created.message_thread_id;
          await this.manager.updateEvnConfig({ telegramEvnTopicId: topicId, telegramForumChatId: chatId });
          return topicId;
        };
        try {
          if (!topicId) {
            await createEvnTopic();
          }
          try {
            for (const msg of messagesToSend) {
              await send(() => this.bot.telegram.sendMessage(chatId, msg, { message_thread_id: topicId }));
            }
          } catch (error) {
            if (!isTelegramThreadNotFound(error)) throw error;
            await createEvnTopic();
            for (const msg of messagesToSend) {
              await send(() => this.bot.telegram.sendMessage(chatId, msg, { message_thread_id: topicId }));
            }
          }
          results.forumTopic = true;
          lastForumError = null;
          break;
        } catch (error) {
          lastForumError = error;
        }
      }
      if (!results.forumTopic && lastForumError) {
        results.errors.push(`Topic Forum Telegram: ${humanError(lastForumError)}`);
      }
    }

    // 3. Cuộc trò chuyện / nhóm gia đình trên Zalo (gửi 2 tin nhắn riêng biệt)
    if (destinations.zalo && evnConfig.zaloConversationId && this.manager) {
      try {
        let controller = evnConfig.zaloAccountId ? this.manager.getController(evnConfig.zaloAccountId) : null;
        if (!controller && this.manager.controllers) {
          controller = [...this.manager.controllers.values()].find(
            (c) => c.status === 'running' && c.store?.getByConversation?.(evnConfig.zaloConversationId),
          ) || [...this.manager.controllers.values()].find((c) => c.status === 'running');
        }
        if (!controller || !controller.zalo) {
          throw new Error('Tài khoản Zalo nhận báo cáo chưa kết nối hoặc đang dừng.');
        }
        const mapping = controller.store?.getByConversation?.(evnConfig.zaloConversationId);
        const threadType = mapping?.threadType ?? evnConfig.zaloThreadType ?? 0;
        for (const msg of messagesToSend) {
          controller.registerPendingEcho?.(evnConfig.zaloConversationId, msg);
          try {
            await controller.zalo.sendText({
              conversationId: String(evnConfig.zaloConversationId),
              threadType,
              text: msg,
            });
          } catch (sendError) {
            controller.consumePendingEcho?.(evnConfig.zaloConversationId);
            throw sendError;
          }
        }
        results.zalo = true;
      } catch (error) {
        results.errors.push(`Zalo (${evnConfig.zaloConversationTitle || evnConfig.zaloConversationId}): ${humanError(error)}`);
      }
    }

    return results;
  }

  registerHandlers() {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;
    this.bot.use(async (ctx, next) => {
      this.lastUpdateAt = new Date().toISOString();
      this.retryCount = 0;
      this.transportStatus = 'running';
      await next();
    });
    this.bot.command('ping', async (ctx) => {
      const status = this.snapshot();
      await ctx.reply(`🏓 Bot đang nhận lệnh.\nBot: @${status.botUsername || ctx.botInfo?.username || '(chưa rõ)'}\nPhiên bản: ${status.version}\nTelegram: ${status.mode} / ${status.status}\nID của bạn: ${ctx.from?.id}`);
    });

    const isAdmin = (ctx) => this.config.telegramAdminIds?.has(Number(ctx.from?.id)) || false;
    const isAiUser = async (ctx) => isAdmin(ctx) || Boolean(await this.manager?.isAiUserAllowed(ctx.from?.id));
    const deny = async (ctx) => {
      await ctx.reply(`⛔ Chưa được cấp quyền quản lý. Telegram ID của bạn: ${ctx.from?.id || '(không rõ)'}`);
    };
    const showMenu = async (ctx, text = 'Chọn chức năng:') => {
      await ctx.reply(text, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
    };
    const sendQr = async (chatId, image) => {
      if (!image) return;
      const raw = String(image).replace(/^data:image\/\w+;base64,/, '');
      await this.bot.telegram.sendPhoto(chatId, Input.fromBuffer(Buffer.from(raw, 'base64'), 'zalo-qr.png'), {
        caption: 'Quét QR bằng ứng dụng Zalo trên điện thoại để kết nối tài khoản.',
      });
    };
    const loginCallbacks = (ctx) => ({
      onQr: (image) => sendQr(ctx.chat.id, image),
      onStatus: async (event) => {
        const account = `${event.accountName} [${event.accountId}]`;
        let text;
        switch (event.type) {
          case 'scanned':
            text = `👀 Đã nhận quét QR từ Zalo: ${event.scannedName || event.accountName}!\nTài khoản quản lý: ${event.accountId}\n👉 Hãy xác nhận đăng nhập trên điện thoại.`;
            break;
          case 'success':
            text = `✅ Kết nối Zalo thành công!\n• Tài khoản: ${account}\n• Trạng thái: running (đang nghe tin)\n• AI tự trả lời: ${event.mode}${event.mode === 'off' ? ' (đã tắt)' : ''}\n${event.savedToMongo ? '• Phiên đăng nhập đã được lưu vào MongoDB.' : '• Phiên đăng nhập được lưu trong dữ liệu bridge.'}`;
            break;
          case 'expired':
            text = `⌛ QR của ${account} đã hết hạn. Bot đang chờ mã QR mới; hãy quét mã mới nhất.`;
            break;
          case 'declined':
            text = `⚠️ Đăng nhập ${account} đã bị từ chối trên điện thoại. Hãy quét QR mới và xác nhận lại.`;
            break;
          case 'reconnecting':
            text = `🔄 ${account} đang kết nối lại. Chưa xác nhận kết nối thành công.`;
            break;
          case 'stopped':
            text = `⏸ Đã dừng kết nối ${account}. Phiên đăng nhập đang chờ đã kết thúc.`;
            break;
          case 'timeout':
            text = `⌛ Chưa xác nhận kết nối ${account} sau 5 phút. Dùng /zalostatus để kiểm tra hoặc /zaloqr ${event.accountId} để thử lại.`;
            break;
          default:
            text = `❌ Không kết nối được ${account}.\n${humanError(event.error)}\nDùng /zaloqr ${event.accountId} để thử lại.`;
        }
        await this.bot.telegram.sendMessage(ctx.chat.id, text);
      },
    });
    const requireAdmin = async (ctx, action) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('Mở chat riêng với bot để dùng chức năng quản lý.');
        return;
      }
      return action();
    };
    const startQr = async (ctx) => {
      await requireAdmin(ctx, async () => {
        if (!this.manager) return ctx.reply('Quản lý Zalo chưa khởi động.');
        await ctx.reply('Đang tạo phiên QR Zalo. Bot sẽ gửi mã tại đây khi sẵn sàng.');
        try {
          const text = ctx.message?.text?.trim() || '';
          const accountId = /^\/zaloqr(?:@\w+)?(?:\s|$)/i.test(text)
            ? text.split(/\s+/)[1] || null
            : null;
          const callbacks = loginCallbacks(ctx);
          await this.manager.requestZaloQr(callbacks.onQr, accountId, callbacks.onStatus);
        } catch (error) {
          await ctx.reply(`Không khởi tạo được QR Zalo: ${humanError(error)}`);
        }
      });
    };
    const showStatus = async (ctx) => {
      await requireAdmin(ctx, async () => {
        const accounts = this.manager ? await this.manager.listAccounts() : [];
        const lines = accounts.length
          ? (await Promise.all(accounts.map(async (account) => {
              const mode = await this.manager.getZaloAiMode(account.id);
              return `• ${account.label} [${account.id}]: ${account.status}${account.listenerConnected ? ' (đang nghe tin)' : ''} · AI ${mode}${account.lastAiError ? '\n  Lỗi AI gần nhất: ' + account.lastAiError : ''}${account.lastTelegramError ? '\n  Lỗi nhóm Telegram: ' + account.lastTelegramError : ''}`;
            }))).join('\n')
          : 'Chưa có tài khoản Zalo.';
        await showMenu(ctx, `📊 Trạng thái tài khoản\n${lines}`);
      });
    };
    const setAiMode = async (ctx, mode, accountId = null) => {
      await requireAdmin(ctx, async () => {
        if (!this.manager) return ctx.reply('Quản lý Zalo chưa khởi động.');
        try {
          const result = await this.manager.setZaloAiMode(mode, accountId);
          await showMenu(ctx, `Đã đặt AI Zalo ${accountId ? `cho ${accountId}` : ''}: ${result}`);
        } catch (error) {
          await ctx.reply(`Không đổi được chế độ AI Zalo: ${humanError(error)}`);
        }
      });
    };
    const addZaloAccount = async (ctx, label = 'Zalo') => {
      await requireAdmin(ctx, async () => {
        if (!this.manager) return ctx.reply('Quản lý Zalo chưa khởi động.');
        await ctx.reply('Đang tạo tài khoản Zalo mới, QR sẽ được gửi vào đây khi sẵn sàng.');
        try {
          const callbacks = loginCallbacks(ctx);
          const account = await this.manager.addZaloAccount(label, callbacks.onQr, callbacks.onStatus);
          await ctx.reply(`Đã tạo mục tài khoản ${account.label} (${account.id}). Đang chờ đăng nhập; bot sẽ gửi QR và thông báo khi kết nối thành công.`);
        } catch (error) {
          await ctx.reply(`Không tạo được tài khoản Zalo: ${humanError(error)}`);
        }
      });
    };
    const showAccounts = async (ctx) => {
      await requireAdmin(ctx, async () => {
        const accounts = this.manager ? await this.manager.listAccounts() : [];
        if (!accounts.length) return showMenu(ctx, 'Chưa có tài khoản Zalo. Chọn “Thêm tài khoản Zalo”.');
        const rows = accounts.map((account) => [
          Markup.button.callback(`${account.label} · ${account.status}`, `zalo:account:${account.id}`),
        ]);
        rows.push([Markup.button.callback('➕ Thêm tài khoản', 'zalo:add')]);
        await ctx.reply('Chọn tài khoản Zalo để quản lý:', Markup.inlineKeyboard(rows));
      });
    };
    const showAiUsers = async (ctx) => {
      await requireAdmin(ctx, async () => {
        const users = await this.manager.listAiUsers();
        await showMenu(ctx, `🔐 Quyền chat AI\nID được cấp: ${users.join(', ') || '(chưa có)'}\n\nDùng /allowai <telegram_user_id> để cấp.\nDùng /denyai <telegram_user_id> để thu hồi.`);
      });
    };
    const showTelegramSettings = async (ctx, accountId) => requireAdmin(ctx, async () => {
      const account = this.manager.getAccount(accountId);
      if (!account) return ctx.reply('Không tìm thấy tài khoản Zalo.');
      const me = await this.bot.telegram.getMe();
      await ctx.reply(
        `⚙️ Telegram cho ${account.label} [${account.id}]\n• Bot: @${me.username}\n• ID nhóm: ${account.telegramForumChatId}\n• Topic: tự tạo riêng cho từng cuộc trò chuyện Zalo.\n\nCác tài khoản dùng chung bot quản lý; không phải nhập lại bot token. Thêm bot vào nhóm có Topics và cấp quyền quản lý topic.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Đổi ID nhóm', `zalo:setforum:${account.id}`)],
          [Markup.button.callback('🔎 Kiểm tra nhóm', `zalo:tgtest:${account.id}`)],
          [Markup.button.callback('📌 Xem/gán topic', `zalo:topics:${account.id}`)],
        ]),
      );
    });
    const validateForum = async (chatId) => {
      const id = Number(chatId);
      if (!Number.isSafeInteger(id) || id >= 0) throw new Error('ID nhóm phải là số âm, thường bắt đầu -100.');
      const chat = await this.bot.telegram.getChat(id);
      if (!chat.is_forum) throw new Error('Nhóm này chưa bật Topics. Hãy bật Topics trước.');
      const me = await this.bot.telegram.getMe();
      const member = await this.bot.telegram.getChatMember(id, me.id);
      if (member.status !== 'creator' && (member.status !== 'administrator' || !member.can_manage_topics)) {
        throw new Error('Bot cần làm quản trị viên và có quyền Manage Topics trong nhóm.');
      }
      return id;
    };
    const saveForum = async (ctx, accountId, rawChatId) => {
      const id = await validateForum(rawChatId);
      await this.manager.setTelegramForum(accountId, id);
      await ctx.reply(`✅ Đã đặt nhóm Telegram cho ${accountId}: ${id}. Các cuộc trò chuyện sẽ có topic riêng trong nhóm này; mapping nhóm cũ được giữ lại để có thể chuyển về.`);
    };
    const testTelegramGroup = async (ctx, accountId) => requireAdmin(ctx, async () => {
      const account = this.manager.getAccount(accountId);
      if (!account) return ctx.reply('Dùng /telegramtest <account_id>, ví dụ /telegramtest zalo-1');
      try {
        await validateForum(account.telegramForumChatId);
        const controller = this.manager.getController(accountId);
        if (controller) {
          controller.lastTelegramError = null;
          if (controller.telegram) controller.telegram.forwardingBlockedUntil = 0;
        }
        await ctx.reply(`✅ Bot truy cập được nhóm ${account.telegramForumChatId} và có quyền quản lý Topics. Có thể gửi tin Zalo để tạo topic.`);
      } catch (error) {
        await ctx.reply(`❌ Không dùng được nhóm ${account.telegramForumChatId} cho ${accountId}.\n${humanError(error)}\nThêm đúng bot đang chat với bạn vào nhóm, cấp quyền Manage Topics, rồi thử lại. Dùng /id trong nhóm để xác nhận chat_id.`);
      }
    });
    const showAccountTopics = async (ctx, accountId) => requireAdmin(ctx, async () => {
      const mappings = await this.manager.listAccountConversations(accountId);
      if (!mappings.length) return ctx.reply('Chưa có cuộc trò chuyện. Gửi tin Zalo đến tài khoản này để bot tạo topic. Nếu không tạo được, kiểm tra quyền Manage Topics của bot.');
      for (const mapping of mappings.slice(0, 30)) {
        await ctx.reply(`${mapping.title}\nZalo conversation ID: ${mapping.conversationId}\nTelegram topic ID: ${mapping.topicId}`, Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Gán topic có sẵn', `zt:${accountId}:${mapping.topicId}`)],
        ]));
      }
    });
    const saveTopic = async (ctx, accountId, conversationId, topicId) => {
      const account = this.manager.getAccount(accountId);
      if (!account) throw new Error('Không tìm thấy tài khoản Zalo.');
      if (!Number.isSafeInteger(Number(topicId)) || Number(topicId) <= 0) throw new Error('Topic ID phải là số nguyên dương.');
      // Validate the topic by sending a visible setup confirmation there.
      const mappings = await this.manager.listAccountConversations(accountId);
      if (!mappings.some((item) => item.conversationId === conversationId)) throw new Error('Không tìm thấy cuộc trò chuyện Zalo.');
      await this.bot.telegram.sendMessage(account.telegramForumChatId, `Đang kiểm tra topic cho ${account.label} (${conversationId}).`, { message_thread_id: Number(topicId) });
      await this.manager.bindTelegramTopic(accountId, conversationId, topicId);
      await ctx.reply(`✅ Đã gán ${accountId} / ${conversationId} → nhóm ${account.telegramForumChatId}, topic ${topicId}.`);
    };
    const testAi = async (ctx, accountId) => requireAdmin(ctx, async () => {
      await ctx.reply(`Đang kiểm tra API 9Router cho ${accountId}…`);
      try {
        const result = await this.manager.testAi(accountId);
        await ctx.reply(`✅ API AI trả lời: ${result.answer.slice(0, 500)}\n• Tài khoản: ${accountId}\n• Zalo: ${result.connected ? 'đang nghe tin' : 'chưa sẵn sàng'}\n• Chế độ: ${result.mode}\n${result.mode === 'off' ? 'AI đang tắt. Dùng /zalomode command ' + accountId + ' để bật chỉ khi có lệnh.' : 'Gõ /ai Xin chào trong một cuộc trò chuyện Zalo để thử.'}`);
      } catch (error) { await ctx.reply(`❌ Kiểm tra AI thất bại: ${humanError(error)}`); }
    });

    this.bot.command('telegram', (ctx) => showTelegramSettings(ctx, ctx.message.text.split(/\s+/)[1]));
    this.bot.command('telegramtest', (ctx) => testTelegramGroup(ctx, ctx.message.text.split(/\s+/)[1]));
    this.bot.command('setforum', (ctx) => requireAdmin(ctx, async () => {
      const [, accountId, chatId] = ctx.message.text.split(/\s+/);
      if (!accountId || !chatId) return ctx.reply('Dùng /setforum <account_id> <-100...>');
      try { await saveForum(ctx, accountId, chatId); } catch (error) { await ctx.reply(`Không lưu được nhóm: ${humanError(error)}`); }
    }));
    this.bot.command('bindtopic', (ctx) => requireAdmin(ctx, async () => {
      const [, accountId, conversationId, topicId] = ctx.message.text.split(/\s+/);
      if (!accountId || !conversationId || !topicId) return ctx.reply('Dùng /bindtopic <account_id> <zalo_conversation_id> <topic_id>');
      try { await saveTopic(ctx, accountId, conversationId, topicId); } catch (error) { await ctx.reply(`Không gán được topic: ${humanError(error)}`); }
    }));
    this.bot.command('aitest', (ctx) => requireAdmin(ctx, () => this.runAiJob(ctx, () => testAi(ctx, ctx.message.text.split(/\s+/)[1]))));
    this.bot.command('cancel', async (ctx) => {
      this.pendingSettings.delete(ctx.from?.id);
      await ctx.reply('Đã hủy thao tác nhập cấu hình.');
    });

    this.bot.command(['start', 'menu', 'help'], async (ctx) => {
      if (!(await isAiUser(ctx))) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Mở chat riêng với bot để dùng menu.');
      return showMenu(ctx);
    });
    this.bot.command('ask', async (ctx) => {
      if (!(await isAiUser(ctx))) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng /ask trong chat riêng với bot.');
      const prompt = ctx.message.text.replace(/^\/ask(?:@[\w]+)?\s*/i, '').trim();
      if (!prompt) return showMenu(ctx, 'Dùng /ask kèm câu hỏi hoặc gửi thẳng câu hỏi trong chat riêng.');
      if (!this.manager) return ctx.reply('Bot quản lý chưa sẵn sàng.');
      return this.runAiJob(ctx, async () => {
        await ctx.sendChatAction('typing');
        const answer = await this.manager.chatWithAi(ctx.from.id, prompt);
        for (const part of splitTelegramText(answer)) await ctx.reply(part, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      });
    });
    this.bot.command('clear', async (ctx) => {
      if (!(await isAiUser(ctx))) return deny(ctx);
      try {
        await this.manager?.clearAiHistory(ctx.from.id);
        await ctx.reply('Đã xóa lịch sử chat AI.', isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      } catch (error) {
        await ctx.reply(`Không xóa được lịch sử: ${humanError(error)}`);
      }
    });
    this.bot.command('zaloqr', startQr);
    this.bot.command('addzalo', (ctx) => addZaloAccount(ctx, ctx.message.text.replace(/^\/addzalo(?:@[\w]+)?\s*/i, '').trim() || 'Zalo'));
    this.bot.command('zalostatus', showStatus);
    this.bot.command('zaloaccounts', showAccounts);
    this.bot.command('zalostart', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const id = ctx.message.text.split(/\s+/)[1];
      if (!id) return ctx.reply('Dùng /zalostart <account_id>');
      try {
        const callbacks = loginCallbacks(ctx);
        await this.manager.startManagedAccount(id, callbacks.onQr, callbacks.onStatus);
        await showStatus(ctx);
      }
      catch (error) { await ctx.reply(`Không khởi động được tài khoản: ${humanError(error)}`); }
    });
    this.bot.command('zalostop', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const id = ctx.message.text.split(/\s+/)[1];
      if (!id) return ctx.reply('Dùng /zalostop <account_id>');
      try { await this.manager.stopManagedAccount(id); await showStatus(ctx); }
      catch (error) { await ctx.reply(`Không dừng được tài khoản: ${humanError(error)}`); }
    });
    this.bot.action('zalo:add', async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      await addZaloAccount(ctx, 'Zalo');
    });
    this.bot.action(/^zalo:account:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const account = this.manager?.getAccount(id);
      if (!account) return ctx.reply('Không tìm thấy tài khoản này.');
      const rows = [
        [Markup.button.callback('Đổi tên hiển thị', `zalo:rename:${id}`)],
        [Markup.button.callback('🔄 Quét lại QR', `zalo:qr:${id}`)],
        [Markup.button.callback('▶️ Bật', `zalo:start:${id}`), Markup.button.callback('⏸ Tắt', `zalo:stop:${id}`)],
        [Markup.button.callback('🤖 Chế độ AI', `zalo:modes:${id}`)],
        [Markup.button.callback('⚙️ Nhóm/topic Telegram', `zalo:telegram:${id}`)],
        [Markup.button.callback('🧪 Kiểm tra AI', `zalo:aitest:${id}`)],
      ];
      await ctx.reply(`${account.label} (${id})`, Markup.inlineKeyboard(rows));
    });
    this.bot.action(/^zalo:rename:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      const account = this.manager?.getAccount(ctx.match[1]);
      if (!account) return ctx.reply('Không tìm thấy tài khoản này.');
      this.pendingSettings.set(ctx.from.id, { kind: 'rename', accountId: account.id, expires: Date.now() + 300000 });
      await ctx.reply(`Tên hiện tại của ${account.id}: ${account.label}\nGửi tên mới hoặc /cancel để hủy.`);
    });
    this.bot.action(/^zalo:qr:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      try {
        await ctx.reply('Đang yêu cầu QR đăng nhập lại.');
        const callbacks = loginCallbacks(ctx);
        await this.manager.requestZaloQr(callbacks.onQr, ctx.match[1], callbacks.onStatus);
      } catch (error) { await ctx.reply(`Không tạo được QR: ${humanError(error)}`); }
    });
    for (const action of ['telegram', 'topics', 'aitest', 'setforum', 'tgtest']) {
      this.bot.action(new RegExp(`^zalo:${action}:(.+)$`), async (ctx) => {
        if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng.');
        await ctx.answerCbQuery();
        const accountId = ctx.match[1];
        try {
          if (action === 'telegram') return await showTelegramSettings(ctx, accountId);
          if (action === 'topics') return await showAccountTopics(ctx, accountId);
          if (action === 'aitest') return await testAi(ctx, accountId);
          if (action === 'tgtest') return await testTelegramGroup(ctx, accountId);
          this.pendingSettings.set(ctx.from.id, { kind: 'forum', accountId, expires: Date.now() + 300000 });
          await ctx.reply(`Gửi ID nhóm Telegram cho ${accountId} (số âm bắt đầu -100). Dùng /id trong nhóm để lấy chat_id. Gửi /cancel để hủy.`);
        } catch (error) { await ctx.reply(`Không mở được cấu hình: ${humanError(error)}`); }
      });
    }
    this.bot.action(/^zt:([^:]+):(\d+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng.');
      await ctx.answerCbQuery();
      const [, accountId, oldTopic] = ctx.match;
      const mappings = await this.manager.listAccountConversations(accountId);
      const mapping = mappings.find((item) => item.topicId === Number(oldTopic));
      if (!mapping) return ctx.reply('Mapping đã thay đổi. Mở lại danh sách topic.');
      this.pendingSettings.set(ctx.from.id, { kind: 'topic', accountId, conversationId: mapping.conversationId, expires: Date.now() + 300000 });
      await ctx.reply(`Gửi topic ID cần gán cho “${mapping.title}”. Dùng /id trong đúng topic để lấy message_thread_id. Gửi /cancel để hủy.`);
    });
    for (const operation of ['start', 'stop']) {
      this.bot.action(new RegExp(`^zalo:${operation}:(.+)$`), async (ctx) => {
        if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
        await ctx.answerCbQuery();
        try {
          if (operation === 'start') {
            const callbacks = loginCallbacks(ctx);
            await this.manager.startManagedAccount(ctx.match[1], callbacks.onQr, callbacks.onStatus);
          } else {
            await this.manager.stopManagedAccount(ctx.match[1]);
          }
          await showStatus(ctx);
        } catch (error) { await ctx.reply(`Không cập nhật được tài khoản: ${humanError(error)}`); }
      });
    }
    this.bot.action(/^zalo:ai:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      try {
        const id = ctx.match[1];
        const current = await this.manager.getZaloAiMode(id);
        const next = current === 'off' ? 'command' : 'off';
        await this.manager.setZaloAiMode(next, id);
        await ctx.reply(`AI Zalo cho ${id}: ${next}`);
      } catch (error) { await ctx.reply(`Không đổi được chế độ AI: ${humanError(error)}`); }
    });
    this.bot.action(/^zalo:modes:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const account = this.manager?.getAccount(id);
      if (!account) return ctx.reply('Không tìm thấy tài khoản này.');
      const current = await this.manager.getZaloAiMode(id);
      const button = (mode, label) => Markup.button.callback(
        current === mode ? `✓ ${label}` : label, `zalo:mode:${mode}:${id}`,
      );
      return ctx.reply(`AI Zalo cho ${account.label} (${id}) đang ở chế độ ${current}.`, Markup.inlineKeyboard([
        [button('command', 'Chỉ khi dùng /ai hoặc /ask')],
        [button('dm', 'Tự trả lời tin riêng'), button('all', 'Tự trả lời cả nhóm')],
        [button('off', 'Tắt AI')],
      ]));
    });
    this.bot.action(/^zalo:mode:(off|command|dm|all):(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      await setAiMode(ctx, ctx.match[1], ctx.match[2]);
    });
    this.bot.command(['zaloai', 'zalomode'], async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const [command, modeArg, accountId] = ctx.message.text.trim().split(/\s+/);
      const mode = modeArg?.toLowerCase();
      if (!mode && /^\/zaloai(?:@|$)/i.test(command)) return showStatus(ctx);
      if (!mode) return ctx.reply('Dùng /zalomode <chế độ> [account_id]\n• command: chỉ trả lời /ai hoặc /ask có câu hỏi\n• dm: tự trả lời tin riêng; trong nhóm dùng lệnh hoặc tag\n• all: tự trả lời cả tin riêng lẫn nhóm\n• off: tắt AI Zalo\n\nVí dụ: /zalomode command zalo-1');
      if (!['off', 'command', 'dm', 'all'].includes(mode)) {
        return ctx.reply('Dùng /zalomode off|command|dm|all [account_id]');
      }
      await setAiMode(ctx, mode, accountId || null);
    });
    this.bot.command('allowai', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const id = ctx.message.text.split(/\s+/)[1];
      if (!id) return ctx.reply('Dùng /allowai <telegram_user_id>');
      try {
        const users = await this.manager.setAiUserAllowed(id, true);
        await ctx.reply(`Đã cấp quyền chat AI cho ${id}. Danh sách: ${users.join(', ')}`);
      } catch (error) {
        await ctx.reply(`Không cấp được quyền: ${humanError(error)}`);
      }
    });
    this.bot.command('denyai', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const id = ctx.message.text.split(/\s+/)[1];
      if (!id) return ctx.reply('Dùng /denyai <telegram_user_id>');
      try {
        const users = await this.manager.setAiUserAllowed(id, false);
        await ctx.reply(`Đã thu hồi quyền chat AI cho ${id}. Danh sách: ${users.join(', ') || '(trống)'}`);
      } catch (error) {
        await ctx.reply(`Không thu hồi được quyền: ${humanError(error)}`);
      }
    });
    this.bot.command('aiusers', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const users = await this.manager.listAiUsers();
      await ctx.reply(`ID được cấp quyền chat AI: ${users.join(', ') || '(chưa có)'}\nAdmin env: ${[...(this.config.telegramAdminIds || [])].join(', ') || '(chưa cấu hình)'}`);
    });

    const evnActionButtons = (config) => Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Lấy số điện ngay', 'evn:now'), Markup.button.callback('🌤 Xem thời tiết', 'weather:now')],
      [Markup.button.callback('📤 Gửi cả 3 nơi (2 tin: Điện + Thời tiết)', 'evn:send3')],
      [Markup.button.callback(`📍 Đổi địa điểm (${config?.weatherLocationName || 'Hà Nội'})`, 'weather:loc'), Markup.button.callback('💬 Chọn nơi nhận Zalo', 'evn:zalo')],
      [Markup.button.callback('🔑 Đổi mật khẩu EVN', 'evn:pass'), Markup.button.callback('⚙️ Đổi TK / Mã KH', 'evn:edit')],
      [Markup.button.callback(config?.enabled === false ? '▶️ Bật báo 6h sáng' : '⏸ Tắt báo 6h sáng', 'evn:toggle')],
    ]);

    const weatherActionButtons = (config) => Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Làm mới thời tiết', 'weather:now'), Markup.button.callback('📤 Gửi thời tiết cả 3 nơi', 'weather:send3')],
      [Markup.button.callback(`📍 Đổi địa điểm (${config?.weatherLocationName || 'Hà Nội'})`, 'weather:loc'), Markup.button.callback('⚡ Xem tiền điện EVN', 'evn:now')],
    ]);

    const showWeatherLocationPicker = async (ctx) => {
      const config = (await this.manager?.getEvnConfig?.()) || {};
      const currentName = config.weatherLocationName || 'Hà Nội';
      const rows = [];
      for (let i = 0; i < PRESET_VIETNAM_LOCATIONS.length; i += 2) {
        const pair = PRESET_VIETNAM_LOCATIONS.slice(i, i + 2).map((item) => {
          const active = item.name === currentName;
          return Markup.button.callback(`${active ? '✅ ' : '📍 '}${item.name}`, `wloc:set:${item.key}`);
        });
        rows.push(pair);
      }
      rows.push([Markup.button.callback('✍️ Nhập tên Quận/Huyện/Tỉnh bất kỳ...', 'wloc:custom')]);
      return ctx.reply(
        `📍 Địa điểm dự báo thời tiết hiện tại: ${currentName}\n\n👇 Bấm chọn nhanh bên dưới hoặc gõ:\n/diadiem <tên địa điểm> (ví dụ: /diadiem Cầu Giấy, Hà Nội)`,
        Markup.inlineKeyboard(rows),
      );
    };

    const showWeatherPanel = async (ctx, { broadcast = false } = {}) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (!this.manager?.fetchWeatherReport) return ctx.reply('Tính năng thời tiết chưa sẵn sàng.');
      const config = await this.manager.getEvnConfig();
      try {
        const { text } = await this.manager.fetchWeatherReport();
        if (broadcast) {
          const delivery = await this.deliverEvnReport({
            report: { area: 'EVN' },
            text: null,
            weatherText: text,
            config,
          });
          const sentPlaces = [
            delivery.privateChat ? 'Chat riêng bot' : null,
            delivery.forumTopic ? 'Topic Forum Telegram' : null,
            delivery.zalo ? `Zalo (${config.zaloConversationTitle || config.zaloConversationId})` : null,
          ].filter(Boolean);
          const warn = delivery.errors.length ? `\n⚠️ Lỗi: ${delivery.errors.join(' | ')}` : '';
          return ctx.reply(`✅ Đã gửi bản tin dự báo thời tiết tới: ${sentPlaces.join(', ') || '(chưa gửi được)'}${warn}`, weatherActionButtons(config));
        }
        return ctx.reply(text, weatherActionButtons(config));
      } catch (error) {
        return ctx.reply(`⚠️ Không lấy được dự báo thời tiết:\n${humanError(error)}`, weatherActionButtons(config));
      }
    };

    const applyWeatherLocationInput = async (ctx, query) => {
      const trimmed = String(query || '').trim();
      if (!trimmed) return showWeatherLocationPicker(ctx);
      try {
        const { location } = await this.manager.setWeatherLocation(trimmed);
        await ctx.reply(`✅ Đã đặt địa điểm dự báo thời tiết 6h sáng: 📍 ${location.name} (${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)})`);
        await showWeatherPanel(ctx);
      } catch (error) {
        await ctx.reply(`⚠️ ${humanError(error)}`);
      }
    };

    const showEvnZaloPicker = async (ctx, prefixNote = '') => {
      const buttons = [];
      const controllers = [...(this.manager?.controllers?.values() || [])];
      for (const controller of controllers) {
        const accId = controller.account?.id;
        const accLabel = controller.account?.label || accId;
        const selfId = controller.zalo?.selfUserId;
        if (selfId) {
          buttons.push([
            Markup.button.callback(`👤 Chính mình trên ${accLabel} (Cloud/Cá nhân)`, `evnz:self:${accId}`),
          ]);
        }
        const convs = (controller.getConversationList?.() || []).slice(0, 10);
        for (const conv of convs) {
          const title = String(conv.title || conv.conversationId).slice(0, 36);
          buttons.push([
            Markup.button.callback(`💬 [${accLabel}] ${title}`, `evnz:c:${accId}:${conv.conversationId}`),
          ]);
        }
      }
      if (buttons.length === 0) {
        return ctx.reply(
          `${prefixNote ? `${prefixNote}\n\n` : ''}Hiện chưa có cuộc trò chuyện Zalo nào được lưu. Hãy gửi 1 tin nhắn từ Zalo để bot tạo topic trước, rồi bấm lại "💬 Chọn nơi nhận Zalo".`,
        );
      }
      buttons.push([Markup.button.callback('🚫 Tắt gửi báo cáo sang Zalo', 'evnz:off')]);
      return ctx.reply(
        `${prefixNote ? `${prefixNote}\n\n` : ''}👇 Bấm chọn người hoặc nhóm Zalo muốn nhận báo cáo điện 6h sáng:`,
        Markup.inlineKeyboard(buttons.slice(0, 25)),
      );
    };

    const applyEvnCredentialsInput = async (ctx, rawInput) => {
      const current = await this.manager.getEvnConfig();
      const tokens = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && current.username && current.customerId) {
        await this.manager.updateEvnConfig({ password: tokens[0], enabled: true });
        await ctx.reply(`✅ Đã cập nhật mật khẩu EVN mới cho tài khoản ${current.username} (${current.customerId}). Đang kiểm tra kết nối...`);
        await showEvnPanel(ctx);
        return true;
      }
      if (tokens.length < 3) {
        await ctx.reply(
          current.username && current.customerId
            ? `Dùng:\n• Đổi riêng mật khẩu: /evnpass <mật_khẩu_mới>\n• Đổi toàn bộ: /evnset <tài_khoản> <mật_khẩu> <mã_KH_PD...> [ngày_đầu_kỳ]\n(Hiện đang lưu TK: ${current.username} · Mã KH: ${current.customerId})`
            : 'Dùng: /evnset <tài_khoản> <mật_khẩu> <mã_KH_PD...> [ngày_đầu_kỳ]\nVí dụ: /evnset 0912345678 MatKhau123 PD01001234567 1',
        );
        return false;
      }
      let billingStartDay = current.billingStartDay || 1;
      let endIndex = tokens.length;
      const lastNum = Number(tokens[tokens.length - 1]);
      if (tokens.length >= 4 && Number.isInteger(lastNum) && lastNum >= 1 && lastNum <= 28) {
        billingStartDay = lastNum;
        endIndex -= 1;
      }
      const username = tokens[0];
      const customerId = tokens[endIndex - 1].toUpperCase();
      const password = tokens.slice(1, endIndex - 1).join(' ');
      await this.manager.updateEvnConfig({
        username,
        password,
        customerId,
        billingStartDay,
        enabled: true,
      });
      await ctx.reply(`✅ Đã lưu cấu hình EVN mới cho TK ${username} · Mã KH ${customerId} (ngày đầu kỳ: ${billingStartDay}). Đang kiểm tra kết nối...`);
      await showEvnPanel(ctx);
      return true;
    };

    const showEvnPanel = async (ctx, { broadcast = false } = {}) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (!this.manager?.getEvnConfig) return ctx.reply('Bot quản lý chưa sẵn sàng.');
      const config = await this.manager.getEvnConfig();
      if (!config.username || !config.password || !config.customerId) {
        return ctx.reply([
          '⚡ Chưa cấu hình tài khoản Điện lực EVNHANOI / EVN CSKH.',
          '',
          'Cách 1 — Cài ngay trong chat riêng với bot (bot sẽ tự xóa tin chứa mật khẩu):',
          '/evnset <sđt_hoặc_user> <mật_khẩu> <mã_KH_PD...> [ngày_đầu_kỳ]',
          'Ví dụ: /evnset 0912345678 MatKhau123 PD01001234567 1',
          '',
          'Cách 2 — Thêm biến môi trường trên Koyeb:',
          'EVN_USERNAME, EVN_PASSWORD, EVN_CUSTOMER_ID, EVN_BILLING_START_DAY=1',
          '',
          'Chọn nhóm/người nhận trên Zalo: vào topic Zalo đó trong nhóm Forum Telegram rồi gõ /evnzalo.',
        ].join('\n'));
      }
      try {
        const { report, text } = await this.manager.fetchEvnReport();
        let weatherText = null;
        if (config.weatherEnabled !== false && typeof this.manager.fetchWeatherReport === 'function') {
          try {
            const w = await this.manager.fetchWeatherReport();
            weatherText = w?.text || null;
          } catch {
            weatherText = null;
          }
        }
        if (broadcast) {
          const delivery = await this.deliverEvnReport({ report, text, weatherText, config });
          const sentPlaces = [
            delivery.privateChat ? 'Chat riêng bot' : null,
            delivery.forumTopic ? 'Topic Forum Telegram' : null,
            delivery.zalo ? `Zalo (${config.zaloConversationTitle || config.zaloConversationId})` : null,
          ].filter(Boolean);
          const warn = delivery.errors.length ? `\n⚠️ Lỗi: ${delivery.errors.join(' | ')}` : '';
          return ctx.reply(
            `✅ Đã gửi 2 tin nhắn riêng (1 tin Điện EVN + 1 tin Thời tiết ${config.weatherLocationName || 'Hà Nội'}) tới: ${sentPlaces.join(', ') || '(chưa gửi được)'}${warn}`,
            evnActionButtons(config),
          );
        }
        const zaloTarget = config.zaloConversationId
          ? `${config.zaloConversationTitle || config.zaloConversationId} [${config.zaloAccountId || 'auto'}]`
          : '(chưa chọn — bấm "💬 Chọn nơi nhận Zalo" bên dưới)';
        const footer = `\n\n⏰ Báo tự động ${config.reportHour ?? 6}h sáng (2 tin: Điện + Thời tiết): ${config.enabled === false ? 'Đang tắt' : 'Đang bật'}\n📍 Địa điểm thời tiết: ${config.weatherLocationName || 'Hà Nội'}\n💬 Nơi nhận Zalo: ${zaloTarget}`;
        return ctx.reply(`${text}${footer}`, evnActionButtons(config));
      } catch (error) {
        return ctx.reply(
          `⚠️ Không lấy được dữ liệu EVN (TK: ${config.username} · Mã KH: ${config.customerId}):\n${humanError(error)}\n\n👉 Bấm "🔑 Đổi mật khẩu EVN" bên dưới hoặc gõ:\n/evnpass <mật_khẩu_mới>\nhoặc:\n/evnset ${config.username} <mật_khẩu_mới> ${config.customerId} ${config.billingStartDay || 1}`,
          evnActionButtons(config),
        );
      }
    };

    this.bot.command(['dien', 'evn'], async (ctx) => {
      const arg = String(ctx.message?.text || '').split(/\s+/)[1]?.toLowerCase();
      await showEvnPanel(ctx, { broadcast: arg === 'send' || arg === 'all' || arg === '3' });
    });

    this.bot.command(['thoitiet', 'weather', 'tt'], async (ctx) => {
      const arg = String(ctx.message?.text || '').split(/\s+/)[1]?.toLowerCase();
      await showWeatherPanel(ctx, { broadcast: arg === 'send' || arg === 'all' || arg === '3' });
    });

    this.bot.command(['diadiem', 'weatherloc'], async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      const rawArgs = String(ctx.message?.text || '').replace(/^\/(?:diadiem|weatherloc)(?:@\w+)?\s*/i, '').trim();
      await applyWeatherLocationInput(ctx, rawArgs);
    });

    this.bot.action('weather:now', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await ctx.answerCbQuery('Đang lấy dự báo thời tiết...');
      await showWeatherPanel(ctx, { broadcast: false });
    });

    this.bot.action('weather:send3', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await ctx.answerCbQuery('Đang gửi thời tiết vào cả 3 nơi...');
      await showWeatherPanel(ctx, { broadcast: true });
    });

    this.bot.action('weather:loc', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await ctx.answerCbQuery('Chọn địa điểm dự báo thời tiết');
      await showWeatherLocationPicker(ctx);
    });

    this.bot.action(/^wloc:set:([^:]+)$/, async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const key = ctx.match[1];
      await ctx.answerCbQuery('Đang cập nhật địa điểm...');
      await applyWeatherLocationInput(ctx, key);
    });

    this.bot.action('wloc:custom', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const current = await this.manager.getEvnConfig();
      this.pendingSettings.set(ctx.from.id, { kind: 'weatherloc', expires: Date.now() + 5 * 60 * 1000 });
      await ctx.answerCbQuery('Nhập tên địa điểm');
      await ctx.reply(
        `📍 Hiện đang chọn: ${current.weatherLocationName || 'Hà Nội'}\n\n✍️ Gửi tên Quận/Huyện hoặc Tỉnh/Thành phố bạn muốn cài đặt ở tin nhắn tiếp theo (ví dụ: Dương Nội, Hà Đông hoặc Cầu Giấy, Hà Nội hoặc Đà Nẵng). Gõ /cancel để hủy.`,
      );
    });

    this.bot.command('evnset', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      await ctx.deleteMessage().catch(() => {});
      const rawArgs = String(ctx.message?.text || '').replace(/^\/evnset(?:@\w+)?\s*/i, '').trim();
      await applyEvnCredentialsInput(ctx, rawArgs);
    });

    this.bot.command('evnpass', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      await ctx.deleteMessage().catch(() => {});
      const newPassword = String(ctx.message?.text || '').replace(/^\/evnpass(?:@\w+)?\s*/i, '').trim();
      const current = await this.manager.getEvnConfig();
      if (!newPassword) {
        this.pendingSettings.set(ctx.from.id, { kind: 'evnpass', expires: Date.now() + 5 * 60 * 1000 });
        return ctx.reply(`🔑 Gửi mật khẩu EVN mới cho tài khoản ${current.username || '(chưa có)'} vào tin nhắn tiếp theo (hoặc gõ /cancel để hủy). Bot sẽ tự xóa tin nhắn mật khẩu của bạn.`);
      }
      await this.manager.updateEvnConfig({ password: newPassword, enabled: true });
      await ctx.reply(`✅ Đã đổi mật khẩu EVN cho tài khoản ${current.username || ''} (${current.customerId || ''}). Đang kiểm tra lại...`);
      await showEvnPanel(ctx);
    });

    this.bot.command('evnzalo', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      const arg = String(ctx.message?.text || '').split(/\s+/)[1]?.toLowerCase();
      if (arg === 'off' || arg === 'clear' || arg === 'none') {
        await this.manager.updateEvnConfig({ zaloAccountId: null, zaloConversationId: null, zaloConversationTitle: null });
        return ctx.reply('Đã tắt gửi báo cáo điện EVN sang Zalo.');
      }
      if (ctx.message?.message_thread_id) {
        const routed = this.findBridgeByTopic(ctx.message.message_thread_id, ctx.chat?.id);
        if (routed) {
          await this.manager.updateEvnConfig({
            zaloAccountId: routed.bridge.config.accountId,
            zaloConversationId: routed.mapping.conversationId,
            zaloConversationTitle: routed.mapping.title,
          });
          return ctx.reply(`✅ Đã chọn cuộc trò chuyện Zalo “${routed.mapping.title}” [${routed.bridge.config.accountId}] làm nơi nhận báo cáo điện EVN lúc 6h sáng.`);
        }
        return showEvnZaloPicker(
          ctx,
          'ℹ️ Topic bạn vừa gõ chưa phải là topic do bot tự tạo từ tin nhắn Zalo (hoặc là topic tự tạo tay). Bạn có thể bấm chọn trực tiếp cuộc trò chuyện Zalo ở danh sách dưới đây:',
        );
      }
      return showEvnZaloPicker(ctx);
    });

    this.bot.action('evn:zalo', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await ctx.answerCbQuery('Chọn cuộc trò chuyện Zalo');
      await showEvnZaloPicker(ctx);
    });

    this.bot.action('evnz:off', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await this.manager.updateEvnConfig({ zaloAccountId: null, zaloConversationId: null, zaloConversationTitle: null });
      await ctx.answerCbQuery('Đã tắt gửi Zalo');
      await ctx.reply('🚫 Đã tắt gửi báo cáo điện EVN sang Zalo.');
    });

    this.bot.action(/^evnz:self:([^:]+)$/, async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const accountId = ctx.match[1];
      const controller = this.manager?.getController(accountId);
      const selfId = controller?.zalo?.selfUserId;
      if (!selfId) return ctx.answerCbQuery('Tài khoản Zalo này chưa kết nối.');
      const title = `Cá nhân (${controller.account?.label || accountId})`;
      await this.manager.updateEvnConfig({
        zaloAccountId: accountId,
        zaloConversationId: String(selfId),
        zaloConversationTitle: title,
      });
      await ctx.answerCbQuery('Đã lưu nơi nhận Zalo');
      await ctx.reply(`✅ Đã chọn gửi báo cáo điện EVN vào Zalo “${title}” [${accountId}].`);
    });

    this.bot.action(/^evnz:c:([^:]+):(.+)$/, async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const [, accountId, conversationId] = ctx.match;
      const controller = this.manager?.getController(accountId);
      const mapping = controller?.store?.getByConversation?.(conversationId);
      const title = mapping?.title || conversationId;
      await this.manager.updateEvnConfig({
        zaloAccountId: accountId,
        zaloConversationId: String(conversationId),
        zaloConversationTitle: title,
      });
      await ctx.answerCbQuery('Đã lưu nơi nhận Zalo');
      await ctx.reply(`✅ Đã chọn cuộc trò chuyện Zalo “${title}” [${accountId}] làm nơi nhận báo cáo điện EVN lúc 6h sáng.`);
    });

    this.bot.command('evnschedule', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      const mode = parts[1]?.toLowerCase();
      const hourArg = parts[2] !== undefined ? Number(parts[2]) : undefined;
      if (!mode || !['on', 'off'].includes(mode)) {
        return ctx.reply('Dùng: /evnschedule on [giờ_0_đến_23] hoặc /evnschedule off\nVí dụ: /evnschedule on 6');
      }
      const patch = { enabled: mode === 'on' };
      if (Number.isFinite(hourArg) && hourArg >= 0 && hourArg <= 23) {
        patch.reportHour = Math.trunc(hourArg);
      }
      const updated = await this.manager.updateEvnConfig(patch);
      return ctx.reply(`⏰ Báo cáo điện EVN tự động: ${updated.enabled ? `Đang bật (${updated.reportHour}h sáng giờ VN)` : 'Đang tắt'}.`);
    });

    this.bot.action('evn:now', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await ctx.answerCbQuery('Đang lấy số điện EVN...');
      await showEvnPanel(ctx, { broadcast: false });
    });

    this.bot.action('evn:send3', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      await ctx.answerCbQuery('Đang gửi báo cáo vào cả 3 nơi...');
      await showEvnPanel(ctx, { broadcast: true });
    });

    this.bot.action('evn:toggle', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const current = await this.manager.getEvnConfig();
      const next = await this.manager.updateEvnConfig({ enabled: current.enabled === false });
      await ctx.answerCbQuery(next.enabled ? 'Đã bật báo cáo 6h sáng' : 'Đã tắt báo cáo 6h sáng');
      await ctx.reply(`⏰ Báo cáo điện EVN ${next.reportHour}h sáng: ${next.enabled ? 'Đang bật' : 'Đang tắt'}.`, evnActionButtons(next));
    });

    this.bot.action('evn:pass', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const current = await this.manager.getEvnConfig();
      this.pendingSettings.set(ctx.from.id, { kind: 'evnpass', expires: Date.now() + 5 * 60 * 1000 });
      await ctx.answerCbQuery('Nhập mật khẩu EVN mới');
      await ctx.reply(`🔑 Gửi mật khẩu EVN mới cho tài khoản ${current.username || ''} (${current.customerId || ''}) ở tin nhắn tiếp theo (hoặc /cancel để hủy). Bot sẽ tự xóa tin nhắn mật khẩu ngay khi nhận.`);
    });

    this.bot.action('evn:edit', async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery('Chỉ admin mới dùng được.');
      const current = await this.manager.getEvnConfig();
      this.pendingSettings.set(ctx.from.id, { kind: 'evnset', expires: Date.now() + 5 * 60 * 1000 });
      await ctx.answerCbQuery('Nhập thông tin EVN mới');
      await ctx.reply([
        `⚙️ Hiện đang lưu: TK ${current.username || '(trống)'} · Mã KH ${current.customerId || '(trống)'} · Ngày đầu kỳ ${current.billingStartDay || 1}`,
        '',
        'Gửi thông tin mới ở tin nhắn tiếp theo theo mẫu:',
        '<tài_khoản> <mật_khẩu> <mã_KH_PD...> [ngày_đầu_kỳ]',
        'Ví dụ: 0912345678 MatKhauMoi123 PD01001234567 1',
        '(Hoặc chỉ gửi mỗi mật khẩu mới nếu giữ nguyên tài khoản & mã KH; gõ /cancel để hủy)',
      ].join('\n'));
    });

    this.bot.on(message('text'), async (ctx, next) => {
      if (ctx.chat?.type !== 'private') return next();
      const text = String(ctx.message.text || '').trim();
      const menuText = normalizedMenuText(text);
      if (text.startsWith('/')) return next();
      if (!(await isAiUser(ctx))) return deny(ctx);
      const pending = this.pendingSettings.get(ctx.from.id);
      if (pending && isAdmin(ctx)) {
        if (Date.now() > pending.expires) {
          this.pendingSettings.delete(ctx.from.id);
          return ctx.reply('Thao tác đã hết hạn. Hãy mở lại mục vừa chọn trong menu tài khoản.');
        }
        if (pending.kind === 'rename') {
          let account;
          try {
            account = await this.manager.renameAccount(pending.accountId, text);
          } catch (error) {
            return ctx.reply(`Không đổi được tên: ${humanError(error)}\nGửi lại tên hoặc /cancel.`);
          }
          if (this.pendingSettings.get(ctx.from.id) === pending) this.pendingSettings.delete(ctx.from.id);
          return showMenu(ctx, `Đã đổi tên hiển thị thành “${account.label}” (${account.id}).`);
        }
        if (pending.kind === 'evnpass') {
          await ctx.deleteMessage().catch(() => {});
          this.pendingSettings.delete(ctx.from.id);
          const current = await this.manager.getEvnConfig();
          await this.manager.updateEvnConfig({ password: text, enabled: true });
          await ctx.reply(`✅ Đã đổi mật khẩu EVN cho TK ${current.username || ''} (${current.customerId || ''}). Đang kiểm tra kết nối...`);
          return showEvnPanel(ctx);
        }
        if (pending.kind === 'evnset') {
          await ctx.deleteMessage().catch(() => {});
          this.pendingSettings.delete(ctx.from.id);
          await applyEvnCredentialsInput(ctx, text);
          return;
        }
        if (pending.kind === 'weatherloc') {
          this.pendingSettings.delete(ctx.from.id);
          await applyWeatherLocationInput(ctx, text);
          return;
        }
        try {
          if (pending.kind === 'forum') await saveForum(ctx, pending.accountId, text);
          else await saveTopic(ctx, pending.accountId, pending.conversationId, text);
          this.pendingSettings.delete(ctx.from.id);
        } catch (error) { await ctx.reply(`Không lưu được cấu hình: ${humanError(error)}\nGửi lại ID hoặc /cancel.`); }
        return;
      }
      if (menuText === 'Kết nối Zalo') return startQr(ctx);
      if (menuText === 'Thêm tài khoản Zalo') return addZaloAccount(ctx);
      if (menuText === 'Tài khoản Zalo') return showAccounts(ctx);
      if (menuText === 'Trạng thái') return showStatus(ctx);
      if (menuText === 'Bật/tắt AI Zalo') {
        return showAccounts(ctx);
      }
      if (menuText === 'Quyền chat AI') return showAiUsers(ctx);
      if (menuText === 'Tiền điện EVN') return showEvnPanel(ctx);
      if (menuText === 'Thời tiết') return showWeatherPanel(ctx);
      if (menuText === 'Xóa lịch sử AI') {
        try {
          await this.manager?.clearAiHistory(ctx.from.id);
          return showMenu(ctx, 'Đã xóa lịch sử chat AI của bạn.');
        } catch (error) {
          return ctx.reply(`Không xóa được lịch sử: ${humanError(error)}`);
        }
      }
      if (menuText === 'Chat với AI') return showMenu(ctx, 'Gửi câu hỏi tiếp theo trong chat này để trò chuyện với AI.');
      if (!this.manager) return showMenu(ctx, 'Bot quản lý chưa sẵn sàng.');
      return this.runAiJob(ctx, async () => {
        await ctx.sendChatAction('typing');
        const answer = await this.manager.chatWithAi(ctx.from.id, text);
        for (const part of splitTelegramText(answer)) await ctx.reply(part, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      });
    });

    this.bot.command('id', async (ctx) => {
      await ctx.reply(
        [
          `chat_id: ${ctx.chat?.id}`,
          `message_thread_id: ${ctx.message?.message_thread_id || '(none)'}`,
          `from_id: ${ctx.from?.id}`,
        ].join('\n'),
      );
    });

    this.bot.command('topics', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      const mappings = [...this.bridges].flatMap((bridge) =>
        bridge.store.listMappings().map((item) => ({
          account: bridge.config.accountLabel || bridge.config.accountId || 'Zalo',
          ...item,
        })),
      );
      const text =
        mappings.length === 0
          ? 'Chưa có topic nào được map.'
          : mappings
              .map((item) => `[${item.account}] ${item.topicId} -> ${item.title} (${item.conversationId})`)
              .join('\n');
      await ctx.reply(text);
    });

    this.bot.command(['undo', 'recall', 'thuhoi'], async (ctx) => {
      if (!ctx.message?.message_thread_id) {
        return ctx.reply('Dùng /undo trong topic Zalo (có thể reply vào tin nhắn muốn thu hồi, hoặc gõ /undo để thu hồi tin vừa gửi gần nhất).');
      }
      const routed = this.findBridgeByTopic(ctx.message.message_thread_id, ctx.chat?.id);
      if (!routed) return ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      await routed.bridge.handleTelegramUndo(ctx, routed.mapping);
    });

    this.bot.command('react', async (ctx) => {
      if (!ctx.message?.message_thread_id || !ctx.message?.reply_to_message) {
        return ctx.reply('Reply vào một tin nhắn trong topic Zalo rồi gõ /react ❤️ (hoặc 👍 😂 😮 😢 😡 / off). Bạn cũng có thể bấm thả cảm xúc trực tiếp vào tin nhắn.');
      }
      const routed = this.findBridgeByTopic(ctx.message.message_thread_id, ctx.chat?.id);
      if (!routed) return ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      const arg = ctx.message.text.replace(/^\/react(?:@\w+)?\s*/i, '').trim();
      await routed.bridge.handleTelegramReaction(
        ctx,
        arg || '❤️',
        ctx.message.reply_to_message.message_id,
        routed.mapping,
        { replyOnSuccess: true },
      );
    });

    this.bot.on('message_reaction', async (ctx) => {
      const reactionUpdate = ctx.update?.message_reaction;
      if (!reactionUpdate) return;
      const chatId = reactionUpdate.chat?.id;
      const messageId = reactionUpdate.message_id;
      const userId = reactionUpdate.user?.id || ctx.from?.id;
      for (const bridge of this.bridges) {
        if (Number(bridge.config.telegramForumChatId) !== Number(chatId)) continue;
        if (!isAllowed(bridge.config, userId)) continue;
        const entry = bridge.store.findMessageByTelegramId?.(null, messageId);
        if (!entry) continue;
        const mapping = (entry.topicId && bridge.store.getByTopic?.(entry.topicId)) ||
          Object.values(bridge.store.state?.conversations || {}).find((c) => Number(c.topicId) === Number(entry.topicId));
        if (!mapping) continue;
        const latest = Array.isArray(reactionUpdate.new_reaction) ? reactionUpdate.new_reaction.at(-1) : null;
        const emoji = latest?.emoji || '';
        await bridge.handleTelegramReaction(ctx, emoji, messageId, mapping, { replyOnSuccess: false });
        return;
      }
    });

    this.bot.on(message('text'), async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        if (ctx.chat?.type === 'private') await ctx.reply('Lệnh chưa được hỗ trợ trong phiên bản đang chạy. Dùng /menu hoặc /ping.');
        return;
      }
      await this.routeTelegramMessage(ctx, 'text');
    });

    this.bot.on(message('photo'), async (ctx) => {
      if (ctx.chat?.type === 'private') {
        if (!(await isAiUser(ctx))) return deny(ctx);
        return this.runAiJob(ctx, async () => {
          await ctx.sendChatAction('typing');
          const imageUrl = await telegramPhotoDataUrl(ctx);
          const answer = await this.manager.chatWithAi(
            ctx.from.id,
            ctx.message.caption || 'Hãy phân tích hình ảnh này.',
            [imageUrl],
          );
          for (const part of splitTelegramText(answer)) await ctx.reply(part, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
        });
      }
      await this.routeTelegramMessage(ctx, 'photo');
    });

    this.bot.on(message('document'), async (ctx) => {
      await this.routeTelegramMessage(ctx, 'document');
    });

    this.bot.on(message('voice'), async (ctx) => {
      await this.routeTelegramMessage(ctx, 'voice');
    });

    this.bot.on(message('audio'), async (ctx) => {
      await this.routeTelegramMessage(ctx, 'audio');
    });

    this.bot.on(message('video'), async (ctx) => {
      await this.routeTelegramMessage(ctx, 'video');
    });

    this.bot.on(message('video_note'), async (ctx) => {
      await this.routeTelegramMessage(ctx, 'video_note');
    });

    this.bot.catch(async (error, ctx) => {
      this.logger.error({ error, updateType: ctx.updateType }, 'Telegram handler failed');
      if (ctx.chat?.type === 'private') {
        await ctx.reply(`Không xử lý được lệnh: ${humanError(error)}\nDùng /ping để kiểm tra kết nối bot.`).catch(() => {});
      }
    });
  }

  async routeTelegramMessage(ctx, type) {
    const updateId = ctx.update?.update_id;
    if (![...this.bridges].some((bridge) => Number(bridge.config.telegramForumChatId) === Number(ctx.chat?.id))) return;
    if (!ctx.message.message_thread_id) {
      if (type !== 'text') {
        await ctx.reply('Tệp này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      }
      return;
    }

    const routed = this.findBridgeByTopic(ctx.message.message_thread_id, ctx.chat.id);
    if (!routed) {
      if (type !== 'text') {
        await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      }
      return;
    }

    const dedupeKey = Number.isSafeInteger(updateId) ? String(updateId) : null;
    if (dedupeKey) {
      const now = Date.now();
      for (const [id, timestamp] of this.processedUpdates) {
        if (now - timestamp > 24 * 60 * 60 * 1000) this.processedUpdates.delete(id);
      }
      if (this.processedUpdates.has(dedupeKey) || this.inFlightUpdates.has(dedupeKey)) return;
      this.inFlightUpdates.add(dedupeKey);
    }

    // At-most-once delivery to Zalo: claim the update durably (MongoDB) BEFORE
    // sending. A webhook redelivered after a restart/redeploy is then skipped
    // instead of being sent to Zalo again. Sending to Zalo is never retried.
    if (dedupeKey && typeof routed.bridge.store?.claimTelegramUpdate === 'function') {
      let claimed = true;
      try {
        claimed = await routed.bridge.store.claimTelegramUpdate(`${this.updateKeyPrefix}:${dedupeKey}`);
      } catch (error) {
        this.logger.warn({ error: humanError(error), updateId }, 'Could not persist Telegram update claim; using in-memory dedupe only.');
      }
      if (!claimed) {
        this.inFlightUpdates.delete(dedupeKey);
        this.processedUpdates.set(dedupeKey, Date.now());
        this.logger.warn({ updateId }, 'Skipped Telegram update already forwarded to Zalo (redelivery).');
        return;
      }
    }

    try {
      if (type === 'text') {
        await routed.bridge.forwardTelegramText(ctx, routed.mapping);
      } else if (type === 'photo') {
        await routed.bridge.forwardTelegramPhoto(ctx, routed.mapping);
      } else if (type === 'voice' || type === 'audio') {
        await routed.bridge.forwardTelegramVoice(ctx, routed.mapping);
      } else if (type === 'video' || type === 'video_note') {
        await routed.bridge.forwardTelegramVideo(ctx, routed.mapping);
      } else {
        await routed.bridge.forwardTelegramDocument(ctx, routed.mapping);
      }
      if (dedupeKey) {
        this.processedUpdates.set(dedupeKey, Date.now());
        if (this.processedUpdates.size > 10000) {
          this.processedUpdates.delete(this.processedUpdates.keys().next().value);
        }
      }
    } catch (error) {
      if (dedupeKey) this.processedUpdates.set(dedupeKey, Date.now());
      this.logger.error(
        {
          error,
          updateId,
          topicId: ctx.message.message_thread_id,
          accountId: routed.bridge.config.accountId,
          conversationId: routed.mapping.conversationId,
        },
        'Could not forward Telegram message to Zalo.',
      );
      await ctx.reply(`Không gửi được sang Zalo.\n${humanError(error)}`).catch(() => {});
    } finally {
      if (dedupeKey) this.inFlightUpdates.delete(dedupeKey);
    }
  }
}

function getRuntime(config, logger) {
  const key = runtimeKey(config);
  if (!runtimes.has(key)) {
    runtimes.set(key, new SharedTelegramRuntime(config, logger));
  }
  return runtimes.get(key);
}

export async function startTelegramControlBot({ config, manager, logger }) {
  const runtime = getRuntime(config, logger);
  runtime.manager = manager;
  runtime.controlStarted = true;
  if (!runtime.onAiError) {
    const recentErrors = new Map();
    runtime.onAiError = (event) => {
      const last = recentErrors.get(event.accountId);
      if (last && last.error === event.error && Date.now() - last.at < 60000) return;
      recentErrors.set(event.accountId, { error: event.error, at: Date.now() });
      const admins = runtime.config.telegramAdminIds || new Set();
      for (const id of admins) {
        runtime.bot.telegram.sendMessage(id, `⚠️ AI Zalo gặp lỗi [${event.accountId}]\n${humanError(event.error)}\nDùng /aitest ${event.accountId} để kiểm tra endpoint, key và model.`)
          .catch((error) => logger.warn({ error }, 'Could not report Zalo AI error to administrator.'));
      }
    };
    manager.on('aiError', runtime.onAiError);
  }
  if (!runtime.onTelegramError) {
    const recent = new Map();
    runtime.onTelegramError = (event) => {
      const key = `${event.accountId}:${event.chatId}`;
      if (Date.now() - (recent.get(key) || 0) < 60000) return;
      recent.set(key, Date.now());
      for (const id of runtime.config.telegramAdminIds || []) {
        const hint = event.rateLimited
          ? 'Telegram đang giới hạn tốc độ; tin này chưa gửi được sau các lần thử. Bot sẽ giãn các lượt gửi tiếp theo.'
          : event.destinationError
            ? `Kiểm tra nhóm và quyền Manage Topics bằng /telegramtest ${event.accountId}.`
            : 'Xem log Koyeb để biết chi tiết.';
        runtime.bot.telegram.sendMessage(id, `⚠️ Không chuyển được tin Zalo sang Telegram [${event.accountId}]\nNhóm: ${event.chatId}\n${humanError(event.error)}\n${hint}`)
          .catch((error) => logger.warn({ error }, 'Could not report Telegram bridge error.'));
      }
    };
    manager.on('telegramError', runtime.onTelegramError);
  }
  await runtime.start();
  return runtime;
}

export function stopTelegramControlBot(runtime, reason = 'shutdown') {
  if (!runtime) return;
  runtime.controlStarted = false;
  if (runtime.onAiError) {
    runtime.manager?.off('aiError', runtime.onAiError);
    runtime.onAiError = null;
  }
  if (runtime.onTelegramError) {
    runtime.manager?.off('telegramError', runtime.onTelegramError);
    runtime.onTelegramError = null;
  }
  if (runtime.bridges.size > 0) return;
  runtime.stopTransport(reason);
  runtime.handlersRegistered = false;
  runtime._recreateBot();
}

export class TelegramBridgeBot {
  constructor({ config, store, zalo, logger, pendingEcho, onTranscript, onBridgeError }) {
    this.config = config;
    this.store = store;
    this.zalo = zalo;
    this.logger = logger;
    this.pendingEcho = pendingEcho || null;
    this.onTranscript = onTranscript;
    this.onBridgeError = onBridgeError;
    this.forwardingBlockedUntil = 0;
    this.forwardingZaloMessages = new Set();
    this.pendingTopics = new Map();
    this.forwardingAbort = new AbortController();
    this.runtime = getRuntime(config, logger);
    this.bot = this.runtime.bot;
  }

  async start() {
    if (this.forwardingAbort.signal.aborted) this.forwardingAbort = new AbortController();
    await ensureDir(this.config.downloadDir);
    this.runtime.addBridge(this);
    await this.runtime.start();
  }

  stop(reason) {
    this.forwardingAbort.abort();
    this.runtime.removeBridge(this, reason);
  }

  async ensureTopicForZaloMessage(zaloMessage) {
    const existing = this.store.getByConversation(zaloMessage.conversationId);
    if (existing) {
      return this.refreshTopicTitle(existing, zaloMessage);
    }

    return this.createTopicMapping(zaloMessage);
  }

  async createTopicMapping(zaloMessage, previous = null) {
    const key = String(zaloMessage.conversationId);
    if (this.pendingTopics.has(key)) return this.pendingTopics.get(key);
    const chatId = this.config.telegramForumChatId;
    const task = this.runtime.groupQueue.run(chatId, () => this.bot.telegram.createForumTopic(
      chatId, topicName(zaloMessage.title, this.config.accountLabel),
    ), this.forwardingAbort.signal).then((topic) => this.store.upsertMapping({
      ...previous, conversationId: zaloMessage.conversationId, threadType: zaloMessage.threadType,
      topicId: topic.message_thread_id, title: zaloMessage.title,
    })).finally(() => this.pendingTopics.delete(key));
    this.pendingTopics.set(key, task);
    return task;
  }

  async refreshTopicTitle(existing, zaloMessage) {
    const nextTitle = zaloMessage.title || existing.title;
    if (!nextTitle || nextTitle === existing.title) return existing;

    try {
      const chatId = this.config.telegramForumChatId;
      await this.runtime.groupQueue.run(chatId, () => this.bot.telegram.editForumTopic(chatId, existing.topicId, {
        name: topicName(nextTitle, this.config.accountLabel),
      }), this.forwardingAbort.signal);
    } catch (error) {
      if (this.forwardingAbort.signal.aborted) throw error;
      this.logger.warn({ error, topicId: existing.topicId }, 'Could not rename Telegram topic.');
      return existing;
    }

    return this.store.upsertMapping({
      ...existing,
      title: nextTitle,
    });
  }

  async forwardZaloMessage(zaloMessage) {
    if (Date.now() < this.forwardingBlockedUntil) return;
    const messageId = String(zaloMessage.id || '');
    const key = messageId ? `${zaloMessage.conversationId}:${messageId}` : '';
    if (key && this.forwardingZaloMessages.has(key)) return;
    if (key) this.forwardingZaloMessages.add(key);
    try {
      if (
        messageId &&
        this.store.listMessages(zaloMessage.conversationId, 500).some((entry) => String(entry.id) === messageId)
      ) return;

    let mapping = await this.ensureTopicForZaloMessage(zaloMessage);
    const direction = zaloMessage.isSelf ? 'out' : 'in';
    const source = zaloMessage.isSelf ? 'zalo-self' : 'zalo';
    const senderName = zaloMessage.senderName;

    let telegramMessage;
    try {
      telegramMessage = await this.sendZaloMessageToTelegram(mapping, zaloMessage);
    } catch (error) {
      if (!isTelegramThreadNotFound(error)) throw error;
      this.logger.warn(
        { error, topicId: mapping.topicId, conversationId: mapping.conversationId },
        'Telegram topic is missing; recreating topic mapping.',
      );
      mapping = await this.createTopicMapping(zaloMessage, mapping);
      telegramMessage = await this.sendZaloMessageToTelegram(mapping, zaloMessage);
    }

    await this.onTranscript?.(mapping, {
      id: zaloMessage.id,
      direction,
      source,
      senderName,
      text: zaloMessage.text,
      attachment: zaloMessage.attachment,
      telegramMessageId: telegramMessage?.message_id,
      replyData: quoteDataForZalo(zaloMessage),
      threadType: zaloMessage.threadType,
    });
    } catch (error) {
      if (this.forwardingAbort.signal.aborted) return;
      const destinationError = isTelegramDestinationError(error);
      if (destinationError) this.forwardingBlockedUntil = Date.now() + 60000;
      this.onBridgeError?.({
        chatId: this.config.telegramForumChatId,
        error: humanError(error),
        rateLimited: telegramRateLimitSeconds(error) !== null,
        destinationError,
      });
      throw error;
    } finally {
      if (key) this.forwardingZaloMessages.delete(key);
    }
  }

  async sendZaloMessageToTelegram(mapping, zaloMessage) {
    const chatId = this.config.telegramForumChatId;
    // Zalo -> Telegram: a rare duplicate in the topic is better than a lost
    // message, so allow one retry after an ambiguous timeout here.
    const send = (action) => this.runtime.groupQueue.run(chatId, action, this.forwardingAbort.signal, { retryAmbiguous: true });
    const options = { message_thread_id: mapping.topicId };
    const caption = formatZaloMessage(zaloMessage).slice(0, 1024);
    const sendAsText = (note = '') => send(() => this.bot.telegram.sendMessage(
      chatId,
      `${formatZaloMessage(zaloMessage)}${note ? `\n${note}` : ''}\n${zaloMessage.attachment.url}`.slice(0, 4096),
      options,
    ));
    const passThrough = (error) => this.forwardingAbort.signal.aborted || isTelegramThreadNotFound(error) ||
      telegramRateLimitSeconds(error) !== null || isTelegramDestinationError(error);

    if (zaloMessage.attachment?.url) {
      let file;
      try {
        file = await (this.downloadAttachment || downloadZaloAttachment)(zaloMessage.attachment);
      } catch (error) {
        if (this.forwardingAbort.signal.aborted) throw error;
        this.logger.warn({ error: humanError(error), url: zaloMessage.attachment.url }, 'Could not download Zalo attachment; sending link instead.');
        return sendAsText(error?.tooLarge ? '(Tệp lớn hơn 20 MB, mở link để tải)' : '(Không tải được tệp, mở link để xem)');
      }
      const upload = (method) => send(() => this.bot.telegram[method](
        chatId,
        Input.fromBuffer(file.buffer, file.filename),
        { ...options, caption },
      ));
      const method =
        file.kind === 'photo'
          ? 'sendPhoto'
          : file.kind === 'video'
            ? 'sendVideo'
            : file.kind === 'voice'
              ? 'sendVoice'
              : file.kind === 'audio'
                ? 'sendAudio'
                : 'sendDocument';
      try {
        return await upload(method);
      } catch (error) {
        if (passThrough(error)) throw error;
        if (method === 'sendVoice' && Number(error?.response?.error_code) === 400 && typeof this.bot.telegram.sendAudio === 'function') {
          this.logger.warn({ error: humanError(error) }, 'Telegram rejected sendVoice; retrying as audio.');
          try {
            return await upload('sendAudio');
          } catch (audioError) {
            if (passThrough(audioError)) throw audioError;
            error = audioError;
          }
        }
        if (method !== 'sendDocument' && Number(error?.response?.error_code) === 400) {
          // e.g. PHOTO_INVALID_DIMENSIONS / IMAGE_PROCESS_FAILED: still deliver the file.
          this.logger.warn({ error: humanError(error) }, `Telegram rejected ${method}; retrying as document.`);
          try {
            return await upload('sendDocument');
          } catch (documentError) {
            if (passThrough(documentError)) throw documentError;
            error = documentError;
          }
        }
        this.logger.warn({ error: humanError(error) }, 'Could not upload Zalo attachment to Telegram; sending link instead.');
        return sendAsText('(Không gửi được tệp, mở link để xem)');
      }
    }

    return send(() => this.bot.telegram.sendMessage(
      chatId,
      formatZaloMessage(zaloMessage),
      options,
    ));
  }

  async forwardTelegramText(ctx, mapped = null) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) return;
    if (!isAllowed(this.config, ctx.from.id)) {
      await ctx.reply(
        'Bạn chưa được cấp quyền gửi sang Zalo. Telegram user ID của bạn là ' + ctx.from?.id + '. Thêm ID này vào ALLOWED_TELEGRAM_USER_IDS trong biến môi trường của service bridge (Koyeb/Render) rồi redeploy.',
      );
      return;
    }

    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) return;
    const quote = ctx.message.reply_to_message
      ? this.store.getReplyData(ctx.message.reply_to_message.message_id)
      : null;

    this.pendingEcho?.register?.(mapping.conversationId);
    let sent;
    try {
      sent = await this.zalo.sendText({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        text: ctx.message.text,
        quote,
      });
    } catch (error) {
      this.pendingEcho?.consume?.(mapping.conversationId);
      throw error;
    }
    await this.onTranscript?.(mapping, {
      ...(sent?.msgId ? { id: String(sent.msgId) } : {}),
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.text,
      attachment: null,
      telegramMessageId: ctx.message?.message_id,
      replyData: sent?.msgId ? { msgId: String(sent.msgId), ...(sent.cliMsgId ? { cliMsgId: String(sent.cliMsgId) } : {}) } : null,
      threadType: mapping.threadType,
    });
  }

  async forwardTelegramPhoto(ctx, mapped = null) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) {
      await ctx.reply('Ảnh này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      return;
    }
    if (!isAllowed(this.config, ctx.from.id)) {
      await ctx.reply(
        'Bạn chưa được cấp quyền gửi sang Zalo. Telegram user ID của bạn là ' + ctx.from?.id + '. Thêm ID này vào ALLOWED_TELEGRAM_USER_IDS trong biến môi trường của service bridge (Koyeb/Render) rồi redeploy.',
      );
      return;
    }

    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }
    const quote = ctx.message.reply_to_message
      ? this.store.getReplyData(ctx.message.reply_to_message.message_id)
      : null;

    const largestPhoto = ctx.message.photo.at(-1);
    const targetPath = await this.downloadTelegramFile(ctx, largestPhoto.file_id, largestPhoto.file_unique_id, 'jpg');
    this.logger.info(
      { topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId, filePath: targetPath },
      'Downloaded Telegram photo for Zalo forwarding.',
    );

    this.pendingEcho?.register?.(mapping.conversationId);
    let sent;
    try {
      sent = await this.zalo.sendImage({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        filePath: targetPath,
        caption: ctx.message.caption,
        quote,
      });
      this.logger.info(
        { topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId },
        'Forwarded Telegram photo to Zalo.',
      );
    } catch (error) {
      this.pendingEcho?.consume?.(mapping.conversationId);
      this.logger.error(
        { error, topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId },
        'Could not forward Telegram photo to Zalo.',
      );
      await ctx.reply(`Không gửi được ảnh sang Zalo.\n${humanError(error)}`);
      throw error;
    } finally {
      await this.cleanupTelegramFile(targetPath);
    }
    await this.onTranscript?.(mapping, {
      ...(sent?.msgId ? { id: String(sent.msgId) } : {}),
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.caption || '',
      attachment: {
        title: 'image',
      },
      telegramMessageId: ctx.message?.message_id,
      replyData: sent?.msgId ? { msgId: String(sent.msgId), ...(sent.cliMsgId ? { cliMsgId: String(sent.cliMsgId) } : {}) } : null,
      threadType: mapping.threadType,
    });
  }

  async forwardTelegramDocument(ctx, mapped = null) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) {
      await ctx.reply('Tệp này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      return;
    }
    if (!isAllowed(this.config, ctx.from.id)) {
      await ctx.reply(
        'Bạn chưa được cấp quyền gửi sang Zalo. Telegram user ID của bạn là ' + ctx.from?.id + '. Thêm ID này vào ALLOWED_TELEGRAM_USER_IDS trong biến môi trường của service bridge (Koyeb/Render) rồi redeploy.',
      );
      return;
    }
    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }
    const quote = ctx.message.reply_to_message
      ? this.store.getReplyData(ctx.message.reply_to_message.message_id)
      : null;

    const document = ctx.message.document;
    const isImage = document.mime_type?.startsWith('image/');
    const extension = document.file_name?.split('.').at(-1) || (isImage ? 'jpg' : 'bin');
    const filename = document.file_name || `file-${document.file_unique_id}.${isImage ? 'jpg' : 'bin'}`;
    const targetPath = await this.downloadTelegramFile(
      ctx,
      document.file_id,
      document.file_unique_id,
      extension,
      document.file_size,
    );
    this.logger.info(
      { topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId, filePath: targetPath },
      'Downloaded Telegram document for Zalo forwarding.',
    );

    this.pendingEcho?.register?.(mapping.conversationId);
    let sent;
    try {
      const send = isImage ? this.zalo.sendImage.bind(this.zalo) : this.zalo.sendFile.bind(this.zalo);
      sent = await send({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        filePath: targetPath,
        filename,
        caption: ctx.message.caption,
        quote,
      });
      this.logger.info(
        { topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId },
        'Forwarded Telegram document to Zalo.',
      );
    } catch (error) {
      this.pendingEcho?.consume?.(mapping.conversationId);
      this.logger.error(
        { error, topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId },
        'Could not forward Telegram document to Zalo.',
      );
      throw error;
    } finally {
      await this.cleanupTelegramFile(targetPath);
    }
    await this.onTranscript?.(mapping, {
      ...(sent?.msgId ? { id: String(sent.msgId) } : {}),
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.caption || '',
      attachment: {
        title: filename,
        type: isImage ? 'image' : 'file',
      },
      telegramMessageId: ctx.message?.message_id,
      replyData: sent?.msgId ? { msgId: String(sent.msgId), ...(sent.cliMsgId ? { cliMsgId: String(sent.cliMsgId) } : {}) } : null,
      threadType: mapping.threadType,
    });
  }

  async forwardTelegramVoice(ctx, mapped = null) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) {
      await ctx.reply('Ghi âm này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      return;
    }
    if (!isAllowed(this.config, ctx.from.id)) {
      await ctx.reply(
        'Bạn chưa được cấp quyền gửi sang Zalo. Telegram user ID của bạn là ' + ctx.from?.id + '. Thêm ID này vào ALLOWED_TELEGRAM_USER_IDS trong biến môi trường của service bridge (Koyeb/Render) rồi redeploy.',
      );
      return;
    }
    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }
    const quote = ctx.message.reply_to_message
      ? this.store.getReplyData(ctx.message.reply_to_message.message_id)
      : null;

    const media = ctx.message.voice || ctx.message.audio;
    const isVoiceNote = Boolean(ctx.message.voice);
    const ext = media.file_name?.split('.').at(-1) || (isVoiceNote ? 'm4a' : 'mp3');
    const filename = media.file_name || `voice-${media.file_unique_id}.${ext}`;
    const targetPath = await this.downloadTelegramFile(ctx, media.file_id, media.file_unique_id, ext, media.file_size);

    this.pendingEcho?.register?.(mapping.conversationId);
    let sent;
    try {
      const send = typeof this.zalo.sendVoice === 'function' ? this.zalo.sendVoice.bind(this.zalo) : this.zalo.sendFile.bind(this.zalo);
      sent = await send({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        filePath: targetPath,
        filename,
        caption: ctx.message.caption,
        quote,
      });
    } catch (error) {
      this.pendingEcho?.consume?.(mapping.conversationId);
      throw error;
    } finally {
      await this.cleanupTelegramFile(targetPath);
    }
    await this.onTranscript?.(mapping, {
      ...(sent?.msgId ? { id: String(sent.msgId) } : {}),
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.caption || '',
      attachment: { title: filename, type: 'voice' },
      telegramMessageId: ctx.message?.message_id,
      replyData: sent?.msgId ? { msgId: String(sent.msgId), ...(sent.cliMsgId ? { cliMsgId: String(sent.cliMsgId) } : {}) } : null,
      threadType: mapping.threadType,
    });
  }

  async forwardTelegramVideo(ctx, mapped = null) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) {
      await ctx.reply('Video này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      return;
    }
    if (!isAllowed(this.config, ctx.from.id)) {
      await ctx.reply(
        'Bạn chưa được cấp quyền gửi sang Zalo. Telegram user ID của bạn là ' + ctx.from?.id + '. Thêm ID này vào ALLOWED_TELEGRAM_USER_IDS trong biến môi trường của service bridge (Koyeb/Render) rồi redeploy.',
      );
      return;
    }
    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }
    const quote = ctx.message.reply_to_message
      ? this.store.getReplyData(ctx.message.reply_to_message.message_id)
      : null;

    const media = ctx.message.video || ctx.message.video_note;
    const filename = media.file_name || `video-${media.file_unique_id}.mp4`;
    const targetPath = await this.downloadTelegramFile(ctx, media.file_id, media.file_unique_id, 'mp4', media.file_size);
    let thumbPath = null;
    const thumb = media.thumbnail || media.thumb;
    if (thumb?.file_id) {
      try {
        thumbPath = await this.downloadTelegramFile(ctx, thumb.file_id, `${media.file_unique_id}-thumb`, 'jpg', thumb.file_size);
      } catch {
        thumbPath = null;
      }
    }

    this.pendingEcho?.register?.(mapping.conversationId);
    let sent;
    try {
      const send = typeof this.zalo.sendVideo === 'function' ? this.zalo.sendVideo.bind(this.zalo) : this.zalo.sendFile.bind(this.zalo);
      sent = await send({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        filePath: targetPath,
        filename,
        thumbnailPath: thumbPath,
        duration: media.duration || 0,
        width: media.width || media.length || 1280,
        height: media.height || media.length || 720,
        caption: ctx.message.caption,
        quote,
      });
    } catch (error) {
      this.pendingEcho?.consume?.(mapping.conversationId);
      throw error;
    } finally {
      await this.cleanupTelegramFile(targetPath);
      await this.cleanupTelegramFile(thumbPath);
    }
    await this.onTranscript?.(mapping, {
      ...(sent?.msgId ? { id: String(sent.msgId) } : {}),
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.caption || '',
      attachment: { title: filename, type: 'video' },
      telegramMessageId: ctx.message?.message_id,
      replyData: sent?.msgId ? { msgId: String(sent.msgId), ...(sent.cliMsgId ? { cliMsgId: String(sent.cliMsgId) } : {}) } : null,
      threadType: mapping.threadType,
    });
  }

  async handleTelegramUndo(ctx, mapped = null) {
    if (!isAllowed(this.config, ctx.from?.id)) {
      return ctx.reply('Bạn chưa được cấp quyền thao tác với Zalo.');
    }
    const mapping = mapped || this.store.getByTopic?.(ctx.message?.message_thread_id);
    if (!mapping) return ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');

    const replyId = ctx.message?.reply_to_message?.message_id;
    const entry = replyId
      ? this.store.findMessageByTelegramId?.(mapping.conversationId, replyId)
      : this.store.findLastOutgoingMessage?.(mapping.conversationId);

    if (!entry) {
      return ctx.reply(replyId
        ? 'Không tìm thấy mã tin nhắn Zalo của tin được reply để thu hồi.'
        : 'Không tìm thấy tin nhắn nào vừa gửi sang Zalo trong topic này để thu hồi.');
    }
    if (entry.direction !== 'out') {
      return ctx.reply('Chỉ thu hồi được tin nhắn do phía bạn gửi đi.');
    }
    const msgId = entry.replyData?.msgId ?? (entry.id && !String(entry.id).includes('-') ? entry.id : null);
    const cliMsgId = entry.replyData?.cliMsgId ?? msgId;
    if (!msgId) {
      return ctx.reply('Chưa nhận được msgId từ Zalo cho tin nhắn này nên chưa thu hồi được.');
    }

    try {
      await this.zalo.undoMessage({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        msgId,
        cliMsgId,
      });
      await this.store.markMessageRecalled?.(mapping.conversationId, entry);
      if (entry.telegramMessageId) {
        await this.bot.telegram.deleteMessage(this.config.telegramForumChatId, entry.telegramMessageId).catch(() => {});
      }
      await ctx.reply('🗑 Đã thu hồi tin nhắn trên Zalo.');
    } catch (error) {
      await ctx.reply(`Không thu hồi được tin nhắn trên Zalo.\n${humanError(error)}`);
    }
  }

  async handleTelegramReaction(ctx, emojiOrInput, targetTelegramMessageId, mapped = null, { replyOnSuccess = false } = {}) {
    const userId = ctx.from?.id || ctx.update?.message_reaction?.user?.id;
    if (!isAllowed(this.config, userId)) return;
    const entry = this.store.findMessageByTelegramId?.(mapped?.conversationId || null, targetTelegramMessageId);
    if (!entry) {
      if (replyOnSuccess) await ctx.reply('Không tìm thấy tin nhắn Zalo tương ứng để thả cảm xúc.');
      return;
    }
    const mapping = mapped || (entry.topicId && this.store.getByTopic?.(entry.topicId));
    if (!mapping) return;
    const msgId = entry.replyData?.msgId ?? (entry.id && !String(entry.id).includes('-') ? entry.id : null);
    const cliMsgId = entry.replyData?.cliMsgId ?? msgId;
    if (!msgId) {
      if (replyOnSuccess) await ctx.reply('Tin nhắn này chưa có msgId Zalo để thả cảm xúc.');
      return;
    }
    const reaction = telegramReactionToZalo(emojiOrInput);
    try {
      this.pendingReactionEchoes ||= new Map();
      this.pendingReactionEchoes.set(`${mapping.conversationId}:${msgId}`, Date.now() + 10000);
      await this.zalo.sendReaction({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        msgId,
        cliMsgId,
        reaction,
      });
      if (replyOnSuccess) {
        const tgEmoji = zaloReactionToTelegram(reaction);
        if (entry.telegramMessageId) {
          await this.bot.telegram.callApi('setMessageReaction', {
            chat_id: this.config.telegramForumChatId,
            message_id: entry.telegramMessageId,
            reaction: tgEmoji ? [{ type: 'emoji', emoji: tgEmoji }] : [],
          }).catch(() => {});
        }
      }
    } catch (error) {
      this.logger.warn({ error, msgId }, 'Could not send reaction to Zalo.');
      if (replyOnSuccess) await ctx.reply(`Không thả được cảm xúc sang Zalo.\n${humanError(error)}`);
    }
  }

  async handleZaloUndo(undoEvent) {
    if (!undoEvent?.conversationId) return;
    const mapping = this.store.getByConversation?.(undoEvent.conversationId);
    if (!mapping) return;
    const entry = this.store.findMessageByZaloId?.(undoEvent.conversationId, {
      msgId: undoEvent.msgId,
      cliMsgId: undoEvent.cliMsgId,
    });
    if (entry?.recalledAt) return;
    if (entry) await this.store.markMessageRecalled?.(undoEvent.conversationId, entry);
    const chatId = this.config.telegramForumChatId;
    const send = (action) => this.runtime.groupQueue.run(chatId, action, this.forwardingAbort.signal, { retryAmbiguous: true });
    const who = undoEvent.isSelf ? 'Tôi' : (undoEvent.senderName || mapping.title || 'Zalo');
    const text = entry
      ? `🗑 [${who}] đã thu hồi tin nhắn này trên Zalo.`
      : `🗑 [${who}] đã thu hồi một tin nhắn trên Zalo.`;
    await send(() => this.bot.telegram.sendMessage(chatId, text, {
      message_thread_id: mapping.topicId,
      ...(entry?.telegramMessageId ? { reply_to_message_id: entry.telegramMessageId } : {}),
    }));
  }

  async handleZaloReaction(reactionEvent) {
    if (!reactionEvent?.conversationId) return;
    const mapping = this.store.getByConversation?.(reactionEvent.conversationId);
    if (!mapping) return;
    const emoji = zaloReactionToTelegram(reactionEvent.rIcon);
    const chatId = this.config.telegramForumChatId;
    const send = (action) => this.runtime.groupQueue.run(chatId, action, this.forwardingAbort.signal);

    for (const target of reactionEvent.targets || []) {
      const entry = this.store.findMessageByZaloId?.(reactionEvent.conversationId, target);
      if (!entry?.telegramMessageId) continue;
      const echoKey = `${reactionEvent.conversationId}:${entry.replyData?.msgId ?? entry.id}`;
      const echoExpiry = this.pendingReactionEchoes?.get(echoKey) || 0;
      if (reactionEvent.isSelf && echoExpiry >= Date.now()) {
        this.pendingReactionEchoes.delete(echoKey);
        continue;
      }
      await send(() => this.bot.telegram.callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: entry.telegramMessageId,
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      })).catch((error) => {
        this.logger.warn({ error: humanError(error), messageId: entry.telegramMessageId }, 'Could not set Telegram message reaction.');
      });
    }
  }

  async handleZaloEvnCommand(zaloMessage) {
    if (!zaloMessage?.conversationId) return;
    const text = String(zaloMessage.text || '').trim();
    const match = /^\/(dien|evn|evnzalo|thoitiet|weather|tt|diadiem|weatherloc)(?:@\w+)?(?:\s+(.*))?$/is.exec(text);
    if (!match) return;
    const manager = this.runtime?.manager;
    if (!manager?.getEvnConfig) return;

    const cmd = match[1].toLowerCase();
    const argText = String(match[2] || '').trim();
    const title = zaloMessage.title || zaloMessage.senderName || zaloMessage.conversationId;
    const threadType = zaloMessage.threadType ?? 0;

    const sendZaloReply = async (replyText) => {
      this.pendingEcho?.register?.(zaloMessage.conversationId, replyText);
      try {
        await this.zalo.sendText({
          conversationId: String(zaloMessage.conversationId),
          threadType,
          text: replyText,
        });
      } catch (error) {
        this.pendingEcho?.consume?.(zaloMessage.conversationId);
        throw error;
      }
    };

    if (cmd === 'evnzalo') {
      await manager.updateEvnConfig({
        zaloAccountId: this.config.accountId,
        zaloConversationId: String(zaloMessage.conversationId),
        zaloConversationTitle: title,
        zaloThreadType: threadType,
      });
      await sendZaloReply(
        `✅ Đã chọn cuộc trò chuyện Zalo "${title}" làm nơi nhận 2 bản tin lúc 06:00 sáng hàng ngày (1 tin Điện EVN + 1 tin Thời tiết).\nBạn có thể gõ /dien hoặc /thoitiet ngay tại đây bất cứ lúc nào!`,
      );
      return;
    }

    if (cmd === 'diadiem' || cmd === 'weatherloc') {
      const current = await manager.getEvnConfig();
      if (!argText) {
        await sendZaloReply(
          `📍 Địa điểm dự báo thời tiết hiện tại: ${current.weatherLocationName || 'Hà Nội'}\nĐể đổi địa điểm, gõ: /diadiem <tên Quận/Huyện hoặc Tỉnh/TP>\nVí dụ: /diadiem Dương Nội, Hà Đông hoặc /diadiem Cầu Giấy, Hà Nội`,
        );
        return;
      }
      try {
        const { location } = await manager.setWeatherLocation(argText);
        await sendZaloReply(`✅ Đã đổi địa điểm dự báo thời tiết sang: 📍 ${location.name}`);
        const { text: weatherText } = await manager.fetchWeatherReport();
        await sendZaloReply(weatherText);
      } catch (error) {
        await sendZaloReply(`⚠️ ${humanError(error)}`);
      }
      return;
    }

    if (cmd === 'thoitiet' || cmd === 'weather' || cmd === 'tt') {
      try {
        if (argText && typeof manager.setWeatherLocation === 'function') {
          await manager.setWeatherLocation(argText);
        }
        const { text: weatherText } = await manager.fetchWeatherReport();
        await sendZaloReply(weatherText);
      } catch (error) {
        await sendZaloReply(`⚠️ Không lấy được dự báo thời tiết:\n${humanError(error)}`);
      }
      return;
    }

    const currentConfig = await manager.getEvnConfig();
    if (!currentConfig.zaloConversationId) {
      await manager.updateEvnConfig({
        zaloAccountId: this.config.accountId,
        zaloConversationId: String(zaloMessage.conversationId),
        zaloConversationTitle: title,
        zaloThreadType: threadType,
      });
    }

    try {
      const { text: reportText } = await manager.fetchEvnReport();
      await sendZaloReply(reportText);
    } catch (error) {
      await sendZaloReply(`⚠️ Không lấy được dữ liệu EVN:\n${humanError(error)}`);
    }

    if (currentConfig.weatherEnabled !== false && typeof manager.fetchWeatherReport === 'function') {
      try {
        const { text: weatherText } = await manager.fetchWeatherReport();
        if (weatherText) await sendZaloReply(weatherText);
      } catch {
        // Ignore weather failure when requesting /dien
      }
    }
  }

  async downloadTelegramFile(ctx, fileId, uniqueId, fallbackExtension, fileSize) {
    const sizeError = () => new Error('Tệp vượt giới hạn tải 20 MB của Telegram Bot API nên chưa gửi được sang Zalo. Hãy gửi tệp nhỏ hơn hoặc chia nhỏ tệp.');
    if (fileSize > MAX_TELEGRAM_DOWNLOAD_BYTES) throw sizeError();
    const fileLink = await ctx.telegram.getFileLink(fileId);
    // getFile links need not preserve the original name or extension.
    const extension = /^[a-z0-9]{1,16}$/i.test(fallbackExtension || '') ? fallbackExtension : 'bin';
    const targetPath = uniqueDownloadPath(this.config.downloadDir, `telegram-${uniqueId}`, extension);
    await ensureDir(this.config.downloadDir);

    const response = await fetch(fileLink, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
    }

    if (Number(response.headers.get('content-length')) > MAX_TELEGRAM_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw sizeError();
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_TELEGRAM_DOWNLOAD_BYTES) throw sizeError();
    try {
      await fs.writeFile(targetPath, data);
    } catch (error) {
      await this.cleanupTelegramFile(targetPath);
      throw error;
    }
    return targetPath;
  }

  async cleanupTelegramFile(filePath) {
    if (!filePath) return;
    try {
      await fs.rm(filePath, { force: true });
    } catch (error) {
      this.logger.warn({ error, filePath }, 'Could not delete temporary Telegram file.');
    }
  }
}
