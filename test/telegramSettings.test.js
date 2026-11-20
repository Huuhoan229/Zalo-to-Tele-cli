import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from 'telegraf';
import { TelegramBridgeBot } from '../src/telegramBot.js';
import { BridgeManager } from '../src/bridgeManager.js';
import { Store } from '../src/store.js';

test('one Telegram runtime routes identical topic IDs by both group and account', async () => {
  const delivered = [];
  const logger = { error: (error) => { throw error; } };
  const createBridge = (chatId) => new TelegramBridgeBot({
    config: { telegramBotToken: '222:shared-test', telegramForumChatId: chatId, allowedTelegramUserIds: new Set([111]), telegramAdminIds: new Set([111]) },
    store: { getByTopic: () => ({ conversationId: String(chatId), threadType: 0 }) },
    zalo: { sendText: async (message) => delivered.push(message.conversationId) }, logger,
  });
  const first = createBridge(-1001);
  const second = createBridge(-1002);
  assert.equal(first.runtime, second.runtime);
  first.runtime.addBridge(first);
  first.runtime.addBridge(second);
  try {
    for (const id of [-1001, -1002]) {
      await first.runtime.routeTelegramMessage({ chat: { id }, from: { id: 111 }, update: {}, message: { message_thread_id: 17, text: 'hello' } }, 'text');
    }
    assert.deepEqual(delivered, ['-1001', '-1002']);
  } finally {
    first.runtime.removeBridge(first);
    first.runtime.removeBridge(second);
  }
});

test('changing Telegram groups preserves sessions, AI mode, and previous topic mappings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'telegram-destinations-'));
  const manager = new BridgeManager({ baseDir: dir });
  manager.mongoUri = '';
  const account = { id: 'zalo1', label: 'HJ', telegramBotToken: 'test', telegramForumChatId: -1001, dataFile: path.join(dir, 'bridge.json') };
  manager.accounts = [account];
  try {
    await manager.withAiStore(async (store) => {
      await store.setCredentials({ cookie: 'test-cookie' });
      await store.setZaloAiMode('dm');
      await store.upsertMapping({ conversationId: 'friend', topicId: 17, threadType: 0 });
    }, 'zalo1');
    await manager.setTelegramForum('zalo1', -1002);
    assert.equal(manager.getAccount('zalo1').telegramForumChatId, -1002);
    assert.equal(manager.getAccount('zalo1').telegramForumChatIdOverride, true);
    assert.deepEqual(await manager.listAccountConversations('zalo1'), []);
    assert.equal(await manager.getZaloAiMode('zalo1'), 'dm');
    await manager.setTelegramForum('zalo1', -1001);
    assert.equal((await manager.listAccountConversations('zalo1'))[0].topicId, 17);
    assert.deepEqual(await manager.withAiStore((store) => store.getCredentials(), 'zalo1'), { cookie: 'test-cookie' });
  } finally {
    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual topic binding rejects an occupied topic and removes the previous mapping', async () => {
  const store = new Store('unused');
  store.save = async () => {};
  await store.upsertMapping({ conversationId: 'friend-a', topicId: 17, threadType: 0 });
  await store.upsertMapping({ conversationId: 'friend-b', topicId: 18, threadType: 0 });
  await assert.rejects(store.upsertMapping({ conversationId: 'friend-b', topicId: 17, threadType: 0 }), /đã được gán/);
  await store.upsertMapping({ conversationId: 'friend-a', topicId: 20, threadType: 0 });
  assert.equal(store.getByTopic(17), null);
  assert.equal(store.getByTopic(20).conversationId, 'friend-a');
});

test('admin can configure a forum through commands, while AI-only users are denied', async () => {
  const sent = [];
  const saved = [];
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: '333:settings-test', telegramForumChatId: -1001, allowedTelegramUserIds: new Set([111]), telegramAdminIds: new Set([111]) },
    store: {}, zalo: {}, logger: { error: (error) => { throw error; } },
  });
  const runtime = bridge.runtime;
  runtime.manager = {
    isAiUserAllowed: async () => true,
    setTelegramForum: async (accountId, chatId) => saved.push({ accountId, chatId }),
  };
  runtime.addBridge(bridge);
  runtime.bot.telegram.getChat = async () => ({ is_forum: true });
  runtime.bot.telegram.getMe = async () => ({ id: 333, username: 'testbot' });
  runtime.bot.telegram.getChatMember = async () => ({ status: 'administrator', can_manage_topics: true });
  async function dispatch(userId) {
    const text = '/setforum zalo1 -1002';
    const ctx = new Context({ update_id: userId, message: {
      text, message_id: 1, date: 1, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, first_name: 'Test' },
      entities: [{ type: 'bot_command', offset: 0, length: '/setforum'.length }],
    } }, { sendMessage: async (_id, text) => sent.push(text) }, { username: 'testbot', id: 333 });
    await runtime.bot.middleware()(ctx, async () => {});
  }
  try {
    await dispatch(222);
    assert.equal(saved.length, 0);
    assert.match(sent.at(-1), /Chưa được cấp quyền/);
    await dispatch(111);
    assert.deepEqual(saved, [{ accountId: 'zalo1', chatId: -1002 }]);
    runtime.bot.telegram.getChatMember = async () => ({ status: 'member' });
    await dispatch(111);
    assert.equal(saved.length, 1);
    assert.match(sent.at(-1), /Manage Topics/);
  } finally {
    runtime.removeBridge(bridge);
  }
});

test('saved forum overrides survive an environment seed on the next load', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'forum-override-'));
  const manager = new BridgeManager({ baseDir: dir });
  manager.mongoUri = '';
  const previous = process.env.ACCOUNTS_JSON;
  process.env.ACCOUNTS_JSON = JSON.stringify([{ id: 'zalo1', label: 'HJ', telegramBotToken: 'test', telegramForumChatId: -1001 }]);
  manager.loadAccountsRegistry = async () => ({ accounts: [{ id: 'zalo1', label: 'HJ', telegramForumChatId: -1002, telegramForumChatIdOverride: true }] });
  manager.persist = async () => {};
  try {
    await manager.load();
    assert.equal(manager.getAccount('zalo1').telegramForumChatId, -1002);
  } finally {
    if (previous === undefined) delete process.env.ACCOUNTS_JSON; else process.env.ACCOUNTS_JSON = previous;
    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});
