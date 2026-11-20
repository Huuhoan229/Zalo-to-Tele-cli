import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from 'telegraf';
import { TelegramBridgeBot } from '../src/telegramBot.js';
import { BridgeManager } from '../src/bridgeManager.js';
import { Store } from '../src/store.js';
import { completeChat } from '../src/ai.js';

test('Telegram menu routes QR, permissions, and forum replies through one runtime', async () => {
  const sent = [];
  const qrRequests = [];
  const loginStatuses = [];
  const zaloSent = [];
  const modes = [];
  const mapping = { conversationId: 'zalo-chat', threadType: 1, topicId: 17 };
  const bridge = new TelegramBridgeBot({
    config: {
      telegramBotToken: '123:test-management', telegramForumChatId: -100123,
      telegramAdminIds: new Set([111]), allowedTelegramUserIds: new Set([111]),
    },
    store: { getByTopic: (id) => id === 17 ? mapping : null },
    zalo: { sendText: async (payload) => zaloSent.push(payload) },
    logger: { error: (error) => { throw error; } },
  });
  const runtime = bridge.runtime;
  runtime.manager = {
    getAccount: (id) => ({ id, label: 'Test Zalo' }),
    getZaloAiMode: async () => 'dm',
    setZaloAiMode: async (mode, id) => { modes.push([mode, id]); return mode; },
    isAiUserAllowed: async (id) => id === 222,
    requestZaloQr: async (_onQr, id, onStatus) => { qrRequests.push(id); loginStatuses.push(onStatus); },
    chatWithAi: async (_id, prompt) => `AI: ${prompt}`,
  };
  runtime.addBridge(bridge);
  const telegram = {
    sendMessage: async (_chatId, text, extra) => { sent.push({ text, extra }); },
    sendChatAction: async () => {},
  };
  let updateId = 1;
  async function dispatch(text, userId = 111, forum = false, data = null) {
    const command = text.match(/^\/\w+/)?.[0];
    const update = {
      update_id: updateId++,
      message: {
        message_id: updateId, date: 1, text,
        from: { id: userId, first_name: 'Tester', is_bot: false },
        chat: { id: forum ? -100123 : userId, type: forum ? 'supergroup' : 'private' },
        ...(forum ? { message_thread_id: 17 } : {}),
        ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
      },
    };
    if (data) {
      update.callback_query = { id: String(updateId), from: update.message.from, message: update.message, data };
      delete update.message;
    }
    const ctx = new Context(update, telegram, { id: 123, username: 'testbot', is_bot: true });
    await runtime.bot.middleware()(ctx, async () => {});
  }
  await dispatch('/id', 333);
  assert.match(sent.at(-1).text, /from_id: 333/);
  await dispatch('/menu');
  assert.ok(sent.at(-1).extra.reply_markup.keyboard.flat().some((item) => (item.text || item) === '🔗 Kết nối Zalo'));
  telegram.answerCbQuery = async () => {};
  await dispatch('/zalomode');
  assert.match(sent.at(-1).text, /\/zalomode command zalo-1/);
  await dispatch('', 111, false, 'zalo:modes:zalo-1');
  assert.equal(sent.at(-1).extra.reply_markup.inline_keyboard.flat().length, 4);
  await dispatch('', 111, false, 'zalo:mode:command:zalo-1');
  await dispatch('/zalomode all zalo-1');
  await dispatch('/zaloai off zalo1');
  assert.deepEqual(modes, [['command', 'zalo-1'], ['all', 'zalo-1'], ['off', 'zalo1']]);
  await dispatch('🔗 Kết nối Zalo');
  await dispatch('/zaloqr zalo-2');
  assert.deepEqual(qrRequests, [null, 'zalo-2']);
  const notifications = [];
  runtime.bot.telegram.sendMessage = async (chatId, text) => notifications.push({ chatId, text });
  await loginStatuses.at(-1)({ type: 'scanned', accountId: 'zalo-2', accountName: 'HJ', scannedName: 'HJ' });
  await loginStatuses.at(-1)({ type: 'success', accountId: 'zalo-2', accountName: 'HJ', mode: 'off', savedToMongo: true });
  assert.equal(notifications[0].chatId, 111);
  assert.match(notifications[0].text, /xác nhận đăng nhập/);
  assert.match(notifications[1].text, /Kết nối Zalo thành công/);
  assert.match(notifications[1].text, /AI tự trả lời: off \(đã tắt\)/);
  assert.match(notifications[1].text, /MongoDB/);
  await dispatch('🔗 Kết nối Zalo', 222);
  assert.equal(qrRequests.length, 2);
  assert.match(sent.at(-1).text, /Chưa được cấp quyền/);
  await dispatch('/menu', 222);
  assert.equal(sent.at(-1).extra.reply_markup.keyboard.flat().length, 2);
  await dispatch('hello', 222);
  assert.equal(sent.at(-1).text, 'AI: hello');
  await dispatch('hello', 333);
  assert.match(sent.at(-1).text, /Chưa được cấp quyền/);
  await dispatch('send to Zalo', 111, true);
  assert.equal(zaloSent[0].text, 'send to Zalo');
  assert.equal(zaloSent[0].conversationId, 'zalo-chat');
  await dispatch('blocked', 222, true);
  assert.equal(zaloSent.length, 1);
  runtime.removeBridge(bridge);
});

test('AI permissions and histories survive reload without requiring a connected Zalo account', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'zalo-manager-test-'));
  const manager = new BridgeManager({ baseDir });
  manager.mongoUri = '';
  try {
    await manager.withControlStore(() => {});
    await manager.setAiUserAllowed(222, true);
    assert.equal(await manager.isAiUserAllowed(222), true);
    assert.equal(await manager.isAiUserAllowed(333), false);
    await manager.controlStore.appendTelegramAiTurn(222, 'question', 'answer');
    const restored = new Store(path.join(baseDir, 'data', 'telegram-control.json'));
    await restored.load();
    assert.deepEqual(restored.getAllowedTelegramAiUsers(), [222]);
    assert.equal(restored.getTelegramAiHistory(222).length, 2);
    await manager.clearAiHistory(222);
    assert.equal(manager.controlStore.getTelegramAiHistory(222).length, 0);
    await manager.setAiUserAllowed(222, false);
    assert.equal(await manager.isAiUserAllowed(222), false);
    await assert.rejects(manager.chatWithAi(333, 'hello'), /chưa được cấp quyền/);
  } finally {
    await manager.stopAll();
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('AI request uses the configured 9Router endpoint and supports vision content', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }));
  };
  try {
    assert.equal(await completeChat({
      baseUrl: 'https://router.invalid/v1', apiKey: 'test', model: 'combo', text: 'question',
      imageUrls: ['data:image/png;base64,AA=='],
    }), 'answer');
    assert.equal(request.url, 'https://router.invalid/v1/chat/completions');
    assert.equal(request.payload.model, 'combo');
    assert.equal(request.payload.messages[0].content[1].type, 'image_url');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
