import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { TelegramBridgeBot, webhookHandlers } from '../src/telegramBot.js';
import { startWebServer } from '../src/webServer.js';

test('real HTTP webhook handles management commands and survives stale deployment cleanup', async () => {
  const calls = [];
  let registeredUrl = '';
  let deliveryError = null;
  const api = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = raw ? JSON.parse(raw) : {};
    const method = req.url.split('/').at(-1);
    calls.push({ method, payload });
    let result = true;
    if (method === 'getMe') result = { id: 999, is_bot: true, first_name: 'Test', username: 'actual_management_bot' };
    if (method === 'setWebhook') registeredUrl = payload.url;
    if (method === 'deleteWebhook') registeredUrl = '';
    if (method === 'getWebhookInfo') result = { url: registeredUrl, pending_update_count: 0, ...(deliveryError ? { last_error_message: deliveryError, last_error_date: 1 } : {}) };
    if (method === 'sendMessage') result = { message_id: 1, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: '999:integration-only', telegramForumChatId: -1001, telegramAdminIds: new Set([111]), allowedTelegramUserIds: new Set([111]) },
    logger, store: {}, zalo: {},
  });
  const runtime = bridge.runtime;
  runtime.controlStarted = true;
  runtime.manager = {
    listAiUsers: async () => [222],
    listAccounts: async () => [{ id: 'zalo1', label: 'HJ', status: 'running' }],
    isAiUserAllowed: async () => true,
  };
  runtime.addBridge(bridge);
  runtime.bot.telegram.options.apiRoot = `http://127.0.0.1:${api.address().port}`;
  runtime.bot.telegram.options.agent = undefined;
  runtime.webhookBaseUrl = 'https://bridge.example.test';
  runtime.webhookPath = '/telegram-webhook/integration-test';
  const app = startWebServer({
    port: 0, accessToken: 'web-test-only', webhookHandlers, logger,
    getStatus: () => ({ status: 'running', accounts: [], telegram: runtime.snapshot() }),
  });
  await once(app, 'listening');
  const origin = `http://127.0.0.1:${app.address().port}`;
  let id = 0;
  async function deliver(text) {
    const before = calls.length;
    const command = text.match(/^\/\w+/)?.[0];
    const response = await fetch(origin + runtime.webhookPath, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: ++id, message: {
        message_id: id, date: 1, text, from: { id: 111, is_bot: false, first_name: 'Test' }, chat: { id: 111, type: 'private' },
        ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
      } }), signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    await response.text();
    const reply = calls.slice(before).findLast((call) => call.method === 'sendMessage');
    assert.ok(reply, 'the webhook must actually send a Telegram reply, not only acknowledge HTTP');
    return reply.payload;
  }
  try {
    await runtime.start();
    assert.equal(runtime.snapshot().botUsername, 'actual_management_bot');
    assert.equal(runtime.snapshot().webhook.matchesExpectedUrl, true);
    assert.equal(runtime.snapshot().lastUpdateAt, null);
    assert.match((await deliver('/ping')).text, /Bot đang nhận lệnh/);
    assert.match((await deliver('/aiusers')).text, /222/);
    assert.match((await deliver('📄️ Tài khoản Zalo')).text, /Chọn tài khoản Zalo/);
    assert.ok(runtime.snapshot().lastUpdateAt);
    assert.ok(runtime.snapshot().lastWebhookRequestAt);
    const status = await fetch(origin + '/status?token=web-test-only').then((response) => response.json());
    assert.equal(status.telegram.botUsername, 'actual_management_bot');
    const page = await fetch(origin + '/?token=web-test-only').then((response) => response.text());
    assert.match(page, /@actual_management_bot/);
    assert.match(page, /id="telegram-state"/);

    // Reproduce the old-deployment bug: Telegram registration disappears while
    // the current process still considers its webhook "running".
    registeredUrl = '';
    await runtime.refreshWebhook();
    assert.equal(registeredUrl, runtime.webhookBaseUrl + runtime.webhookPath);
    assert.ok(runtime.snapshot().webhook.restoredAt);
    deliveryError = 'Wrong response from the webhook: 401 Unauthorized';
    await runtime.refreshWebhook();
    assert.match(runtime.snapshot().webhook.lastDeliveryError, /401 Unauthorized/);
    runtime.stopTransport('rolling-deploy');
    assert.equal(calls.filter((call) => call.method === 'deleteWebhook').length, 0);
    assert.equal(registeredUrl, runtime.webhookBaseUrl + runtime.webhookPath);
    assert.equal(webhookHandlers.has(runtime.webhookPath), false);
  } finally {
    runtime.controlStarted = false;
    runtime.removeBridge(bridge);
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  }
});
