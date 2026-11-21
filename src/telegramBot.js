import crypto from 'node:crypto';
import { Input, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'node:fs/promises';
import { ensureDir, uniqueDownloadPath } from './media.js';
import { boundTelegramApi, BoundedTelegramContext, normalizedMenuText } from './telegramTransport.js';
import { TelegramGroupQueue, telegramRateLimitSeconds } from './telegramGroupQueue.js';

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
  ['🔐 Quyền chat AI'],
  ['🧹 Xóa lịch sử AI'],
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
  const body = zaloMessage.text ||
    (zaloMessage.attachment?.type === 'sticker' ? '🎭 Sticker' : zaloMessage.attachment?.title) ||
    '(non-text message)';
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
  for (const key of [process.env.AI_API_KEY, process.env.ROUTER_API_KEY, process.env.TELEGRAM_BOT_TOKEN]) {
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
    // Webhook mode: đọc TELEGRAM_WEBHOOK_URL từ env (setting toàn deployment).
    // Nếu không set → fallback về long polling (chạy local).
    const webhookInput = process.env.TELEGRAM_WEBHOOK_URL?.trim() || '';
    // Our HTTP server serves webhook paths at the origin root. A QR-page query
    // or copied /status path must never become part of the Telegram endpoint.
    const webhookBaseUrl = webhookInput ? new URL(webhookInput).origin : '';
    this.webhookBaseUrl = webhookBaseUrl;
    this.webhookPath = webhookBaseUrl ? webhookPathForToken(config.telegramBotToken) : null;
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
          await this.bot.telegram.setWebhook(expectedUrl, { drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] });
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
        const callback = this.bot.webhookCallback(this.webhookPath);
        webhookHandlers.set(this.webhookPath, (req, res) => {
          this.lastWebhookRequestAt = new Date().toISOString();
          return callback(req, res);
        });
        await this.bot.telegram.setWebhook(fullUrl, { drop_pending_updates: false, allowed_updates: ['message', 'callback_query'] });
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
          { command: 'topics', description: 'Liệt kê topic Zalo đã liên kết' },
          { command: 'id', description: 'Xem Telegram ID' },
        ]).catch((error) => this.logger.warn({ error }, 'Could not register Telegram command menu.'));
        this.logger.info({ bot: this.bot.botInfo.username, origin: this.webhookBaseUrl }, 'Telegram webhook registered.');
        await this.refreshWebhook();
        clearInterval(this.webhookTimer);
        this.webhookTimer = setInterval(() => { void this.refreshWebhook(); }, 20000);
        this.webhookTimer.unref?.();
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
        { command: 'topics', description: 'Liệt kê topic Zalo đã liên kết' },
        { command: 'id', description: 'Xem Telegram ID' },
      ]).catch((error) => this.logger.warn({ error }, 'Could not register Telegram command menu.'));
      this.pollingTask = this.bot.launch({ dropPendingUpdates: false }, () => {
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

    try {
      if (type === 'text') {
        await routed.bridge.forwardTelegramText(ctx, routed.mapping);
      } else if (type === 'photo') {
        await routed.bridge.forwardTelegramPhoto(ctx, routed.mapping);
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
    const send = (action) => this.runtime.groupQueue.run(chatId, action, this.forwardingAbort.signal);
    const options = { message_thread_id: mapping.topicId };

    if (zaloMessage.attachment?.url) {
      try {
        return await send(() => this.bot.telegram.sendPhoto(
          chatId,
          Input.fromURL(zaloMessage.attachment.url),
          {
            ...options,
            caption: formatZaloMessage(zaloMessage).slice(0, 1024),
          },
        ));
      } catch (error) {
        if (this.forwardingAbort.signal.aborted || isTelegramThreadNotFound(error) ||
            telegramRateLimitSeconds(error) !== null || isTelegramDestinationError(error)) throw error;
        this.logger.warn({ error }, 'Telegram could not fetch Zalo attachment URL; falling back to text.');
        return await send(() => this.bot.telegram.sendMessage(
          chatId,
          `${formatZaloMessage(zaloMessage)}\n${zaloMessage.attachment.url}`,
          options,
        ));
      }
      return;
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
    try {
      await this.zalo.sendText({
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
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.text,
      attachment: null,
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
    try {
      await this.zalo.sendImage({
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
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.caption || '',
      attachment: {
        title: 'image',
      },
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
    try {
      const send = isImage ? this.zalo.sendImage.bind(this.zalo) : this.zalo.sendFile.bind(this.zalo);
      await send({
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
      direction: 'out',
      source: 'telegram',
      senderName: telegramSenderName(ctx),
      text: ctx.message.caption || '',
      attachment: {
        title: filename,
        type: isImage ? 'image' : 'file',
      },
      threadType: mapping.threadType,
    });
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
