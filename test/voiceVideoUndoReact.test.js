import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import {
  TelegramBridgeBot,
  downloadZaloAttachment,
  telegramReactionToZalo,
  zaloReactionToTelegram,
} from '../src/telegramBot.js';
import { TelegramGroupQueue } from '../src/telegramGroupQueue.js';
import { Store } from '../src/store.js';
import { ZaloClient, buildZaloMentions, pickText } from '../src/zaloClient.js';

const noWait = async () => {};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('Zalo voice and video messages are forwarded to Telegram with sendVoice and sendVideo', async () => {
  const calls = [];
  const bridge = new TelegramBridgeBot({
    config: { telegramBotToken: '880:voice-video-in', telegramForumChatId: -10010, telegramAdminIds: new Set(), allowedTelegramUserIds: new Set() },
    store: {}, zalo: {}, logger,
  });
  bridge.runtime.groupQueue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  for (const method of ['sendVoice', 'sendAudio', 'sendVideo', 'sendDocument', 'sendMessage']) {
    bridge.bot.telegram[method] = async (chatId, input, options) => {
      calls.push({ method, chatId, input, options });
      return { message_id: calls.length };
    };
  }

  bridge.downloadAttachment = async (att) => downloadZaloAttachment(att, {
    fetchImpl: async () => new Response('voice-bytes', { status: 200, headers: { 'content-type': 'audio/mp4' } }),
  });
  await bridge.sendZaloMessageToTelegram({ topicId: 12, conversationId: 'c1' }, {
    isGroup: false, title: 'Bạn A', senderName: 'Bạn A', text: '',
    attachment: { url: 'https://zdn.vn/voice1', title: 'voice.m4a', type: 'voice' },
  });
  assert.equal(calls[0].method, 'sendVoice');
  assert.match(calls[0].options.caption, /Tin nhắn thoại/);

  bridge.downloadAttachment = async (att) => downloadZaloAttachment(att, {
    fetchImpl: async () => new Response('video-bytes', { status: 200, headers: { 'content-type': 'video/mp4' } }),
  });
  await bridge.sendZaloMessageToTelegram({ topicId: 12, conversationId: 'c1' }, {
    isGroup: false, title: 'Bạn A', senderName: 'Bạn A', text: '',
    attachment: { url: 'https://zdn.vn/vid1', title: 'video.mp4', type: 'video' },
  });
  assert.equal(calls[1].method, 'sendVideo');
});

test('Telegram voice and video messages in a mapped topic are forwarded to Zalo and recorded with IDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tele-media-'));
  const fileServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '6' });
    res.end('123456');
  });
  fileServer.listen(0, '127.0.0.1');
  await once(fileServer, 'listening');
  const fileOrigin = `http://127.0.0.1:${fileServer.address().port}`;

  const store = new Store(path.join(dir, 'state.json'), { accountId: 'media' });
  await store.load();
  const mapping = await store.upsertMapping({ conversationId: 'conv-media', threadType: 0, topicId: 77, title: 'Media' });

  const sentVoices = [];
  const sentVideos = [];
  const bridge = new TelegramBridgeBot({
    config: {
      telegramBotToken: '881:voice-video-out',
      telegramForumChatId: -10011,
      telegramAdminIds: new Set([111]),
      allowedTelegramUserIds: new Set([111]),
      downloadDir: dir,
    },
    store,
    logger,
    zalo: {
      sendVoice: async (payload) => { sentVoices.push(payload); return { msgId: '9001', cliMsgId: '1001' }; },
      sendVideo: async (payload) => { sentVideos.push(payload); return { msgId: '9002', cliMsgId: '1002' }; },
    },
    onTranscript: (m, entry) => store.appendMessage(m.conversationId, { ...entry, topicId: m.topicId }),
  });
  bridge.runtime.addBridge(bridge);

  const telegram = { getFileLink: async (fileId) => `${fileOrigin}/${fileId}` };
  try {
    await bridge.runtime.routeTelegramMessage({
      update: { update_id: 501 },
      chat: { id: -10011 },
      from: { id: 111, first_name: 'Hoan' },
      telegram,
      message: {
        message_id: 301,
        message_thread_id: 77,
        voice: { file_id: 'v1', file_unique_id: 'uv1', file_size: 6 },
      },
      reply: async () => {},
    }, 'voice');

    assert.equal(sentVoices.length, 1);
    assert.equal(store.findMessageByTelegramId('conv-media', 301)?.replyData?.msgId, '9001');

    await bridge.runtime.routeTelegramMessage({
      update: { update_id: 502 },
      chat: { id: -10011 },
      from: { id: 111, first_name: 'Hoan' },
      telegram,
      message: {
        message_id: 302,
        message_thread_id: 77,
        caption: 'clip',
        video: { file_id: 'vid1', file_unique_id: 'uvid1', file_size: 6, duration: 4, width: 720, height: 1280 },
      },
      reply: async () => {},
    }, 'video');

    assert.equal(sentVideos.length, 1);
    assert.equal(sentVideos[0].duration, 4);
    assert.equal(store.findMessageByTelegramId('conv-media', 302)?.replyData?.msgId, '9002');
    assert.equal(mapping.topicId, 77);
  } finally {
    bridge.runtime.removeBridge(bridge);
    fileServer.closeAllConnections();
    await new Promise((r) => fileServer.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('two-way undo and reactions sync between Telegram and Zalo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tele-undo-react-'));
  const store = new Store(path.join(dir, 'state.json'), { accountId: 'sync' });
  await store.load();
  const mapping = await store.upsertMapping({ conversationId: 'conv-1', threadType: 0, topicId: 88, title: 'Bạn B' });

  const undone = [];
  const zaloReactions = [];
  const tgCalls = [];
  const bridge = new TelegramBridgeBot({
    config: {
      telegramBotToken: '882:undo-react',
      telegramForumChatId: -10012,
      telegramAdminIds: new Set([111]),
      allowedTelegramUserIds: new Set([111]),
      downloadDir: dir,
    },
    store,
    logger,
    zalo: {
      sendText: async () => ({ msgId: '7001' }),
      undoMessage: async (payload) => { undone.push(payload); },
      sendReaction: async (payload) => { zaloReactions.push(payload); },
    },
    onTranscript: (m, entry) => store.appendMessage(m.conversationId, { ...entry, topicId: m.topicId }),
  });
  bridge.runtime.groupQueue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  bridge.runtime.addBridge(bridge);
  bridge.bot.telegram.sendMessage = async (chatId, text, options) => {
    tgCalls.push({ method: 'sendMessage', chatId, text, options });
    return { message_id: 400 + tgCalls.length };
  };
  bridge.bot.telegram.deleteMessage = async (chatId, messageId) => {
    tgCalls.push({ method: 'deleteMessage', chatId, messageId });
  };
  bridge.bot.telegram.callApi = async (method, payload) => {
    tgCalls.push({ method, payload });
    return true;
  };

  try {
    // 1. Incoming Zalo message -> forwarded to Telegram with message_id 401
    await bridge.forwardZaloMessage({
      id: '5551',
      conversationId: 'conv-1',
      threadType: 0,
      isGroup: false,
      isSelf: false,
      senderName: 'Bạn B',
      title: 'Bạn B',
      text: 'Tin từ Zalo',
      raw: { data: { msgId: '5551', cliMsgId: '6661', uidFrom: 'u2', content: 'Tin từ Zalo', msgType: 'webchat', ts: '1', ttl: 0 } },
    });

    // 2. User reacts on Telegram -> forwards native reaction to Zalo
    await bridge.handleTelegramReaction(
      { from: { id: 111 } },
      '❤️',
      401,
      mapping,
    );
    assert.equal(zaloReactions.length, 1);
    assert.deepEqual(zaloReactions[0], {
      conversationId: 'conv-1',
      threadType: 0,
      msgId: '5551',
      cliMsgId: '6661',
      reaction: '/-heart',
    });

    // 3. Friend reacts on Zalo -> sets native emoji reaction on Telegram message 401
    await bridge.handleZaloReaction({
      conversationId: 'conv-1',
      threadType: 0,
      isGroup: false,
      isSelf: false,
      senderName: 'Bạn B',
      rIcon: ':>',
      targets: [{ msgId: '5551', cliMsgId: '6661' }],
    });
    const setReactionCall = tgCalls.find((c) => c.method === 'setMessageReaction');
    assert.ok(setReactionCall);
    assert.equal(setReactionCall.payload.message_id, 401);
    assert.deepEqual(setReactionCall.payload.reaction, [{ type: 'emoji', emoji: '🤣' }]);

    // 4. Friend recalls message on Zalo -> replies in topic referencing message 401
    await bridge.handleZaloUndo({
      conversationId: 'conv-1',
      threadType: 0,
      isGroup: false,
      isSelf: false,
      senderName: 'Bạn B',
      msgId: '5551',
      cliMsgId: '6661',
    });
    const undoNotice = tgCalls.findLast((c) => c.method === 'sendMessage');
    assert.match(undoNotice.text, /đã thu hồi tin nhắn này trên Zalo/);
    assert.equal(undoNotice.options.reply_to_message_id, 401);

    // 5. User sends message from Telegram -> self-echo attaches cliMsgId -> user runs /undo
    await bridge.forwardTelegramText({
      chat: { id: -10012 },
      from: { id: 111, first_name: 'Hoan' },
      message: { message_id: 499, message_thread_id: 88, text: 'Tin gửi nhầm' },
      reply: async () => {},
    }, mapping);
    await store.attachZaloEcho('conv-1', { msgId: '7001', cliMsgId: '7999' }, '7001');

    const replies = [];
    await bridge.handleTelegramUndo({
      from: { id: 111 },
      message: { message_thread_id: 88, text: '/undo' },
      reply: async (t) => replies.push(t),
    }, mapping);
    assert.equal(undone.length, 1);
    assert.deepEqual(undone[0], {
      conversationId: 'conv-1',
      threadType: 0,
      msgId: '7001',
      cliMsgId: '7999',
    });
    assert.match(replies[0], /Đã thu hồi tin nhắn trên Zalo/);
  } finally {
    bridge.runtime.removeBridge(bridge);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ZaloClient normalizes voice/video attachments, undo events, and reaction mappings', () => {
  const client = new ZaloClient({ credentialsFile: 'x', logger });
  client.selfUserId = 'me';
  const undo = client.normalizeUndo({
    threadId: 'c9',
    isGroup: false,
    isSelf: false,
    data: { uidFrom: 'u9', dName: 'Minh', content: { globalMsgId: 123, cliMsgId: 456 } },
  });
  assert.equal(undo.msgId, '123');
  assert.equal(undo.cliMsgId, '456');
  assert.equal(undo.senderName, 'Minh');

  const reaction = client.normalizeReaction({
    threadId: 'c9',
    isGroup: false,
    isSelf: false,
    data: { uidFrom: 'u9', dName: 'Minh', content: { rIcon: '/-strong', rMsg: [{ gMsgID: '123', cMsgID: '456' }] } },
  });
  assert.equal(reaction.rIcon, '/-strong');
  assert.equal(zaloReactionToTelegram(reaction.rIcon), '👍');
  assert.equal(telegramReactionToZalo('👍'), '/-strong');
  assert.equal(telegramReactionToZalo('😢'), ':-((');
  assert.equal(telegramReactionToZalo(''), '');

  const members = [
    { uid: 'u100', name: 'Nguyễn Minh Hưng' },
    { uid: 'u200', name: 'Trần Thu Hà' },
  ];
  const m1 = buildZaloMentions('Chào @all và @Hung nhé!', members);
  assert.equal(m1.text, 'Chào @all và @Nguyễn Minh Hưng nhé!');
  assert.deepEqual(m1.mentions, [
    { pos: 5, len: 4, uid: '-1' },
    { pos: 13, len: 17, uid: 'u100' },
  ]);

  const m2 = buildZaloMentions('@ kiểm tra giúp nhé', members, { uid: 'u200', name: 'Trần Thu Hà' });
  assert.equal(m2.text, '@Trần Thu Hà kiểm tra giúp nhé');
  assert.deepEqual(m2.mentions, [{ pos: 0, len: 12, uid: 'u200' }]);

  assert.equal(
    pickText({ action: 'recommened.call', params: JSON.stringify({ isVideo: 0, duration: 0 }) }, { msgType: 'chat.recommended' }, false),
    '📞 Cuộc gọi nhỡ trên Zalo',
  );
  assert.equal(
    pickText({ action: 'recommened.call', params: JSON.stringify({ isVideo: 1, duration: 0 }) }, { msgType: 'chat.recommended' }, false),
    '📹 Cuộc gọi video nhỡ trên Zalo',
  );
  assert.equal(
    pickText({ action: 'recommened.call', params: JSON.stringify({ isVideo: 0, duration: 85 }) }, { msgType: 'chat.recommended' }, false),
    '📞 Cuộc gọi thoại Zalo (1 phút 25 giây)',
  );
  assert.match(
    pickText({ title: 'Hồ Hoàn Kiếm', params: JSON.stringify({ lat: 21.0285, lon: 105.8542 }) }, { msgType: 'chat.location.new' }, false),
    /📍 Đã chia sẻ vị trí: Hồ Hoàn Kiếm/,
  );
});
