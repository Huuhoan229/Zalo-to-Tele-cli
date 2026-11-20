import crypto from 'node:crypto';
import { Input, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'node:fs/promises';
import { ensureDir, uniqueDownloadPath } from './media.js';

const runtimes = new Map();

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
  const response = await fetch(link);
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
  return String(error?.response?.description || error?.message || error || 'Unknown error').slice(0, 500);
}

function runtimeKey(config) {
  return `${config.telegramBotToken}:${config.telegramForumChatId}`;
}

class SharedTelegramRuntime {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.bot = new Telegraf(config.telegramBotToken);
    this.bridges = new Set();
    this.handlersRegistered = false;
    this.started = false;
    this.startingPromise = null;
    this.processedUpdates = new Map();
    this.inFlightUpdates = new Set();
    this.manager = null;
    this.controlStarted = false;
    // Webhook mode: đọc TELEGRAM_WEBHOOK_URL từ env (setting toàn deployment).
    // Nếu không set → fallback về long polling (chạy local).
    const webhookBaseUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim().replace(/\/$/, '') || '';
    this.webhookBaseUrl = webhookBaseUrl;
    this.webhookPath = webhookBaseUrl ? webhookPathForToken(config.telegramBotToken) : null;
  }

  get isWebhookMode() {
    return Boolean(this.webhookBaseUrl && this.webhookPath);
  }

  _recreateBot() {
    // Tạo mới Telegraf instance để tránh state cũ gây lỗi sau khi stop.
    this.bot = new Telegraf(this.config.telegramBotToken);
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
    if (this.bridges.size === 0 && this.started && !this.controlStarted) {
      if (this.isWebhookMode) {
        // Xoá webhook handler khỏi registry và notify Telegram xoá webhook.
        webhookHandlers.delete(this.webhookPath);
        this.bot.telegram.deleteWebhook().catch(() => {});
      } else {
        this.bot.stop(reason);
      }
      this.started = false;
      this.handlersRegistered = false;
      this._recreateBot();
    }
  }

  async start() {
    if (this.started) return;
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = (async () => {
      if (!this.handlersRegistered) this._recreateBot();
      this.registerHandlers();

      if (this.isWebhookMode) {
        const fullUrl = `${this.webhookBaseUrl}${this.webhookPath}`;
        await this.bot.telegram.setWebhook(fullUrl);
        webhookHandlers.set(this.webhookPath, this.bot.webhookCallback(this.webhookPath));
        this.started = true;
        this.bot.telegram.setMyCommands([
          { command: 'start', description: 'Mở menu quản lý bot' },
          { command: 'menu', description: 'Hiện menu chức năng' },
          { command: 'ask', description: 'Hỏi AI: /ask câu hỏi' },
          { command: 'clear', description: 'Xóa lịch sử chat AI của bạn' },
          { command: 'zaloqr', description: 'Kết nối tài khoản Zalo bằng QR' },
          { command: 'addzalo', description: 'Thêm tài khoản Zalo mới' },
          { command: 'zaloaccounts', description: 'Quản lý tài khoản Zalo' },
          { command: 'zalostart', description: 'Khởi động tài khoản Zalo' },
          { command: 'zalostop', description: 'Dừng tài khoản Zalo' },
          { command: 'zalostatus', description: 'Xem trạng thái Zalo và AI' },
          { command: 'zaloai', description: 'Chế độ AI Zalo: off/command/dm/all' },
          { command: 'allowai', description: 'Cấp quyền chat AI cho Telegram ID' },
          { command: 'denyai', description: 'Thu hồi quyền chat AI của Telegram ID' },
          { command: 'aiusers', description: 'Liệt kê ID được phép chat AI' },
          { command: 'topics', description: 'Liệt kê topic Zalo đã liên kết' },
          { command: 'id', description: 'Xem Telegram ID' },
        ]).catch((error) => this.logger.warn({ error }, 'Could not register Telegram command menu.'));
        this.logger.info({ url: fullUrl }, 'Telegram webhook registered.');
        return;
      }

      try {
        await this.bot.telegram.callApi('getUpdates', { timeout: 0, offset: -1 });
        this.logger.info('Kicked stale getUpdates session before launch.');
      } catch (err) {
        this.logger.warn({ code: err?.response?.error_code }, 'Pre-launch getUpdates kick (may 409, that is OK).');
      }

      // Telegraf's polling launch promise can stay pending for the bot lifetime.
      // Mark the runtime started before launching and observe failures separately.
      this.started = true;
      this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Mở menu quản lý bot' },
        { command: 'menu', description: 'Hiện menu chức năng' },
        { command: 'ask', description: 'Hỏi AI: /ask câu hỏi' },
        { command: 'clear', description: 'Xóa lịch sử chat AI của bạn' },
        { command: 'zaloqr', description: 'Kết nối tài khoản Zalo bằng QR' },
        { command: 'addzalo', description: 'Thêm tài khoản Zalo mới' },
        { command: 'zaloaccounts', description: 'Quản lý tài khoản Zalo' },
        { command: 'zalostart', description: 'Khởi động tài khoản Zalo' },
        { command: 'zalostop', description: 'Dừng tài khoản Zalo' },
        { command: 'zalostatus', description: 'Xem trạng thái Zalo và AI' },
        { command: 'zaloai', description: 'Chế độ AI Zalo: off/command/dm/all' },
        { command: 'allowai', description: 'Cấp quyền chat AI cho Telegram ID' },
        { command: 'denyai', description: 'Thu hồi quyền chat AI của Telegram ID' },
        { command: 'aiusers', description: 'Liệt kê ID được phép chat AI' },
        { command: 'topics', description: 'Liệt kê topic Zalo đã liên kết' },
        { command: 'id', description: 'Xem Telegram ID' },
      ]).catch((error) => this.logger.warn({ error }, 'Could not register Telegram command menu.'));
      this.bot.launch().catch((err) => {
        this.started = false;
        this.logger.error({ err }, 'Telegram polling stopped with error.');
      });
      this.logger.info('Telegram bot started (long polling).');
    })().finally(() => {
      this.startingPromise = null;
    });

    return this.startingPromise;
  }

  findBridgeByTopic(topicId) {
    for (const bridge of this.bridges) {
      const mapping = bridge.store.getByTopic(topicId);
      if (mapping) return { bridge, mapping };
    }
    return null;
  }

  registerHandlers() {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

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
          await this.manager.requestZaloQr((image) => sendQr(ctx.chat.id, image), accountId);
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
              return `• ${account.label} [${account.id}]: ${account.status}${account.listenerConnected ? ' (đang nghe tin)' : ''} · AI ${mode}`;
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
          const account = await this.manager.addZaloAccount(label, (image) => sendQr(ctx.chat.id, image));
          await ctx.reply(`Đã tạo tài khoản ${account.label} (${account.id}). Quét QR vừa được gửi để đăng nhập.`);
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
      try {
        await ctx.sendChatAction('typing');
        const answer = await this.manager.chatWithAi(ctx.from.id, prompt);
        for (const part of splitTelegramText(answer)) await ctx.reply(part, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      } catch (error) {
        await ctx.reply(`Không gọi được AI: ${humanError(error)}`, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      }
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
      try { await this.manager.startManagedAccount(id); await showStatus(ctx); }
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
        [Markup.button.callback('🔄 Quét lại QR', `zalo:qr:${id}`)],
        [Markup.button.callback('▶️ Bật', `zalo:start:${id}`), Markup.button.callback('⏸ Tắt', `zalo:stop:${id}`)],
        [Markup.button.callback('🤖 Bật/tắt AI', `zalo:ai:${id}`)],
      ];
      await ctx.reply(`${account.label} (${id})`, Markup.inlineKeyboard(rows));
    });
    this.bot.action(/^zalo:qr:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
      await ctx.answerCbQuery();
      try {
        await ctx.reply('Đang yêu cầu QR đăng nhập lại.');
        await this.manager.requestZaloQr((image) => sendQr(ctx.chat.id, image), ctx.match[1]);
      } catch (error) { await ctx.reply(`Không tạo được QR: ${humanError(error)}`); }
    });
    for (const operation of ['start', 'stop']) {
      this.bot.action(new RegExp(`^zalo:${operation}:(.+)$`), async (ctx) => {
        if (!isAdmin(ctx) || ctx.chat?.type !== 'private') return ctx.answerCbQuery('Chỉ admin được dùng trong chat riêng với bot.');
        await ctx.answerCbQuery();
        try {
          if (operation === 'start') await this.manager.startManagedAccount(ctx.match[1]);
          else await this.manager.stopManagedAccount(ctx.match[1]);
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
        const next = current === 'off' ? 'dm' : 'off';
        await this.manager.setZaloAiMode(next, id);
        await ctx.reply(`AI Zalo cho ${id}: ${next}`);
      } catch (error) { await ctx.reply(`Không đổi được chế độ AI: ${humanError(error)}`); }
    });
    this.bot.command('zaloai', async (ctx) => {
      if (!isAdmin(ctx)) return deny(ctx);
      if (ctx.chat?.type !== 'private') return ctx.reply('Dùng lệnh này trong chat riêng với bot.');
      const [, modeArg, accountId] = ctx.message.text.split(/\s+/);
      const mode = modeArg?.toLowerCase();
      if (!mode) return showStatus(ctx);
      if (!['off', 'command', 'dm', 'all'].includes(mode)) {
        return ctx.reply('Dùng /zaloai off|command|dm|all [account_id]');
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
      if (text.startsWith('/')) return next();
      if (!(await isAiUser(ctx))) return deny(ctx);
      if (text === '🔗 Kết nối Zalo') return startQr(ctx);
      if (text === '➕ Thêm tài khoản Zalo') return addZaloAccount(ctx);
      if (text === '📋 Tài khoản Zalo') return showAccounts(ctx);
      if (text === '📊 Trạng thái') return showStatus(ctx);
      if (text === '🤖 Bật/tắt AI Zalo') {
        return showAccounts(ctx);
      }
      if (text === '🔐 Quyền chat AI') return showAiUsers(ctx);
      if (text === '🧹 Xóa lịch sử AI') {
        try {
          await this.manager?.clearAiHistory(ctx.from.id);
          return showMenu(ctx, 'Đã xóa lịch sử chat AI của bạn.');
        } catch (error) {
          return ctx.reply(`Không xóa được lịch sử: ${humanError(error)}`);
        }
      }
      if (text === '💬 Chat với AI') return showMenu(ctx, 'Gửi câu hỏi tiếp theo trong chat này để trò chuyện với AI.');
      try {
        if (!this.manager) return showMenu(ctx, 'Bot quản lý chưa sẵn sàng.');
        await ctx.sendChatAction('typing');
        const answer = await this.manager.chatWithAi(ctx.from.id, text);
        for (const part of splitTelegramText(answer)) await ctx.reply(part, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      } catch (error) {
        await ctx.reply(`Không gọi được AI: ${humanError(error)}`, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
      }
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
      if (ctx.message.text.startsWith('/')) return;
      await this.routeTelegramMessage(ctx, 'text');
    });

    this.bot.on(message('photo'), async (ctx) => {
      if (ctx.chat?.type === 'private') {
        if (!(await isAiUser(ctx))) return deny(ctx);
        try {
          await ctx.sendChatAction('typing');
          const imageUrl = await telegramPhotoDataUrl(ctx);
          const answer = await this.manager.chatWithAi(
            ctx.from.id,
            ctx.message.caption || 'Hãy phân tích hình ảnh này.',
            [imageUrl],
          );
          for (const part of splitTelegramText(answer)) await ctx.reply(part, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
        } catch (error) {
          await ctx.reply(`Không phân tích được ảnh: ${humanError(error)}`, isAdmin(ctx) ? MANAGEMENT_MENU : AI_USER_MENU);
        }
        return;
      }
      await this.routeTelegramMessage(ctx, 'photo');
    });

    this.bot.on(message('document'), async (ctx) => {
      await this.routeTelegramMessage(ctx, 'document');
    });

    this.bot.catch((error, ctx) => {
      this.logger.error({ error, updateType: ctx.updateType }, 'Telegram handler failed');
    });
  }

  async routeTelegramMessage(ctx, type) {
    const updateId = ctx.update?.update_id;
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) {
      if (type !== 'text') {
        await ctx.reply('Ảnh này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      }
      return;
    }

    const routed = this.findBridgeByTopic(ctx.message.message_thread_id);
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
  await runtime.start();
  return runtime;
}

export function stopTelegramControlBot(runtime, reason = 'shutdown') {
  if (!runtime) return;
  runtime.controlStarted = false;
  if (runtime.bridges.size > 0) return;
  if (runtime.isWebhookMode) {
    webhookHandlers.delete(runtime.webhookPath);
    runtime.bot.telegram.deleteWebhook().catch(() => {});
  } else if (runtime.started) {
    runtime.bot.stop(reason);
  }
  runtime.started = false;
  runtime.handlersRegistered = false;
  runtime._recreateBot();
}

export class TelegramBridgeBot {
  constructor({ config, store, zalo, logger, pendingEcho, onTranscript }) {
    this.config = config;
    this.store = store;
    this.zalo = zalo;
    this.logger = logger;
    this.pendingEcho = pendingEcho || null;
    this.onTranscript = onTranscript;
    this.forwardingZaloMessages = new Set();
    this.runtime = getRuntime(config, logger);
    this.bot = this.runtime.bot;
  }

  async start() {
    await ensureDir(this.config.downloadDir);
    this.runtime.addBridge(this);
    await this.runtime.start();
  }

  stop(reason) {
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
    const topic = await this.bot.telegram.createForumTopic(
      this.config.telegramForumChatId,
      topicName(zaloMessage.title, this.config.accountLabel),
    );

    return this.store.upsertMapping({
      ...previous,
      conversationId: zaloMessage.conversationId,
      threadType: zaloMessage.threadType,
      topicId: topic.message_thread_id,
      title: zaloMessage.title,
    });
  }

  async refreshTopicTitle(existing, zaloMessage) {
    const nextTitle = zaloMessage.title || existing.title;
    if (!nextTitle || nextTitle === existing.title) return existing;

    try {
      await this.bot.telegram.editForumTopic(this.config.telegramForumChatId, existing.topicId, {
        name: topicName(nextTitle, this.config.accountLabel),
      });
    } catch (error) {
      this.logger.warn({ error, topicId: existing.topicId }, 'Could not rename Telegram topic.');
      return existing;
    }

    return this.store.upsertMapping({
      ...existing,
      title: nextTitle,
    });
  }

  async forwardZaloMessage(zaloMessage) {
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
    } finally {
      if (key) this.forwardingZaloMessages.delete(key);
    }
  }

  async sendZaloMessageToTelegram(mapping, zaloMessage) {
    const options = { message_thread_id: mapping.topicId };

    if (zaloMessage.attachment?.url) {
      try {
        return await this.bot.telegram.sendPhoto(
          this.config.telegramForumChatId,
          Input.fromURL(zaloMessage.attachment.url),
          {
            ...options,
            caption: formatZaloMessage(zaloMessage).slice(0, 1024),
          },
        );
      } catch (error) {
        if (isTelegramThreadNotFound(error)) throw error;
        this.logger.warn({ error }, 'Telegram could not fetch Zalo attachment URL; falling back to text.');
        return await this.bot.telegram.sendMessage(
          this.config.telegramForumChatId,
          `${formatZaloMessage(zaloMessage)}\n${zaloMessage.attachment.url}`,
          options,
        );
      }
      return;
    }

    return this.bot.telegram.sendMessage(
      this.config.telegramForumChatId,
      formatZaloMessage(zaloMessage),
      options,
    );
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
      await ctx.reply('Ảnh này chưa nằm trong topic Zalo nào nên không biết gửi về đâu.');
      return;
    }
    if (!isAllowed(this.config, ctx.from.id)) {
      await ctx.reply(
        'Bạn chưa được cấp quyền gửi sang Zalo. Telegram user ID của bạn là ' + ctx.from?.id + '. Thêm ID này vào ALLOWED_TELEGRAM_USER_IDS trong biến môi trường của service bridge (Koyeb/Render) rồi redeploy.',
      );
      return;
    }
    if (!ctx.message.document.mime_type?.startsWith('image/')) return;

    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }
    const quote = ctx.message.reply_to_message
      ? this.store.getReplyData(ctx.message.reply_to_message.message_id)
      : null;

    const extension = ctx.message.document.file_name?.split('.').pop() || 'jpg';
    const targetPath = await this.downloadTelegramFile(
      ctx,
      ctx.message.document.file_id,
      ctx.message.document.file_unique_id,
      extension,
    );
    this.logger.info(
      { topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId, filePath: targetPath },
      'Downloaded Telegram image document for Zalo forwarding.',
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
        'Forwarded Telegram image document to Zalo.',
      );
    } catch (error) {
      this.pendingEcho?.consume?.(mapping.conversationId);
      this.logger.error(
        { error, topicId: ctx.message.message_thread_id, conversationId: mapping.conversationId },
        'Could not forward Telegram image document to Zalo.',
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
        title: ctx.message.document.file_name || 'image',
      },
      threadType: mapping.threadType,
    });
  }

  async downloadTelegramFile(ctx, fileId, uniqueId, fallbackExtension) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const extension = fileLink.pathname.split('.').pop() || fallbackExtension;
    const targetPath = uniqueDownloadPath(this.config.downloadDir, `telegram-${uniqueId}`, extension);
    await ensureDir(this.config.downloadDir);

    const response = await fetch(fileLink);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
    }

    await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
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
