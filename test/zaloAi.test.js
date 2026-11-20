import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeController } from '../src/bridgeController.js';
import { Store } from '../src/store.js';
import { ZaloClient } from '../src/zaloClient.js';
import { TelegramBridgeBot } from '../src/telegramBot.js';

function setupAi(t, responder = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hello from AI' } }] }))) {
  const old = Object.fromEntries(['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'].map((key) => [key, process.env[key]]));
  process.env.AI_BASE_URL = 'https://router.invalid/v1';
  process.env.AI_API_KEY = 'private-test-key';
  process.env.AI_MODEL = 'combo';
  t.mock.method(globalThis, 'fetch', responder);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

function fixture() {
  const controller = Object.create(BridgeController.prototype);
  EventEmitter.call(controller);
  const store = new Store('unused');
  store.save = async () => {};
  store.state.ai.zaloMode = 'dm';
  const sent = [];
  Object.assign(controller, {
    account: { id: 'zalo-1', label: 'Zalo' }, store, pendingEchoes: new Map(), manualStop: false,
    logger: { error: () => {} },
    zalo: { selfUserId: 'own', sendText: async (message) => sent.push(message) },
  });
  return { controller, sent };
}

const dm = { id: 'm1', conversationId: 'friend', threadType: 0, isGroup: false, isSelf: false, text: 'hello' };

test('self-authored messages require an explicit AI command; off still disables every AI reply', async (t) => {
  setupAi(t);
  const { controller, sent } = fixture();
  await controller.maybeReplyWithAi({ ...dm, isSelf: true });
  assert.equal(globalThis.fetch.mock.calls.length, 0);
  await controller.maybeReplyWithAi({ ...dm, isSelf: true, text: '/ask hello' });
  assert.equal(sent[0].text, 'Hello from AI');
  assert.equal(controller.store.getZaloAiHistory('friend').length, 2);
  controller.store.state.ai.zaloMode = 'off';
  await controller.maybeReplyWithAi({ ...dm, isSelf: true, text: '/ai hello' });
  assert.equal(sent.length, 1);
});

test('dm mode replies to incoming DMs but only explicit requests in groups', async (t) => {
  setupAi(t);
  const { controller, sent } = fixture();
  await controller.maybeReplyWithAi(dm);
  await controller.maybeReplyWithAi({ ...dm, isGroup: true, conversationId: 'group', threadType: 1 });
  assert.equal(sent.length, 1);
  await controller.maybeReplyWithAi({ ...dm, isGroup: true, text: '/ai hello', conversationId: 'group', threadType: 1 });
  assert.equal(sent.length, 2);
});

test('AI API failure is surfaced to management with the key redacted', async (t) => {
  setupAi(t, () => new Response('bad key private-test-key', { status: 401 }));
  const { controller, sent } = fixture();
  const errors = [];
  controller.on('aiError', (error) => errors.push(error));
  await controller.maybeReplyWithAi(dm);
  assert.equal(sent.length, 0);
  assert.match(errors[0].error, /HTTP 401/);
  assert.ok(!errors[0].error.includes('private-test-key'));
  assert.equal(controller.lastAiError, errors[0].error);
});

test('turning AI off while an API request is pending cancels the reply', async (t) => {
  let resolve;
  setupAi(t, () => new Promise((done) => { resolve = done; }));
  const { controller, sent } = fixture();
  const pending = controller.maybeReplyWithAi(dm);
  controller.store.state.ai.zaloMode = 'off';
  resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'late answer' } }] })));
  await pending;
  assert.equal(sent.length, 0);
});

test('Telegram bridge failures do not prevent Zalo AI delivery, including self /ask commands', async (t) => {
  setupAi(t);
  let handle;
  const sent = [];
  t.mock.method(ZaloClient.prototype, 'connect', async function () { return this; });
  t.mock.method(ZaloClient.prototype, 'onMessage', function (handler) { handle = handler; });
  t.mock.method(ZaloClient.prototype, 'sendText', async (message) => sent.push(message));
  t.mock.method(TelegramBridgeBot.prototype, 'start', async () => {});
  t.mock.method(TelegramBridgeBot.prototype, 'forwardZaloMessage', async () => { throw new Error('No permission to create Telegram topic'); });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zalo-ai-flow-'));
  const logger = { info: () => {}, warn: () => {}, error: () => {}, child() { return this; } };
  const controller = new BridgeController({ id: 'test', label: 'test', dataFile: path.join(dir, 'state.json'), telegramBotToken: '999:test', telegramForumChatId: -1001 }, { logger });
  try {
    await controller.start();
    await controller.setZaloAiMode('dm');
    await handle(dm);
    controller.registerPendingEcho('friend');
    await handle({ ...dm, isSelf: true, text: '/ask hello' });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].conversationId, 'friend');
    controller.registerPendingEcho('friend', '/ask generated AI response');
    await handle({ ...dm, isSelf: true, text: '/ask generated AI response' });
    assert.equal(sent.length, 2, 'an AI response starting with /ask must not start a loop');
  } finally {
    await controller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
