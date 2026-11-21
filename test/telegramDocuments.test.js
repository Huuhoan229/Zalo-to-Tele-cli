import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from 'telegraf';
import { TelegramBridgeBot } from '../src/telegramBot.js';
import { ZaloClient } from '../src/zaloClient.js';

let fixtureId = 0;
async function fixture(t) {
  const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'telegram-documents-'));
  const sent = [];
  const replies = [];
  const transcripts = [];
  const echoes = [];
  const quote = { content: 'original Zalo message', msgType: 'webchat' };
  const content = Buffer.from('document test bytes');
  const zalo = Object.create(ZaloClient.prototype);
  zalo.api = {
    sendMessage: async (payload, conversationId, threadType) => {
      const source = payload.attachments[0];
      sent.push({
        payload, conversationId, threadType,
        content: typeof source === 'string' ? await readFile(source) : source.data,
      });
    },
  };
  const bridge = new TelegramBridgeBot({
    config: {
      telegramBotToken: `555:documents-${++fixtureId}`, telegramForumChatId: -1001,
      allowedTelegramUserIds: new Set([111]), telegramAdminIds: new Set([111]), downloadDir,
    },
    store: {
      getByTopic: (id) => id === 17 ? { conversationId: 'zalo-friend', threadType: 0, topicId: 17 } : null,
      getReplyData: () => quote,
    },
    zalo,
    logger: { info() {}, warn() {}, error() {} },
    pendingEcho: {
      register: (id) => echoes.push(['register', id]),
      consume: (id) => echoes.push(['consume', id]),
    },
    onTranscript: async (_mapping, entry) => transcripts.push(entry),
  });
  const runtime = bridge.runtime;
  runtime.addBridge(bridge);
  t.after(async () => {
    runtime.removeBridge(bridge);
    await rm(downloadDir, { recursive: true, force: true });
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(content));
  const telegram = {
    getFileLink: t.mock.fn(async () => new URL('https://telegram.invalid/download/file.dat')),
    sendMessage: async (_chatId, text) => replies.push(text),
  };
  let updateId = 0;
  async function dispatch(document, { userId = 111, chatId = -1001, topicId = 17, id = ++updateId } = {}) {
    const ctx = new Context({
      update_id: id,
      message: {
        message_id: id, date: 1, document, caption: 'Tài liệu cho bạn',
        reply_to_message: { message_id: 99 },
        chat: { id: chatId, type: 'supergroup' },
        from: { id: userId, is_bot: false, first_name: 'Tester' },
        ...(topicId ? { message_thread_id: topicId } : {}),
      },
    }, telegram, { id: 555, username: 'testbot', is_bot: true });
    await runtime.bot.middleware()(ctx, async () => {});
  }
  const document = {
    file_id: 'telegram-file', file_unique_id: 'unique',
    file_name: 'Tài liệu.pdf', mime_type: 'application/pdf', file_size: content.length,
  };
  return { bridge, zalo, content, quote, sent, replies, transcripts, echoes, fetch, telegram, document, dispatch, downloadDir };
}

test('Telegram document updates send PDF, Word, Excel, ZIP and files without MIME to the mapped Zalo conversation', async (t) => {
  const f = await fixture(t);
  for (const filename of ['Tài liệu.pdf', 'Hợp đồng.docx', 'Bảng giá.xlsx', 'archive.zip', 'readme.txt']) {
    await f.dispatch({ ...f.document, file_name: filename, mime_type: undefined });
    const { payload, conversationId, threadType, content } = f.sent.at(-1);
    assert.equal(conversationId, 'zalo-friend');
    assert.equal(threadType, 0);
    assert.equal(payload.msg, 'Tài liệu cho bạn');
    assert.deepEqual(payload.quote, f.quote);
    assert.equal(payload.attachments[0].filename, filename);
    assert.equal(payload.attachments[0].metadata.totalSize, f.content.length);
    assert.deepEqual(content, f.content);
    assert.equal(f.transcripts.at(-1).attachment.title, filename);
    assert.equal(f.transcripts.at(-1).attachment.type, 'file');
  }
  assert.equal(f.sent.length, 5);
  assert.equal(f.replies.length, 0);
  assert.deepEqual(await readdir(f.downloadDir), []);
});

test('image documents still use the image path with the original extension rather than getFile extension', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ ...f.document, file_name: 'ảnh.png', mime_type: 'image/png' });
  assert.equal(f.sent.length, 1);
  assert.equal(typeof f.sent[0].payload.attachments[0], 'string');
  assert.equal(path.extname(f.sent[0].payload.attachments[0]), '.png');
  assert.deepEqual(f.sent[0].content, f.content);
  assert.deepEqual(await readdir(f.downloadDir), []);
});

test('oversize documents report the download limit without downloading or sending to Zalo', async (t) => {
  const f = await fixture(t);
  await f.dispatch({ ...f.document, file_size: 21 * 1024 * 1024 });
  assert.match(f.replies[0], /20 MB/);
  assert.equal(f.telegram.getFileLink.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.transcripts.length, 0);
  assert.deepEqual(await readdir(f.downloadDir), []);
});

test('a failed Zalo file send reports once, clears the echo reservation and removes temporary files', async (t) => {
  const f = await fixture(t);
  f.zalo.api.sendMessage = async () => { throw new Error('Zalo rejected attachment'); };
  await f.dispatch(f.document);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0], /Zalo rejected attachment/);
  assert.deepEqual(f.echoes, [['register', 'zalo-friend'], ['consume', 'zalo-friend']]);
  assert.equal(f.transcripts.length, 0);
  assert.deepEqual(await readdir(f.downloadDir), []);
});

test('file forwarding rejects unauthorized users and unmapped topics before downloading', async (t) => {
  const f = await fixture(t);
  await f.dispatch(f.document, { userId: 222 });
  await f.dispatch(f.document, { topicId: 18 });
  await f.dispatch(f.document, { topicId: null });
  assert.match(f.replies[0], /chưa được cấp quyền/);
  assert.match(f.replies[1], /chưa được map/);
  assert.match(f.replies[2], /chưa nằm trong topic/);
  assert.equal(f.telegram.getFileLink.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.sent.length, 0);
});

test('repeated Telegram updates do not send the same document twice', async (t) => {
  const f = await fixture(t);
  await f.dispatch(f.document, { id: 7 });
  await f.dispatch(f.document, { id: 7 });
  assert.equal(f.sent.length, 1);
  assert.equal(f.fetch.mock.callCount(), 1);
});

test('download failures report an error without sending or recording a successful file', async (t) => {
  const f = await fixture(t);
  f.fetch.mock.mockImplementation(async () => new Response('not found', { status: 404 }));
  await f.dispatch(f.document);
  assert.match(f.replies[0], /404/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.transcripts.length, 0);
  assert.deepEqual(await readdir(f.downloadDir), []);
});
