import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { createLogger } from './logger.js';
import { BridgeController } from './bridgeController.js';
import { Store } from './store.js';
import { completeChat } from './ai.js';
import { fetchEvnUsage, formatEvnReport } from './evn.js';
import { observeZaloLogin } from './loginNotifications.js';
import {
  createAccountDraft,
  loadAccountsFile,
  normalizeAccount,
  createSeedAccountFromEnv,
  saveAccountsFile,
} from './accounts.js';

export class BridgeManager extends EventEmitter {
  constructor({ baseDir = process.cwd(), consoleOutput = false } = {}) {
    super();
    this.baseDir = baseDir;
    this.consoleOutput = consoleOutput;
    this.state = {
      accounts: [],
      selectedAccountId: null,
      selectedConversationId: null,
      logs: [],
    };
    this.controllers = new Map();
    this.accountsFilePath = null;
    this.mongoUri = process.env.MONGODB_URI?.trim() || '';
    this.mongoDbName = process.env.MONGODB_DB_NAME?.trim() || 'zalo-to-tele';
    this.mongoCollectionName = process.env.MONGODB_COLLECTION_NAME?.trim() || 'bridge_state';
    this.mongoClient = null;
    this.accountsCollection = null;
    this.controlStore = null;
    this.rootLogger = createLogger({
      scope: 'app',
      consoleOutput,
      onLog: (entry) => this.pushLog(entry),
    });
  }

  publicAccount(account, controller = null) {
    const safeAccount = {
      id: account.id,
      label: account.label,
      telegramForumChatId: account.telegramForumChatId,
      enabled: account.enabled,
      autoStart: account.autoStart,
      zaloLoginMode: account.zaloLoginMode,
      zaloSelfListen: account.zaloSelfListen,
    };
    return {
      ...safeAccount,
      hasTelegramBotToken: Boolean(account.telegramBotToken),
      status: controller?.status || safeAccount.status || 'stopped',
      startedAt: controller?.startedAt || safeAccount.startedAt || null,
      lastError: controller?.lastError || safeAccount.lastError || null,
      conversationCount: controller?.getConversationList().length || safeAccount.conversationCount || 0,
      qrImageBase64: controller?.qrImageBase64 || null,
      listenerConnected: Boolean(controller?.listenerConnected),
      lastAiError: controller?.lastAiError || null,
      lastTelegramError: controller?.lastTelegramError || null,
      lastAiReplyAt: controller?.lastAiReplyAt || null,
      accountName:
        controller?.zalo?.selfProfile?.displayName ||
        controller?.zalo?.selfProfile?.zaloName ||
        safeAccount.label,
    };
  }

  async load() {
    const file = await loadAccountsFile(this.baseDir);
    this.accountsFilePath = file.filePath;
    const registry = await this.loadAccountsRegistry();
    const savedAccounts = registry?.accounts;
    const localAccounts = !savedAccounts && !this.mongoUri && file.filePath === 'ACCOUNTS_JSON'
      ? (await loadAccountsFile(this.baseDir, { ignoreEnv: true })).accounts
      : [];
    this.accounts = (savedAccounts || file.accounts).map((account) => {
      const configured = file.accounts.find((item) => item.id === account.id);
      const merged = configured ? { ...account, ...configured } : account;
      const renamed = account.labelOverride ? account : localAccounts.find((item) => item.id === account.id && item.labelOverride);
      return normalizeAccount({
        ...merged,
        ...(renamed ? { label: renamed.label, labelOverride: true } : {}),
        ...(account.telegramForumChatIdOverride ? {
          telegramForumChatId: account.telegramForumChatId,
          telegramForumChatIdOverride: true,
        } : {}),
        // Deployment-level access control must override stale Mongo registry values.
        ...(process.env.ALLOWED_TELEGRAM_USER_IDS !== undefined
          ? { allowedTelegramUserIds: process.env.ALLOWED_TELEGRAM_USER_IDS }
          : {}),
      }, this.baseDir);
    });
    if (!registry && this.accounts.length === 0) {
      const seeded = createSeedAccountFromEnv(this.baseDir);
      if (seeded) {
        this.accounts = [seeded];
      }
    }
    await this.persist();

    this.controlStore = new Store(path.join(this.baseDir, 'data', 'telegram-control.json'), {
      mongoUri: this.mongoUri,
      mongoDbName: this.mongoDbName,
      mongoCollectionName: this.mongoCollectionName,
      accountId: '__telegram_control__',
    });
    await this.controlStore.load();

    this.state.selectedAccountId = this.accounts[0]?.id || null;
    this.emitState();
    return this.getState();
  }

  async persist() {
    if (this.mongoUri) {
      const collection = await this.ensureAccountsCollection();
      await collection.replaceOne(
        { _id: '__accounts_registry__' },
        {
          _id: '__accounts_registry__',
          version: 1,
          accounts: this.accounts.map((account) => ({
            id: account.id,
            label: account.label,
            labelOverride: account.labelOverride,
            telegramForumChatId: account.telegramForumChatId,
            telegramForumChatIdOverride: account.telegramForumChatIdOverride,
            allowedTelegramUserIds: account.allowedTelegramUserIds,
            mongoDbName: account.mongoDbName,
            mongoCollectionName: account.mongoCollectionName,
            ocrQueueCollectionName: account.ocrQueueCollectionName,
            transcriptFullRetentionDays: account.transcriptFullRetentionDays,
            transcriptRetentionDays: account.transcriptRetentionDays,
            zaloLoginMode: account.zaloLoginMode,
            zaloSelfListen: account.zaloSelfListen,
            zaloCredentialsFile: account.zaloCredentialsFile,
            dataFile: account.dataFile,
            downloadDir: account.downloadDir,
            localIngestUrl: account.localIngestUrl,
            localIngestZaloTitle: account.localIngestZaloTitle,
            autoStart: account.autoStart,
            enabled: account.enabled,
          })),
          updatedAt: new Date().toISOString(),
        },
        { upsert: true },
      );
      return;
    }
    await saveAccountsFile(this.baseDir, this.accounts);
  }

  async ensureAccountsCollection() {
    if (this.accountsCollection) return this.accountsCollection;
    if (!this.mongoClient) this.mongoClient = new MongoClient(this.mongoUri);
    await this.mongoClient.connect();
    this.accountsCollection = this.mongoClient.db(this.mongoDbName).collection(this.mongoCollectionName);
    return this.accountsCollection;
  }

  async loadAccountsRegistry() {
    if (!this.mongoUri) return null;
    const collection = await this.ensureAccountsCollection();
    return collection.findOne({ _id: '__accounts_registry__' });
  }

  pushLog(entry) {
    const next = {
      id: crypto.randomUUID(),
      ...entry,
    };
    this.state.logs = [...this.state.logs, next].slice(-300);
    this.emit('log', next);
    this.emitState();
  }

  async listAccounts() {
    return this.accounts.map((account) => {
      const controller = this.controllers.get(account.id);
      return this.publicAccount(account, controller);
    });
  }

  async addAccount(input) {
    const usedIds = new Set(this.accounts.map((item) => item.id));
    let nextNumber = 1;
    while (usedIds.has(`zalo-${nextNumber}`)) nextNumber += 1;
    const account = createAccountDraft(
      { ...input, id: input.id || `zalo-${nextNumber}`, label: input.label || `Zalo ${nextNumber}` },
      this.baseDir,
    );
    if (usedIds.has(account.id)) throw new Error(`Account ID already exists: ${account.id}`);
    this.accounts = [...this.accounts, account];
    await this.persist();
    this.state.selectedAccountId = account.id;
    this.emitState();
    return account;
  }

  async updateAccount(id, patch) {
    const index = this.accounts.findIndex((item) => item.id === id);
    if (index === -1) throw new Error('Account not found');
    const existing = this.accounts[index];
    const next = normalizeAccount({ ...existing, ...patch, id }, this.baseDir);
    this.accounts[index] = next;
    await this.persist();
    this.emitState();
    return next;
  }

  async renameAccount(id, value) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Không tìm thấy tài khoản Zalo.');
    const label = String(value ?? '').trim();
    if (!label || [...label].length > 80 || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(label)) {
      throw new Error('Tên phải có từ 1 đến 80 ký tự trên một dòng.');
    }
    const previous = { label: account.label, labelOverride: account.labelOverride };
    account.label = label;
    account.labelOverride = true;
    try {
      await this.persist();
    } catch (error) {
      if (account.label === label) Object.assign(account, previous);
      throw error;
    }
    const controller = this.getController(id);
    if (controller) {
      controller.account.label = account.label;
      controller.account.labelOverride = true;
      if (controller.telegram) controller.telegram.config.accountLabel = account.label;
    }
    this.emitState();
    return account;
  }

  async removeAccount(id) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Account not found');
    const controller = this.controllers.get(id);
    if (controller) {
      await controller.stop();
      this.controllers.delete(id);
    }
    this.accounts = this.accounts.filter((item) => item.id !== id);
    if (this.state.selectedAccountId === id) {
      this.state.selectedAccountId = this.accounts[0]?.id || null;
      this.state.selectedConversationId = null;
    }
    const accountStore = new Store(account.dataFile, {
      mongoUri: account.mongoUri,
      mongoDbName: account.mongoDbName,
      mongoCollectionName: account.mongoCollectionName,
      ocrQueueCollectionName: account.ocrQueueCollectionName,
      accountId: id,
    });
    try {
      await accountStore.load();
      await accountStore.deleteState();
    } finally {
      await accountStore.close();
    }
    await fs.rm(account.zaloCredentialsFile, { force: true });
    await this.persist();
    this.emitState();
  }

  getAccount(id) {
    return this.accounts.find((item) => item.id === id) || null;
  }

  getController(id) {
    return this.controllers.get(id) || null;
  }

  async startAccount(id, { onController } = {}) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Account not found');
    if (this.controllers.has(id)) {
      const controller = this.controllers.get(id);
      onController?.(controller);
      return controller.snapshot();
    }

    const controller = new BridgeController(account, {
      baseDir: this.baseDir,
      logger: createLogger({
        scope: account.label,
        consoleOutput: this.consoleOutput,
        onLog: (entry) => this.pushLog({ ...entry, accountId: account.id }),
      }),
      onLog: (entry) => this.pushLog({ ...entry, accountId: account.id }),
      onState: () => this.emitState(),
    });

    controller.on('transcript', (event) => {
      this.state.selectedAccountId = event.accountId;
      this.state.selectedConversationId = event.conversationId;
      this.emit('transcript', event);
      this.emitState();
    });
    controller.on('aiError', (event) => this.emit('aiError', event));
    controller.on('telegramError', (event) => this.emit('telegramError', event));

    controller.on('change', () => {
      const displayName =
        controller.zalo?.selfProfile?.displayName ||
        controller.zalo?.selfProfile?.zaloName ||
        '';
      const current = this.getAccount(id);
      if (displayName && current && !current.labelOverride && /^Zalo \d+$/i.test(current.label) && current.label !== displayName) {
        current.label = String(displayName).slice(0, 80);
        this.persist().catch((error) => this.pushLog({
          timestamp: new Date().toISOString(),
          level: 'warn',
          scope: account.label,
          message: 'Could not persist Zalo account display name',
          data: null,
          error: { name: error?.name || 'Error', message: error?.message || String(error) },
          accountId: account.id,
        }));
      }
      this.emitState();
    });
    this.controllers.set(id, controller);
    onController?.(controller);
    controller.start().catch((error) => {
      this.pushLog({
        timestamp: new Date().toISOString(),
        level: 'error',
        scope: account.label,
        message: 'Failed to start account',
        data: null,
        error: {
          name: error?.name || 'Error',
          message: error?.message || String(error),
          stack: error?.stack || null,
        },
        accountId: account.id,
      });
    });
    this.state.selectedAccountId = id;
    const firstConversation = controller.getConversationList()[0];
    this.state.selectedConversationId ||= firstConversation?.conversationId || null;
    this.emitState();
    return controller.snapshot();
  }

  async stopAccount(id) {
    const controller = this.controllers.get(id);
    if (!controller) return;
    await controller.stop();
    this.controllers.delete(id);
    this.emitState();
  }

  async reloginAccount(id, options = {}) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Account not found');
    await this.stopAccount(id);

    const accountStore = new Store(account.dataFile, {
      mongoUri: account.mongoUri,
      mongoDbName: account.mongoDbName,
      mongoCollectionName: account.mongoCollectionName,
      ocrQueueCollectionName: account.ocrQueueCollectionName,
      accountId: account.id,
    });
    try {
      await accountStore.load();
      await accountStore.setCredentials(null);
    } finally {
      await accountStore.close();
    }
    await fs.rm(account.zaloCredentialsFile, { force: true });
    await this.updateAccount(id, { zaloLoginMode: 'qr' });
    return this.startAccount(id, options);
  }

  getAiController(accountId = null) {
    if (accountId) return this.controllers.get(accountId) || null;
    return [...this.controllers.values()].find((controller) => controller.status === 'running') ||
      this.controllers.values().next().value || null;
  }

  getAiAccount() {
    return this.accounts.find((item) => item.enabled) || this.accounts[0] || null;
  }

  async withAiStore(action, accountId = null) {
    const controller = this.getAiController(accountId);
    if (controller) {
      await controller.ready;
      return action(controller.store);
    }
    const account = accountId ? this.getAccount(accountId) : this.getAiAccount();
    if (!account) throw new Error('Chưa có cấu hình tài khoản Zalo.');
    const store = new Store(account.dataFile, {
      mongoUri: account.mongoUri,
      mongoDbName: account.mongoDbName,
      mongoCollectionName: account.mongoCollectionName,
      ocrQueueCollectionName: account.ocrQueueCollectionName,
      accountId: account.id,
    });
    try {
      await store.load();
      return await action(store);
    } finally {
      await store.close();
    }
  }

  async withControlStore(action) {
    if (!this.controlStore) {
      this.controlStore = new Store(path.join(this.baseDir, 'data', 'telegram-control.json'), {
        mongoUri: this.mongoUri,
        mongoDbName: this.mongoDbName,
        mongoCollectionName: this.mongoCollectionName,
        accountId: '__telegram_control__',
      });
      await this.controlStore.load();
    }
    return action(this.controlStore);
  }

  async chatWithAi(userId, prompt, imageUrls = []) {
    if (!this.isAiAdmin(userId) && !(await this.withControlStore((store) => store.getAllowedTelegramAiUsers().includes(Number(userId))))) {
      throw new Error(`Telegram ID ${userId} chưa được cấp quyền chat AI. Nhờ quản trị viên chạy /allowai ${userId}.`);
    }
    return this.withControlStore(async (store) => {
      const answer = await completeChat({
        baseUrl: process.env.AI_BASE_URL || process.env.ROUTER_BASE_URL,
        apiKey: process.env.AI_API_KEY || process.env.ROUTER_API_KEY,
        model: process.env.AI_MODEL || process.env.DEFAULT_MODEL,
        systemPrompt: process.env.AI_SYSTEM_PROMPT || 'Bạn là trợ lý hữu ích. Trả lời bằng ngôn ngữ người dùng sử dụng.',
        history: store.getTelegramAiHistory(userId),
        text: prompt,
        imageUrls,
      });
      await store.appendTelegramAiTurn(userId, prompt, answer);
      return answer;
    });
  }

  async testAi(accountId) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error('Không tìm thấy tài khoản Zalo.');
    const mode = await this.getZaloAiMode(accountId);
    const controller = this.getController(accountId);
    const answer = await completeChat({
      baseUrl: process.env.AI_BASE_URL || process.env.ROUTER_BASE_URL,
      apiKey: process.env.AI_API_KEY || process.env.ROUTER_API_KEY,
      model: process.env.AI_MODEL || process.env.DEFAULT_MODEL,
      text: 'Đây là kiểm tra kết nối. Chỉ trả lời OK.',
    });
    return { mode, answer, connected: controller?.status === 'running' && controller?.listenerConnected };
  }

  isAiAdmin(userId) {
    const admins = String(process.env.TELEGRAM_ADMIN_IDS || '')
      .split(',').map((item) => item.trim()).filter(Boolean).map(Number);
    return admins.includes(Number(userId));
  }

  async isAiUserAllowed(userId) {
    return this.isAiAdmin(userId) ||
      this.withControlStore((store) => store.getAllowedTelegramAiUsers().includes(Number(userId)));
  }

  async listAiUsers() {
    return this.withControlStore((store) => store.getAllowedTelegramAiUsers());
  }

  async setAiUserAllowed(userId, allowed) {
    return this.withControlStore((store) => store.setTelegramAiUserAllowed(userId, allowed));
  }

  async setZaloAiMode(mode, accountId = null) {
    if (!['off', 'command', 'dm', 'all'].includes(mode)) throw new Error('Chế độ AI không hợp lệ.');
    return this.withAiStore((store) => store.setZaloAiMode(mode), accountId);
  }

  async setTelegramForum(accountId, chatId) {
    const numericId = Number(chatId);
    if (!Number.isSafeInteger(numericId) || numericId >= 0) throw new Error('ID nhóm Telegram phải là số âm, thường bắt đầu -100.');
    const account = this.getAccount(accountId);
    if (!account) throw new Error('Không tìm thấy tài khoản Zalo.');
    const wasStarted = Boolean(this.getController(accountId));
    const previousId = account.telegramForumChatId;
    if (Number(previousId) === numericId) return account;
    await this.stopAccount(accountId);
    await this.withAiStore((store) => store.switchTelegramForum(previousId, numericId), accountId);
    const updated = await this.updateAccount(accountId, { telegramForumChatId: numericId, telegramForumChatIdOverride: true });
    if (wasStarted) await this.startAccount(accountId);
    return updated;
  }

  async listAccountConversations(accountId) {
    return this.withAiStore((store) => store.listMappings(), accountId);
  }

  async bindTelegramTopic(accountId, conversationId, topicId) {
    const account = this.getAccount(accountId);
    const numericTopicId = Number(topicId);
    if (!account) throw new Error('Không tìm thấy tài khoản Zalo.');
    if (!Number.isSafeInteger(numericTopicId) || numericTopicId <= 0) throw new Error('Topic ID phải là số nguyên dương.');
    for (const other of this.accounts) {
      if (other.id === accountId || other.telegramBotToken !== account.telegramBotToken ||
          Number(other.telegramForumChatId) !== Number(account.telegramForumChatId)) continue;
      const existing = await this.withAiStore((store) => store.getByTopic(numericTopicId), other.id);
      if (existing) throw new Error(`Topic này đã thuộc tài khoản ${other.id}. Chọn topic riêng để gửi trả đúng Zalo.`);
    }
    return this.withAiStore(async (store) => {
      const mapping = store.getByConversation(conversationId);
      if (!mapping) throw new Error('Chưa thấy cuộc trò chuyện này. Gửi một tin từ Zalo để bridge nhận trước.');
      return store.upsertMapping({ ...mapping, topicId: numericTopicId });
    }, accountId);
  }

  async getZaloAiMode(accountId = null) {
    return this.withAiStore((store) => store.getZaloAiMode(), accountId);
  }

  async clearAiHistory(userId) {
    return this.withControlStore((store) => store.clearTelegramAiHistory(userId));
  }

  async getEvnConfig() {
    const saved = await this.withControlStore((store) => store.getEvnConfig());
    const envReportHour = process.env.EVN_REPORT_HOUR !== undefined ? Number(process.env.EVN_REPORT_HOUR) : undefined;
    const envBillingStart = process.env.EVN_BILLING_START_DAY !== undefined ? Number(process.env.EVN_BILLING_START_DAY) : undefined;
    return {
      enabled: saved.enabled !== undefined
        ? Boolean(saved.enabled)
        : process.env.EVN_ENABLED !== 'false',
      username: saved.username || process.env.EVN_USERNAME?.trim() || '',
      password: saved.password || process.env.EVN_PASSWORD || '',
      customerId: (saved.customerId || process.env.EVN_CUSTOMER_ID?.trim() || '').toUpperCase(),
      billingStartDay: Number.isFinite(Number(saved.billingStartDay))
        ? Number(saved.billingStartDay)
        : (Number.isFinite(envBillingStart) ? envBillingStart : 1),
      reportHour: Number.isFinite(Number(saved.reportHour))
        ? Number(saved.reportHour)
        : (Number.isFinite(envReportHour) ? envReportHour : 6),
      zaloAccountId: saved.zaloAccountId ?? process.env.EVN_ZALO_ACCOUNT_ID?.trim() ?? null,
      zaloConversationId: saved.zaloConversationId ?? process.env.EVN_ZALO_CONVERSATION_ID?.trim() ?? null,
      zaloConversationTitle: saved.zaloConversationTitle || null,
      telegramEvnTopicId: saved.telegramEvnTopicId ? Number(saved.telegramEvnTopicId) : null,
      telegramForumChatId: saved.telegramForumChatId ? Number(saved.telegramForumChatId) : null,
      lastReportDate: saved.lastReportDate || null,
      lastReportedReadingDate: saved.lastReportedReadingDate || null,
      updatedAt: saved.updatedAt || null,
    };
  }

  async updateEvnConfig(patch) {
    await this.withControlStore((store) => store.setEvnConfig(patch));
    return this.getEvnConfig();
  }

  async fetchEvnReport({ now = new Date() } = {}) {
    const config = await this.getEvnConfig();
    const fetcher = this.evnFetcher || fetchEvnUsage;
    const report = await fetcher({
      username: config.username,
      password: config.password,
      customerId: config.customerId,
      billingStartDay: config.billingStartDay,
      now,
    });
    return {
      config,
      report,
      text: formatEvnReport(report),
    };
  }

  async requestZaloQr(onQr, accountId = null, onStatus = null) {
    const account = accountId
      ? this.getAccount(accountId)
      : this.accounts.find((item) => item.enabled) || this.accounts[0];
    if (!account) throw new Error('Chưa có tài khoản Zalo.');
    await this.reloginAccount(account.id, {
      onController: (controller) => {
        observeZaloLogin(controller, { onQr, onStatus });
      },
    });
  }

  async addZaloAccount(label, onQr, onStatus = null) {
    const account = await this.addAccount({ label: String(label || '').trim() || undefined });
    await this.startAccount(account.id, {
      onController: (controller) => {
        observeZaloLogin(controller, { onQr, onStatus });
      },
    });
    return account;
  }

  async startManagedAccount(id, onQr, onStatus) {
    await this.updateAccount(id, { autoStart: true, enabled: true });
    return this.startAccount(id, {
      onController: (controller) => observeZaloLogin(controller, { onQr, onStatus }),
    });
  }

  async stopManagedAccount(id) {
    await this.updateAccount(id, { autoStart: false });
    return this.stopAccount(id);
  }

  async startAll() {
    await Promise.all(
      this.accounts
        .filter((item) => item.enabled && item.autoStart)
        .map((account) => this.startAccount(account.id)),
    );
  }

  async stopAll() {
    for (const id of [...this.controllers.keys()]) {
      await this.stopAccount(id);
    }
    if (this.mongoClient) {
      await this.mongoClient.close();
      this.mongoClient = null;
      this.accountsCollection = null;
    }
    await this.controlStore?.close();
    this.controlStore = null;
  }

  async selectAccount(id) {
    this.state.selectedAccountId = id;
    const controller = this.controllers.get(id);
    const firstConversation = controller?.getConversationList()?.[0];
    this.state.selectedConversationId = firstConversation?.conversationId || null;
    this.emitState();
  }

  async selectConversation(id) {
    this.state.selectedConversationId = String(id);
    this.emitState();
  }

  async sendMessage(accountId, conversationId, text) {
    const controller = this.controllers.get(accountId);
    if (!controller) throw new Error('Account is not running');
    return controller.sendText(conversationId, text);
  }

  async sendImage(accountId, conversationId, filePath, caption) {
    const controller = this.controllers.get(accountId);
    if (!controller) throw new Error('Account is not running');
    return controller.sendImage(conversationId, filePath, caption);
  }

  getState() {
    const selectedAccountId = this.state.selectedAccountId || this.accounts[0]?.id || null;
    const selectedAccount = selectedAccountId ? this.getAccount(selectedAccountId) : null;
    const controller = selectedAccountId ? this.controllers.get(selectedAccountId) : null;
    const conversations = controller ? controller.getConversationList() : [];
    const selectedConversationId =
      this.state.selectedConversationId || conversations[0]?.conversationId || null;
    const selectedConversation = selectedConversationId
      ? conversations.find((item) => item.conversationId === selectedConversationId) || null
      : null;
    const messages = controller && selectedConversationId
      ? controller.getConversationMessages(selectedConversationId)
      : [];

    return {
      accounts: this.accounts.map((account) => this.publicAccount(account, this.controllers.get(account.id))),
      selectedAccountId,
      selectedConversationId,
      selectedAccount: selectedAccount ? this.publicAccount(selectedAccount, controller) : null,
      selectedConversation,
      conversations,
      messages,
      logs: this.state.logs,
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }
}
