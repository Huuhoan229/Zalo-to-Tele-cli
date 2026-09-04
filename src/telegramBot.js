import { Input, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'node:fs/promises';
import { ensureDir, uniqueDownloadPath } from './media.js';

function topicName(title) {
  return `Zalo - ${String(title || 'Unknown').slice(0, 110)}`;
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

export class TelegramBridgeBot {
  constructor({ config, store, zalo, logger, pendingEcho, onTranscript }) {
    this.config = config;
    this.store = store;
    this.zalo = zalo;
    this.logger = logger;
    this.pendingEcho = pendingEcho || null;
    this.onTranscript = onTranscript;
    this.bot = new Telegraf(config.telegramBotToken);
  }

  async start() {
    await ensureDir(this.config.downloadDir);
    this.registerHandlers();
    await this.bot.launch();
    this.logger.info('Telegram bot started');
  }

  stop(reason) {
    this.bot.stop(reason);
  }

  registerHandlers() {
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
      const mappings = this.store.listMappings();
      const text =
        mappings.length === 0
          ? 'Chưa có topic nào được map.'
          : mappings
              .map((item) => `${item.topicId} -> ${item.title} (${item.conversationId})`)
              .join('\n');
      await ctx.reply(text);
    });

    this.bot.on(message('text'), async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      await this.forwardTelegramText(ctx);
    });

    this.bot.on(message('photo'), async (ctx) => {
      await this.forwardTelegramPhoto(ctx);
    });

    this.bot.on(message('document'), async (ctx) => {
      await this.forwardTelegramDocument(ctx);
    });

    this.bot.catch((error, ctx) => {
      this.logger.error({ error, updateType: ctx.updateType }, 'Telegram handler failed');
    });
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
      topicName(zaloMessage.title),
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
        name: topicName(nextTitle),
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

  async forwardTelegramText(ctx) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) return;
    if (!isAllowed(this.config, ctx.from.id)) return;

    const mapping = this.store.getByTopic(ctx.message.message_thread_id);
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

  async forwardTelegramPhoto(ctx) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) return;
    if (!isAllowed(this.config, ctx.from.id)) return;

    const mapping = this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) return;

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

  async forwardTelegramDocument(ctx) {
    if (ctx.chat?.id !== this.config.telegramForumChatId) return;
    if (!ctx.message.message_thread_id) return;
    if (!isAllowed(this.config, ctx.from.id)) return;
    if (!ctx.message.document.mime_type?.startsWith('image/')) return;

    const mapping = this.store.getByTopic(ctx.message.message_thread_id);
    if (!mapping) return;

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
