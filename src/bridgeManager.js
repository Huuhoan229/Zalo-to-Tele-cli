import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createLogger } from './logger.js';
import { BridgeController } from './bridgeController.js';
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
    this.rootLogger = createLogger({
      scope: 'app',
      consoleOutput,
      onLog: (entry) => this.pushLog(entry),
    });
  }

  publicAccount(account, controller = null) {
    const { telegramBotToken, ...safeAccount } = account;
    return {
      ...safeAccount,
      hasTelegramBotToken: Boolean(telegramBotToken),
      status: controller?.status || safeAccount.status || 'stopped',
      startedAt: controller?.startedAt || safeAccount.startedAt || null,
      lastError: controller?.lastError || safeAccount.lastError || null,
      conversationCount: controller?.getConversationList().length || safeAccount.conversationCount || 0,
    };
  }

  async load() {
    const file = await loadAccountsFile(this.baseDir);
    this.accountsFilePath = file.filePath;
    this.accounts = file.accounts.map((account) => normalizeAccount(account, this.baseDir));
    if (this.accounts.length === 0) {
      const seeded = createSeedAccountFromEnv(this.baseDir);
      if (seeded) {
        this.accounts = [seeded];
      }
    }
    if (this.accounts.length > 0) {
      await this.persist();
    } else {
      await this.persist();
    }

    this.state.selectedAccountId = this.accounts[0]?.id || null;
    this.emitState();
    return this.getState();
  }

  async persist() {
    await saveAccountsFile(this.baseDir, this.accounts);
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
    const account = createAccountDraft(input, this.baseDir);
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

    controller.on('change', () => this.emitState());
    this.controllers.set(id, controller);
    const snapshot = await controller.start();
    this.state.selectedAccountId = id;
    const firstConversation = snapshot.conversations[0];
    this.state.selectedConversationId ||= firstConversation?.conversationId || null;
    this.emitState();
    return snapshot;
  }

  async stopAccount(id) {
    const controller = this.controllers.get(id);
    if (!controller) return;
    await controller.stop();
    this.controllers.delete(id);
    this.emitState();
  }

  async startAll() {
    for (const account of this.accounts.filter((item) => item.enabled && item.autoStart)) {
      try {
        await this.startAccount(account.id);
      } catch (error) {
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
      }
    }
  }

  async stopAll() {
    for (const id of [...this.controllers.keys()]) {
      await this.stopAccount(id);
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
