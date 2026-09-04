import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { ZaloClient } from './zaloClient.js';
import { TelegramBridgeBot } from './telegramBot.js';
import { createLogger } from './logger.js';

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
    });
    this.zalo = null;
    this.telegram = null;
    this.status = 'idle';
    this.lastError = null;
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
    this.ready = this.store.load();
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting') return this.snapshot();
    this.manualStop = false;
    this.clearRestartTimer();
    this.startHealthTimer();
    this.status = 'starting';
    this.lastError = null;
    this.emitChange();

    await this.ready;

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
        this.emit('qr', { qrPath });
        this.emitChange();
      });
      this.zalo.on('qrScanned', ({ account }) => {
        this.emit('qrScanned', { account });
        this.emitChange();
      });
      this.zalo.on('qrExpired', () => {
        this.qrPath = null;
        this.qrImageBase64 = null;
        this.emitChange();
      });
      this.zalo.on('credentialsSaved', ({ credentialsFile }) => {
        this.qrPath = null;
        this.qrImageBase64 = null;
        this.emit('credentialsSaved', { credentialsFile });
        this.emitChange();
      });

      await this.zalo.connect();

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
        if (message.isSelf && this.consumePendingEcho(message.conversationId)) {
          return;
        }

        await this.queueForOcr(message);
        await this.telegram.forwardZaloMessage(message);
        await this.relayToLocalIngest(message);
      });

      await this.telegram.start();
      this.startedAt = new Date().toISOString();
      this.lastActivityAt = Date.now();
      this.status = 'running';
      this.emitChange();
      return this.snapshot();
    } catch (error) {
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
    this.healthTimer = setInterval(() => {
      if (this.manualStop || this.status !== 'running') return;
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
    this.logger.warn({ reason }, 'Scheduling bridge reconnect.');
    this.emitChange();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restart(reason).catch((error) => {
        this.lastError = error?.message || String(error);
        this.logger.error({ error }, 'Bridge reconnect failed.');
        this.emitChange();
        this.scheduleRestart(this.lastError);
      });
    }, 10000);
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

  registerPendingEcho(conversationId) {
    const key = String(conversationId);
    const current = this.pendingEchoes.get(key) || { count: 0, expiresAt: 0 };
    this.pendingEchoes.set(key, {
      count: current.count + 1,
      expiresAt: Date.now() + 15000,
    });
  }

  consumePendingEcho(conversationId) {
    const key = String(conversationId);
    const current = this.pendingEchoes.get(key);
    if (!current) return false;
    if (current.expiresAt < Date.now()) {
      this.pendingEchoes.delete(key);
      return false;
    }
    if (current.count <= 1) {
      this.pendingEchoes.delete(key);
    } else {
      this.pendingEchoes.set(key, {
        count: current.count - 1,
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
      conversations: this.getConversationList(),
    };
  }

  emitChange() {
    this.onState?.();
    this.emit('change', this.snapshot());
  }
}
