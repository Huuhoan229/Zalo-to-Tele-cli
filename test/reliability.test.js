import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { TelegramBridgeBot, downloadZaloAttachment } from '../src/telegramBot.js';
import { TelegramGroupQueue } from '../src/telegramGroupQueue.js';
import { Store } from '../src/store.js';

const noWait = async () => {};
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const telegramError = (code, description) => Object.assign(new Error(description), { response: { error_code: code, description } });
const abortError = () => Object.assign(new Error('The user aborted a request.'), { name: 'AbortError', type: 'aborted' });

test('queue retries 502 (never delivered) but not 400', async () => {
  const queue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  let calls = 0;
  const result = await queue.run(-1, async () => {
    calls += 1;
    if (calls < 3) throw telegramError(502, 'Bad Gateway');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);

  let badCalls = 0;
  await assert.rejects(queue.run(-1, async () => { badCalls += 1; throw telegramError(400, 'Bad Request: chat not found'); }));
  assert.equal(badCalls, 1);
});

test('queue never retries a timeout unless retryAmbiguous, and then only once', async () => {
  const queue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  let calls = 0;
  await assert.rejects(queue.run(-2, async () => { calls += 1; throw abortError(); }));
  assert.equal(calls, 1, 'createForumTopic-style sends must not retry ambiguous timeouts');

  calls = 0;
  await assert.rejects(queue.run(-2, async () => { calls += 1; throw abortError(); }, undefined, { retryAmbiguous: true }));
  assert.equal(calls, 2, 'exactly one retry after a timeout');

  calls = 0;
  const value = await queue.run(-2, async () => { calls += 1; if (calls === 1) throw abortError(); return 'sent'; }, undefined, { retryAmbiguous: true });
  assert.equal(value, 'sent');
});

test('queue stops retrying when shutdown aborts', async () => {
  const queue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  const shutdown = new AbortController();
  let calls = 0;
  await assert.rejects(queue.run(-3, async () => { calls += 1; shutdown.abort(); throw telegramError(502, 'Bad Gateway'); }, shutdown.signal));
  assert.equal(calls, 1);
});

test('a redelivered Telegram update is sent to Zalo only once, even after a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zalo-claims-'));
  const file = path.join(dir, 'state.json');
  const store = new Store(file, { accountId: 'claims' });
  await store.load();
  store.state.topics['5'] = { conversationId: 'c1', threadType: 0, topicId: 5, title: 'Test' };
  const sent = [];
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: '777:dedupe-test', telegramForumChatId: -1001, telegramAdminIds: new Set([111]), allowedTelegramUserIds: new Set([111]) },
    store, logger, zalo: { sendText: async (payload) => { sent.push(payload.text); } },
  });
  const runtime = bridge.runtime;
  runtime.addBridge(bridge);
  const ctx = () => ({
    update: { update_id: 4242 }, chat: { id: -1001 }, from: { id: 111, first_name: 'T' },
    message: { message_thread_id: 5, text: 'xin chao' }, reply: async () => {},
  });
  try {
    await runtime.routeTelegramMessage(ctx(), 'text');
    await runtime.routeTelegramMessage(ctx(), 'text');
    assert.deepEqual(sent, ['xin chao']);

    // Simulate a Koyeb restart: in-memory dedupe is gone, a fresh Store loads the same state.
    runtime.processedUpdates.clear();
    const restarted = new Store(file, { accountId: 'claims' });
    await restarted.load();
    restarted.state.topics['5'] = store.state.topics['5'];
    bridge.store = restarted;
    await runtime.routeTelegramMessage(ctx(), 'text');
    assert.deepEqual(sent, ['xin chao'], 'redelivery after restart must not resend to Zalo');

    // A genuinely new message (new update_id) is still delivered.
    await runtime.routeTelegramMessage({ ...ctx(), update: { update_id: 4243 } }, 'text');
    assert.deepEqual(sent, ['xin chao', 'xin chao']);
  } finally {
    runtime.removeBridge(bridge);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed Zalo send is not retried on redelivery', async () => {
  const claims = new Set();
  let attempts = 0;
  const store = {
    getByTopic: () => ({ conversationId: 'c2', threadType: 0, topicId: 6 }),
    claimTelegramUpdate: async (key) => { if (claims.has(key)) return false; claims.add(key); return true; },
  };
  const replies = [];
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: '778:no-retry-test', telegramForumChatId: -1002, telegramAdminIds: new Set([111]), allowedTelegramUserIds: new Set([111]) },
    store, logger, zalo: { sendText: async () => { attempts += 1; throw new Error('zalo timeout'); } },
  });
  bridge.runtime.addBridge(bridge);
  const ctx = { update: { update_id: 1 }, chat: { id: -1002 }, from: { id: 111 }, message: { message_thread_id: 6, text: 'a' }, reply: async (text) => { replies.push(text); } };
  try {
    await bridge.runtime.routeTelegramMessage(ctx, 'text');
    bridge.runtime.processedUpdates.clear();
    await bridge.runtime.routeTelegramMessage(ctx, 'text');
    assert.equal(attempts, 1);
    assert.match(replies[0], /Không gửi được sang Zalo/);
  } finally {
    bridge.runtime.removeBridge(bridge);
  }
});

function forwardingFixture(token, download) {
  const calls = [];
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: token, telegramForumChatId: -1003, telegramAdminIds: new Set(), allowedTelegramUserIds: new Set() },
    store: {}, zalo: {}, logger,
  });
  bridge.runtime.groupQueue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  bridge.downloadAttachment = download;
  for (const method of ['sendPhoto', 'sendDocument', 'sendVideo', 'sendMessage']) {
    bridge.bot.telegram[method] = async (chatId, input, options) => {
      calls.push({ method, input, options });
      return { message_id: calls.length };
    };
  }
  return { bridge, calls };
}

const mapping = { topicId: 9, conversationId: 'c' };
const zaloFile = (title, url = 'https://f40-zfcloud.zdn.vn/x/123') => ({ isGroup: false, title: 'Ban', senderName: 'Ban', text: '', attachment: { url, title, type: 'file' } });

test('Zalo text files are uploaded to Telegram as documents, not photos', async () => {
  const { bridge, calls } = forwardingFixture('779:doc-test', async () => ({ buffer: Buffer.from('hello'), filename: 'log.txt', kind: 'document' }));
  await bridge.sendZaloMessageToTelegram(mapping, zaloFile('log.txt'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendDocument');
  assert.equal(calls[0].input.filename, 'log.txt');
  assert.equal(calls[0].options.message_thread_id, 9);
});

test('Zalo images go as photos and fall back to document when Telegram rejects the photo', async () => {
  const { bridge, calls } = forwardingFixture('780:photo-test', async () => ({ buffer: Buffer.from('img'), filename: 'a.jpg', kind: 'photo' }));
  await bridge.sendZaloMessageToTelegram(mapping, zaloFile('attachment'));
  assert.equal(calls[0].method, 'sendPhoto');

  bridge.bot.telegram.sendPhoto = async () => { throw telegramError(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS'); };
  calls.length = 0;
  await bridge.sendZaloMessageToTelegram(mapping, zaloFile('attachment'));
  assert.equal(calls[0].method, 'sendDocument');
});

test('download failure sends the link as text instead of dropping the message', async () => {
  const { bridge, calls } = forwardingFixture('781:link-test', async () => { throw new Error('HTTP 403'); });
  await bridge.sendZaloMessageToTelegram(mapping, zaloFile('report.pdf'));
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(calls[0].input, /zdn\.vn/);
});

test('downloadZaloAttachment picks file kind from name and content type', async () => {
  const fakeFetch = (type, body = 'x') => async () => new Response(body, { status: 200, headers: { 'content-type': type } });
  const txt = await downloadZaloAttachment({ url: 'https://z/1', title: 'a.txt', type: 'file' }, { fetchImpl: fakeFetch('text/plain') });
  assert.equal(txt.kind, 'document');
  assert.equal(txt.filename, 'a.txt');
  const image = await downloadZaloAttachment({ url: 'https://z/2', title: 'attachment', type: 'file' }, { fetchImpl: fakeFetch('image/jpeg') });
  assert.equal(image.kind, 'photo');
  assert.equal(image.filename, 'zalo-file.jpg');
  await assert.rejects(
    downloadZaloAttachment({ url: 'https://z/3', title: 'big.zip' }, { fetchImpl: fakeFetch('application/zip', 'xxxxxxxxxx'), maxBytes: 5 }),
    /20 MB/,
  );
});
