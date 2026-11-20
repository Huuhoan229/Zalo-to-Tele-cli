import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from 'telegraf';
import { TelegramBridgeBot } from '../src/telegramBot.js';
import { TelegramGroupQueue } from '../src/telegramGroupQueue.js';
import { boundTelegramApi, normalizedMenuText } from '../src/telegramTransport.js';

function fixture(token = '444:transport-test') {
  const warnings = [];
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: token, telegramForumChatId: -1001, telegramAdminIds: new Set([111]), allowedTelegramUserIds: new Set([111]) },
    store: {}, zalo: {},
    logger: { info: () => {}, warn: (event) => warnings.push(event), error: () => {} },
  });
  bridge.runtime.addBridge(bridge);
  return { bridge, runtime: bridge.runtime, warnings };
}

test('Telegram network calls have a deadline and respect shutdown cancellation', async () => {
  const client = boundTelegramApi({
    callApi: async (_method, _payload, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('aborted'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }),
  }, { requestTimeoutMs: 5 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client.callApi('getMe', {}), /aborted/);
    const shutdown = new AbortController();
    const pending = client.callApi('getUpdates', { timeout: 50 }, shutdown);
    shutdown.abort();
    await assert.rejects(pending, /aborted/);
  } finally { clearTimeout(keepAlive); }
});

test('polling retries after failure, preserves pending updates, and stops retrying at shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { bridge, runtime } = fixture('445:retry-test');
  let launches = 0;
  let resolveLaunch;
  runtime.bot.telegram.setMyCommands = async () => {};
  runtime.bot.launch = (options, ready) => {
    assert.equal(options.dropPendingUpdates, false);
    launches += 1;
    ready();
    if (launches === 1) return Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    return new Promise((resolve) => { resolveLaunch = resolve; });
  };
  runtime.bot.stop = () => resolveLaunch?.();
  try {
    await runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.snapshot().status, 'reconnecting');
    assert.ok(runtime.retryTimer);
    t.mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launches, 2);
    assert.equal(runtime.snapshot().status, 'running');
    runtime.stopTransport();
    await runtime.pollingTask;
    t.mock.timers.tick(120000);
    assert.equal(launches, 2);
    assert.equal(runtime.retryTimer, null);
  } finally {
    runtime.removeBridge(bridge);
    t.mock.timers.reset();
  }
});

test('invalid Telegram token is surfaced without an endless retry loop', async () => {
  const { bridge, runtime } = fixture('446:invalid-test');
  runtime.bot.telegram.setMyCommands = async () => {};
  runtime.bot.launch = () => Promise.reject({ response: { error_code: 401, description: 'Unauthorized' } });
  try {
    await runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.snapshot().status, 'invalid-token');
    assert.equal(runtime.retryTimer, null);
    assert.match(runtime.snapshot().lastError, /Unauthorized/);
  } finally { runtime.removeBridge(bridge); }
});

test('ping, AI user listing, and old menu buttons respond while an AI job is pending', async () => {
  const { bridge, runtime } = fixture('447:responsive-test');
  let completeAi;
  const sent = [];
  runtime.manager = {
    isAiUserAllowed: async () => true,
    chatWithAi: async () => new Promise((resolve) => { completeAi = resolve; }),
    listAiUsers: async () => [222],
    listAccounts: async () => [{ id: 'zalo1', label: 'HJ', status: 'running' }],
  };
  let updateId = 0;
  async function dispatch(text) {
    const command = text.match(/^\/\w+/)?.[0];
    const ctx = new Context({ update_id: ++updateId, message: {
      message_id: updateId, date: 1, text, chat: { id: 111, type: 'private' },
      from: { id: 111, is_bot: false, first_name: 'Test' },
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
    } }, { sendMessage: async (_id, text) => sent.push(text), sendChatAction: async () => {} }, { id: 447, username: 'testbot' });
    await runtime.bot.middleware()(ctx, async () => {});
  }
  try {
    await dispatch('/ask slow AI request');
    assert.equal(runtime.aiJobs.size, 1);
    await dispatch('/ping');
    assert.match(sent.at(-1), /Bot đang nhận lệnh/);
    await dispatch('/aiusers');
    assert.match(sent.at(-1), /222/);
    await dispatch('📄️ Tài khoản Zalo');
    assert.match(sent.at(-1), /Chọn tài khoản Zalo/);
    const pending = [...runtime.aiJobs.values()];
    completeAi('AI finished');
    await Promise.all(pending);
    assert.equal(runtime.aiJobs.size, 0);
  } finally {
    runtime.removeBridge(bridge);
  }
});

test('chat not found reports the destination once and backs off topic creation', async () => {
  const errors = [];
  let calls = 0;
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: '448:bad-group-test', telegramForumChatId: -1004340385141 },
    store: { listMessages: () => [], getByConversation: () => null }, zalo: {}, logger: {},
    onBridgeError: (event) => errors.push(event),
  });
  bridge.bot.telegram.createForumTopic = async () => {
    calls += 1;
    throw { response: { error_code: 400, description: 'Bad Request: chat not found' } };
  };
  const message = { id: 'm1', conversationId: 'friend', text: 'hello' };
  await assert.rejects(bridge.forwardZaloMessage(message));
  await bridge.forwardZaloMessage({ ...message, id: 'm2' });
  assert.equal(calls, 1);
  assert.equal(errors[0].chatId, -1004340385141);
  assert.match(errors[0].error, /chat not found/);
});

test('a Telegram 429 delays topic creation, and concurrent Zalo messages reuse the created topic', async () => {
  const { bridge, runtime } = fixture('449:group-queue-test');
  let clock = 100000;
  let mapping;
  const events = [];
  runtime.groupQueue = new TelegramGroupQueue({
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  bridge.store = {
    listMessages: () => [],
    getByConversation: () => mapping,
    upsertMapping: async (next) => { mapping = next; return next; },
  };
  const attempts = [];
  bridge.bot.telegram.createForumTopic = async (chatId) => {
    attempts.push(clock);
    assert.equal(chatId, -1001);
    if (attempts.length === 1) {
      throw { response: { error_code: 429, parameters: { retry_after: 3 } } };
    }
    return { message_thread_id: 27 };
  };
  bridge.bot.telegram.sendMessage = async (chatId, text, { message_thread_id: topicId }) => {
    events.push({ chatId, topicId, text, at: clock });
  };
  try {
    const message = { conversationId: 'friend', title: 'Friend', text: 'First' };
    await Promise.all([
      bridge.forwardZaloMessage({ ...message, id: 'm1' }),
      bridge.forwardZaloMessage({ ...message, id: 'm2', text: 'Second' }),
    ]);
    assert.deepEqual(attempts, [100000, 103250]);
    assert.deepEqual(events.map(({ chatId, topicId }) => [chatId, topicId]), [[-1001, 27], [-1001, 27]]);
    assert.match(events[0].text, /First/);
    assert.match(events[1].text, /Second/);
    assert.ok(events[1].at - events[0].at >= 1000);
  } finally {
    runtime.removeBridge(bridge);
  }
});

test('menu labels ignore emoji and variation selectors', () => {
  assert.equal(normalizedMenuText('📋 Tài khoản Zalo'), 'Tài khoản Zalo');
  assert.equal(normalizedMenuText('📄️ Tài khoản Zalo'), 'Tài khoản Zalo');
});
