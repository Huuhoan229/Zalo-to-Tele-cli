import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { ZaloClient } from './zaloClient.js';
import { TelegramBridgeBot } from './telegramBot.js';
import { createLogger } from './logger.js';
import { completeChat } from './ai.js';

function cleanMessageText(text) {
  return String(text || '').trim();
}

function normalizeFilterText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}

export class BridgeController extends EventEmitter {
  constructor(account, options = {}) {
    super();
    this.account = account;
    this.baseDir = options.baseDir || process.cwd();
    this.onLog = options.onLog;
    this.onState = options.onState;
    this.logger = options.logger || createLogger({ scope: account.label, onLog: this.onLog });
    this.store = new Store(account.dataFile, {
      mongoUri: account.mongoUri,
      mongoDbName: account.mongoDbName,
      mongoCollectionName: account.mongoCollectionName,
      ocrQueueCollectionName: account.ocrQueueCollectionName,
      accountId: account.id,
      transcriptFullRetentionDays: account.transcriptFullRetentionDays,
      transcriptRetentionDays: account.transcriptRetentionDays,
    });
    this.zalo = null;
    this.telegram = null;
    this.status = 'idle';
    this.lastError = null;
    this.lastAiError = null;
    this.lastTelegramError = null;
    this.lastAiReplyAt = null;
    this.startedAt = null;
    this.pendingEchoes = new Map();
    this.manualStop = false;
    this.restartTimer = null;
    this.suppressZaloClosed = false;
    this.healthTimer = null;
    this.lastActivityAt = Date.now();
    this.qrPath = null;
    this.qrImageBase64 = null;
    this.listenerConnected = false;
    this.restartAttempts = 0;
    this.ready = this.store.load();
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting') return this.snapshot();
    this.manualStop = false;
    this.clearRestartTimer();
    this.startHealthTimer();
    this.status = 'starting';
    this.listenerConnected = false;
    this.lastError = null;
    this.emitChange();

    await this.ready;
    if (this.manualStop) {
      this.status = 'stopped';
      this.emitChange();
      return this.snapshot();
    }

    try {
      this.zalo = new ZaloClient({
        credentialsFile: this.account.zaloCredentialsFile,
        sessionStore: this.store,
        loginMode: this.account.zaloLoginMode,
        selfListen: this.account.zaloSelfListen !== false,
        logger: this.logger.child({ scope: `${this.account.label}/zalo` }),
      });

      this.zalo.on('qr', ({ qrPath, qrImageBase64 }) => {
        this.qrPath = qrPath;
        this.qrImageBase64 = qrImageBase64 || null;
        this.emit('qr', { qrPath, qrImageBase64: this.qrImageBase64 });
        this.emitChange();
      });
      this.zalo.on('qrScanned', ({ account }) => {
        this.emit('qrScanned', { account });
        this.emitChange();
      });
      this.zalo.on('qrExpired', () => {
        this.qrPath = null;
        this.qrImageBase64 = null;
        this.emit('qrExpired');
        this.emitChange();
      });
      this.zalo.on('qrDeclined', () => {
        this.qrPath = null;
        this.qrImageBase64 = null;
        this.emit('qrDeclined');
        this.emitChange();
      });
      this.zalo.on('credentialsSaved', ({ credentialsFile }) => {
        this.qrPath = null;
        this.qrImageBase64 = null;
        this.emit('credentialsSaved', { credentialsFile });
        this.emitChange();
      });

      await this.zalo.connect();
      if (this.manualStop) {
        this.zalo.stop();
        this.status = 'stopped';
        this.emitChange();
        return this.snapshot();
      }

      this.telegram = new TelegramBridgeBot({
        config: {
          telegramBotToken: this.account.telegramBotToken,
          telegramForumChatId: this.account.telegramForumChatId,
          accountId: this.account.id,
          accountLabel: this.account.label,
          allowedTelegramUserIds: new Set(
            String(this.account.allowedTelegramUserIds || '')
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
              .map((item) => Number(item))
              .filter((item) => Number.isSafeInteger(item)),
          ),
          telegramAdminIds: new Set(
            String(process.env.TELEGRAM_ADMIN_IDS || '')
              .split(',')
              .map((item) => Number(item.trim()))
              .filter((item) => Number.isSafeInteger(item)),
          ),
          downloadDir: this.account.downloadDir,
        },
        store: this.store,
        zalo: this.zalo,
        logger: this.logger.child({ scope: `${this.account.label}/telegram` }),
        pendingEcho: {
          register: (conversationId) => this.registerPendingEcho(conversationId),
          consume: (conversationId) => this.consumePendingEcho(conversationId),
        },
        onTranscript: async (mapping, entry) => this.recordTranscript(mapping, entry),
        onBridgeError: (event) => {
          this.lastTelegramError = event.error;
          this.emit('telegramError', { ...event, accountId: this.account.id });
          this.emitChange();
        },
      });

      this.zalo.on('connected', () => {
        this.listenerConnected = true;
        this.lastActivityAt = Date.now();
        this.emitChange();
      });

      this.zalo.on('closed', ({ code, reason }) => {
        this.listenerConnected = false;
        if (this.manualStop || this.suppressZaloClosed) return;
        this.scheduleRestart(`Zalo listener closed (${code || 'unknown'} ${reason || ''})`.trim());
      });

      this.zalo.on('disconnected', ({ code, reason }) => {
        this.listenerConnected = false;
        if (this.manualStop) return;
        this.scheduleRestart(`Zalo listener disconnected (${code || 'unknown'} ${reason || ''})`.trim());
      });

      this.zalo.on('listenerError', (error) => {
        this.listenerConnected = false;
        if (this.manualStop) return;
        this.lastError = error?.message || String(error);
        this.emitChange();
        this.scheduleRestart(`Zalo listener error: ${this.lastError}`);
      });

      this.zalo.on('heartbeatError', (error) => {
        if (this.manualStop) return;
        this.lastError = error?.message || String(error);
        this.scheduleRestart(`Zalo heartbeat failed: ${this.lastError}`);
      });

      this.zalo.onMessage(async (message) => {
        const explicitAiRequest = /^\/(?:ask|ai)(?:@\w+)?(?:\s|$)/i.test(String(message.text || '').trim());
        if (message.isSelf && this.consumePendingEcho(message.conversationId, message.text, explicitAiRequest)) {
          return;
        }

        await this.queueForOcr(message);
        // AI delivery must not depend on Telegram topic creation or permissions.
        const results = await Promise.allSettled([
          this.telegram.forwardZaloMessage(message),
          this.maybeReplyWithAi(message),
        ]);
        for (const result of results) {
          if (result.status === 'rejected') this.logger.error({ error: result.reason }, 'Could not process incoming Zalo message.');
        }
        await this.relayToLocalIngest(message);
      });

      await this.telegram.start();
      this.startedAt = new Date().toISOString();
      this.lastActivityAt = Date.now();
      this.restartAttempts = 0; // reset backoff khi start thành công
      this.status = 'running';
      this.emitChange();
      return this.snapshot();
    } catch (error) {
      if (this.manualStop) {
        this.status = 'stopped';
        this.emitChange();
        return this.snapshot();
      }
      this.status = 'error';
      this.lastError = error?.message || String(error);
      this.qrImageBase64 = null;
      this.logger.error({ error }, 'Bridge failed to start');
      this.emitChange();
      throw error;
    }
  }

  async stop() {
    this.manualStop = true;
    this.clearRestartTimer();
    this.clearHealthTimer();
    try {
      this.telegram?.stop('manual');
      this.zalo?.stop();
    } finally {
      this.status = 'stopped';
      this.listenerConnected = false;
      this.emitChange();
      await this.store.close();
    }
  }

  clearRestartTimer() {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  clearHealthTimer() {
    if (!this.healthTimer) return;
    clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  startHealthTimer() {
    this.clearHealthTimer();
    this.healthTimer = setInterval(async () => {
      if (this.manualStop || this.status !== 'running') return;
      try {
        if (this.store.pruneMessageHistory()) await this.store.save();
      } catch (error) {
        this.logger.warn({ error }, 'Could not prune expired transcript history.');
      }
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs > 30 * 60 * 1000) {
        this.scheduleRestart(`No Zalo activity for ${Math.round(idleMs / 60000)} minutes`);
      }
    }, 5 * 60 * 1000);
  }

  scheduleRestart(reason) {
    if (this.restartTimer || this.manualStop) return;
    this.status = 'reconnecting';
    this.lastError = reason;

    // Exponential backoff: 10s, 20s, 40s, 80s, tối đa 120s
    const baseDelay = 10000;
    const delay = Math.min(baseDelay * Math.pow(2, this.restartAttempts), 120000);
    this.restartAttempts = (this.restartAttempts || 0) + 1;

    this.logger.warn({ reason, delayMs: delay, attempt: this.restartAttempts }, 'Scheduling bridge reconnect.');
    this.emitChange();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restart(reason).catch((error) => {
        this.lastError = error?.message || String(error);
        this.logger.error({ error }, 'Bridge reconnect failed.');
        this.emitChange();
        this.scheduleRestart(this.lastError);
      });
    }, delay);
  }

  async restart(reason) {
    if (this.manualStop) return;
    this.logger.warn({ reason }, 'Restarting bridge.');
    this.suppressZaloClosed = true;
    try {
      this.telegram?.stop('reconnect');
      this.zalo?.stop();
    } finally {
      this.telegram = null;
      this.zalo = null;
      this.suppressZaloClosed = false;
    }

    // Chờ một chút để Telegram server giải phóng session getUpdates cũ
    // trước khi launch lại, giảm khả năng bị 409 Conflict.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    this.status = 'idle';
    await this.start();
  }

  async recordTranscript(mapping, entry) {
    this.lastActivityAt = Date.now();
    const stored = await this.store.appendMessage(mapping.conversationId, {
      id: entry.id,
      direction: entry.direction,
      source: entry.source,
      senderName: entry.senderName,
      text: cleanMessageText(entry.text),
      attachment: entry.attachment || null,
      telegramMessageId: entry.telegramMessageId ?? null,
      replyData: entry.replyData || null,
      topicId: mapping.topicId,
      threadType: mapping.threadType,
      createdAt: entry.createdAt,
    });

    this.emit('transcript', {
      accountId: this.account.id,
      conversationId: mapping.conversationId,
      message: stored,
      mapping,
    });
    this.emitChange();
    return stored;
  }

  shouldQueueForOcr(message) {
    if (!message || message.isSelf) return false;
    const titleFilter = normalizeFilterText(this.account.localIngestZaloTitle);
    if (!titleFilter) return true;
    return normalizeFilterText(message.title).includes(titleFilter);
  }

  async queueForOcr(message) {
    if (!this.shouldQueueForOcr(message)) return;

    try {
      await this.store.enqueueOcrMessage(message);
    } catch (error) {
      this.logger.warn(
        {
          error,
          conversationId: message.conversationId,
        },
        'Could not enqueue Zalo message for OCR.',
      );
    }
  }

  shouldRelayToLocalIngest(message) {
    if (!this.account.localIngestUrl || !message || message.isSelf) return false;
    const titleFilter = normalizeFilterText(this.account.localIngestZaloTitle);
    if (!titleFilter) return true;
    return normalizeFilterText(message.title).includes(titleFilter);
  }

  async relayToLocalIngest(message) {
    if (!this.shouldRelayToLocalIngest(message)) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(this.account.localIngestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.account.localIngestToken ? { 'x-relay-token': this.account.localIngestToken } : {}),
        },
        body: JSON.stringify({
          ...message,
          relayedAt: new Date().toISOString(),
          accountId: this.account.id,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Local ingest responded ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(
        {
          error,
          localIngestUrl: this.account.localIngestUrl,
          conversationId: message.conversationId,
        },
        'Could not relay Zalo message to local OCR worker.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  registerPendingEcho(conversationId, expectedText = null) {
    const key = String(conversationId);
    const saved = this.pendingEchoes.get(key);
    const texts = saved?.expiresAt >= Date.now() ? [...(saved.texts || Array(saved.count).fill(null))] : [];
    texts.push(expectedText);
    this.pendingEchoes.set(key, {
      count: texts.length,
      texts,
      expiresAt: Date.now() + 15000,
    });
  }

  consumePendingEcho(conversationId, messageText = null, exactOnly = false) {
    const key = String(conversationId);
    const current = this.pendingEchoes.get(key);
    if (!current) return false;
    if (current.expiresAt < Date.now()) {
      this.pendingEchoes.delete(key);
      return false;
    }
    const texts = current.texts || Array(current.count).fill(null);
    const index = exactOnly ? texts.findIndex((text) => text !== null && text === messageText) : 0;
    if (index < 0) return false;
    texts.splice(index, 1);
    if (texts.length === 0) {
      this.pendingEchoes.delete(key);
    } else {
      this.pendingEchoes.set(key, {
        count: texts.length,
        texts,
        expiresAt: current.expiresAt,
      });
    }
    return true;
  }

  async sendText(conversationId, text) {
    const mapping = this.store.getByConversation(conversationId);
    if (!mapping) throw new Error('Conversation not mapped');
    const messageText = cleanMessageText(text);
    this.registerPendingEcho(mapping.conversationId);
    try {
      await this.zalo.sendText({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        text: messageText,
      });
    } catch (error) {
      this.consumePendingEcho(mapping.conversationId);
      throw error;
    }
    return this.recordTranscript(mapping, {
      direction: 'out',
      source: 'gui',
      senderName: 'Tôi',
      text: messageText,
      attachment: null,
    });
  }

  async sendImage(conversationId, filePath, caption = '') {
    const mapping = this.store.getByConversation(conversationId);
    if (!mapping) throw new Error('Conversation not mapped');
    this.registerPendingEcho(mapping.conversationId);
    try {
      await this.zalo.sendImage({
        conversationId: mapping.conversationId,
        threadType: mapping.threadType,
        filePath,
        caption,
      });
    } catch (error) {
      this.consumePendingEcho(mapping.conversationId);
      throw error;
    }
    return this.recordTranscript(mapping, {
      direction: 'out',
      source: 'gui',
      senderName: 'Tôi',
      text: cleanMessageText(caption),
      attachment: { url: filePath, title: filePath.split(/[\\/]/).pop() || 'image' },
    });
  }

  getZaloAiMode() {
    return this.store.getZaloAiMode();
  }

  async setZaloAiMode(mode) {
    const supported = new Set(['off', 'command', 'dm', 'all']);
    if (!supported.has(mode)) throw new Error('Chế độ AI Zalo phải là off, command, dm hoặc all.');
    await this.store.setZaloAiMode(mode);
    this.emitChange();
    return mode;
  }

  async chatWithAi(userId, text, imageUrls = []) {
    const answer = await completeChat({
      baseUrl: process.env.AI_BASE_URL || process.env.ROUTER_BASE_URL,
      apiKey: process.env.AI_API_KEY || process.env.ROUTER_API_KEY,
      model: process.env.AI_MODEL || process.env.DEFAULT_MODEL,
      systemPrompt: process.env.AI_SYSTEM_PROMPT || 'Bạn là trợ lý hữu ích. Trả lời bằng ngôn ngữ người dùng sử dụng.',
      history: this.store.getTelegramAiHistory(userId),
      text,
      imageUrls,
    });
    await this.store.appendTelegramAiTurn(userId, text, answer);
    return answer;
  }

  async clearAiHistory(userId) {
    await this.store.clearTelegramAiHistory(userId);
  }

  async maybeReplyWithAi(message) {
    if (!message || (!message.text?.trim() && !message.attachment?.url)) return;
    const mode = this.getZaloAiMode();
    if (mode === 'off') return;
    const raw = message.raw?.data || {};
    const mentionsSelf = Array.isArray(raw.mentions) && raw.mentions.some((item) =>
      String(item.uid) === String(this.zalo?.selfUserId),
    );
    const messageText = String(message.text || '').trim();
    const commandMatch = /^\/(?:ask|ai)(?:@[\w]+)?(?:\s+|$)/i.exec(messageText);
    if (message.isSelf && !commandMatch) return;
    let prompt = messageText || 'Mô tả và trả lời về hình ảnh người dùng gửi.';
    let shouldReply = false;
    if (commandMatch) {
      prompt = prompt.slice(commandMatch[0].length).trim();
      shouldReply = Boolean(prompt);
    } else if (mode === 'all') {
      shouldReply = true;
    } else if (mode === 'dm' && (!message.isGroup || mentionsSelf)) {
      shouldReply = true;
    } else if ((mode === 'command' || mode === 'dm') && message.isGroup && mentionsSelf) {
      shouldReply = true;
    }
    if (!shouldReply) return;
    if (message.isGroup && message.senderName) prompt = `[${message.senderName}] ${prompt}`;

    try {
      const answer = await completeChat({
        baseUrl: process.env.AI_BASE_URL || process.env.ROUTER_BASE_URL,
        apiKey: process.env.AI_API_KEY || process.env.ROUTER_API_KEY,
        model: process.env.AI_MODEL || process.env.DEFAULT_MODEL,
        systemPrompt: process.env.AI_SYSTEM_PROMPT || 'Bạn là trợ lý hữu ích. Trả lời bằng ngôn ngữ người dùng sử dụng.',
        history: this.store.getZaloAiHistory(message.conversationId),
        text: prompt,
        imageUrls: message.attachment?.url ? [message.attachment.url] : [],
      });
      if (this.manualStop || this.getZaloAiMode() === 'off') return;
      for (let offset = 0; offset < answer.length; offset += 3000) {
        this.registerPendingEcho(message.conversationId, answer.slice(offset, offset + 3000));
        try {
          await this.zalo.sendText({
            conversationId: message.conversationId,
            threadType: message.threadType,
            text: answer.slice(offset, offset + 3000),
          });
        } catch (error) {
          this.consumePendingEcho(message.conversationId);
          throw error;
        }
      }
      await this.store.appendZaloAiTurn(message.conversationId, prompt, answer);
      const mapping = this.store.getByConversation(message.conversationId);
      if (mapping) {
        await this.recordTranscript(mapping, {
          direction: 'out', source: 'ai', senderName: 'AI', text: answer,
          attachment: null, threadType: message.threadType,
        });
        try {
          await this.telegram?.sendZaloMessageToTelegram(mapping, {
            ...message, text: answer, isSelf: true, senderName: 'AI',
            attachment: null, replyTo: null,
          });
        } catch (error) {
          this.logger.warn({ error }, 'AI replied to Zalo but could not mirror its answer to Telegram.');
        }
      }
      this.lastAiError = null;
      this.lastAiReplyAt = new Date().toISOString();
      this.emitChange();
    } catch (error) {
      const apiKey = process.env.AI_API_KEY || process.env.ROUTER_API_KEY;
      this.lastAiError = String(error?.message || error);
      if (apiKey) this.lastAiError = this.lastAiError.replaceAll(apiKey, '[redacted]');
      this.lastAiError = this.lastAiError.slice(0, 500);
      this.logger.error({ error, conversationId: message.conversationId }, 'Could not answer Zalo message with AI.');
      this.emit('aiError', { accountId: this.account.id, error: this.lastAiError });
      this.emitChange();
    }
  }

  getConversationList() {
    return this.store.listConversations();
  }

  getConversationMessages(conversationId) {
    return this.store.listMessages(conversationId);
  }

  snapshot() {
    return {
      ...this.account,
      status: this.status,
      startedAt: this.startedAt,
      lastError: this.lastError,
      qrPath: this.qrPath,
      qrImageBase64: this.qrImageBase64,
      listenerConnected: this.listenerConnected,
      zaloAiMode: this.getZaloAiMode(),
      lastAiError: this.lastAiError,
      lastTelegramError: this.lastTelegramError,
      lastAiReplyAt: this.lastAiReplyAt,
      conversations: this.getConversationList(),
    };
  }

  emitChange() {
    this.onState?.();
    this.emit('change', this.snapshot());
  }
}
