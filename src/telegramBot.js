import { Input, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'node:fs/promises';
import { ensureDir, uniqueDownloadPath } from './media.js';

const runtimes = new Map();

function topicName(title, accountLabel = '') {
  const prefix = accountLabel ? `[${accountLabel}] ` : '';
  return `${prefix}Zalo - ${String(title || 'Unknown')}`.slice(0, 128);
}

function isAllowed(config, userId) {
  return config.allowedTelegramUserIds.size === 0 || config.allowedTelegramUserIds.has(userId);
}

function isTelegramThreadNotFound(error) {
  const description = String(error?.response?.description || error?.description || error?.message || '');
  return error?.response?.error_code === 400 && /message thread not found/i.test(description);
}

function formatZaloMessage(zaloMessage) {
  const prefix = zaloMessage.isGroup ? `[${zaloMessage.senderName}]` : `[${zaloMessage.title}]`;
  const body = zaloMessage.text || zaloMessage.attachment?.title || '(non-text message)';
  return `${prefix}\n${body}`;
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
  }

  addBridge(bridge) {
    this.bridges.add(bridge);
    this.registerHandlers();
  }

  removeBridge(bridge, reason = 'manual') {
    this.bridges.delete(bridge);
    if (this.bridges.size === 0 && this.started) {
      this.bot.stop(reason);
      this.started = false;
    }
  }

  async start() {
    if (this.started) return;
    await this.bot.launch();
    this.started = true;
    this.logger.info('Telegram bot started');
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

    if (type === 'text') {
      await routed.bridge.forwardTelegramText(ctx, routed.mapping);
      return;
    }
    if (type === 'photo') {
      await routed.bridge.forwardTelegramPhoto(ctx, routed.mapping);
      return;
    }
    await routed.bridge.forwardTelegramDocument(ctx, routed.mapping);
  }
}

function getRuntime(config, logger) {
  const key = runtimeKey(config);
  if (!runtimes.has(key)) {
    runtimes.set(key, new SharedTelegramRuntime(config, logger));
  }
  return runtimes.get(key);
}

export class TelegramBridgeBot {
  constructor({ config, store, zalo, logger, pendingEcho, onTranscript }) {
    this.config = config;
    this.store = store;
    this.zalo = zalo;
    this.logger = logger;
    this.pendingEcho = pendingEcho || null;
    this.onTranscript = onTranscript;
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
    let mapping = await this.ensureTopicForZaloMessage(zaloMessage);
    const direction = zaloMessage.isSelf ? 'out' : 'in';
    const source = zaloMessage.isSelf ? 'zalo-self' : 'zalo';
    const senderName = zaloMessage.senderName;

    try {
      await this.sendZaloMessageToTelegram(mapping, zaloMessage);
    } catch (error) {
      if (!isTelegramThreadNotFound(error)) throw error;
      this.logger.warn(
        { error, topicId: mapping.topicId, conversationId: mapping.conversationId },
        'Telegram topic is missing; recreating topic mapping.',
      );
      mapping = await this.createTopicMapping(zaloMessage, mapping);
      await this.sendZaloMessageToTelegram(mapping, zaloMessage);
    }

    await this.onTranscript?.(mapping, {
      direction,
      source,
      senderName,
      text: zaloMessage.text,
      attachment: zaloMessage.attachment,
      threadType: zaloMessage.threadType,
    });
  }

  async sendZaloMessageToTelegram(mapping, zaloMessage) {
    const options = { message_thread_id: mapping.topicId };

    if (zaloMessage.attachment?.url) {
      try {
        await this.bot.telegram.sendPhoto(
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
        await this.bot.telegram.sendMessage(
          this.config.telegramForumChatId,
          `${formatZaloMessage(zaloMessage)}\n${zaloMessage.attachment.url}`,
          options,
        );
      }
      return;
    }

    await this.bot.telegram.sendMessage(
      this.config.telegramForumChatId,
      formatZaloMessage(zaloMessage),
      options,
    );
  }

  async forwardTelegramText(ctx, mapped = null) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) return;
    if (!isAllowed(this.config, ctx.from.id)) return;

    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) return;

    this.pendingEcho?.register?.(mapping.conversationId);
    try {
      await this.zalo.sendText({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        text: ctx.message.text,
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
    if (!isAllowed(this.config, ctx.from.id)) return;

    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }

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
    if (!isAllowed(this.config, ctx.from.id)) return;
    if (!ctx.message.document.mime_type?.startsWith('image/')) return;

    const mapping = mapped || this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) {
      await ctx.reply('Topic này chưa được map với cuộc trò chuyện Zalo nào.');
      return;
    }

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
