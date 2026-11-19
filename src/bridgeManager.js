import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { createLogger } from './logger.js';
import { BridgeController } from './bridgeController.js';
import { Store } from './store.js';
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
    this.accounts = (savedAccounts || file.accounts).map((account) => {
      const configured = file.accounts.find((item) => item.id === account.id);
      const merged = configured ? { ...account, ...configured } : account;
      return normalizeAccount({
        ...merged,
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
            telegramForumChatId: account.telegramForumChatId,
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

  async startAccount(id) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Account not found');
    if (this.controllers.has(id)) {
      return this.controllers.get(id).snapshot();
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

    controller.on('change', () => {
      const displayName =
        controller.zalo?.selfProfile?.displayName ||
        controller.zalo?.selfProfile?.zaloName ||
        '';
      if (displayName && /^Zalo \d+$/i.test(account.label) && account.label !== displayName) {
        account.label = String(displayName).slice(0, 80);
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

  async reloginAccount(id) {
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
    return this.startAccount(id);
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
