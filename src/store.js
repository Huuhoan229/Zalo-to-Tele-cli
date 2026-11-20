import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const EMPTY_STATE = {
  version: 1,
  conversations: {},
  topics: {},
  messages: {},
  credentials: null,
  ai: { zaloMode: 'off', telegramHistory: {}, zaloHistory: {}, allowedTelegramUserIds: [] },
};
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const MAX_MESSAGES_PER_ACCOUNT = 500;
const MAX_STORED_TEXT_BYTES = 4096;
const MAX_ATTACHMENT_URL_LENGTH = 2048;
const MAX_QUOTE_DATA_BYTES = 4096;

function boundedString(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function boundedUtf8String(value, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const character of String(value || '')) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function storedAttachment(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...(value.url ? { url: boundedString(value.url, MAX_ATTACHMENT_URL_LENGTH) } : {}),
    ...(value.title ? { title: boundedString(value.title, 160) } : {}),
    ...(value.type ? { type: boundedString(value.type, 32) } : {}),
    ...(value.stickerId ? { stickerId: boundedString(value.stickerId, 80) } : {}),
  };
}

function storedQuoteData(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_QUOTE_DATA_BYTES) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function messageTimestamp(message) {
  const timestamp = Date.parse(message?.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export class Store {
  constructor(
    filePath,
    {
      mongoUri = '',
      mongoDbName = 'zalo-to-tele',
      mongoCollectionName = 'bridge_state',
      ocrQueueCollectionName = 'ocr_queue',
      accountId = 'primary',
      transcriptFullRetentionDays = 1,
      transcriptRetentionDays = 7,
    } = {},
  ) {
    this.filePath = filePath;
    this.mongoUri = mongoUri;
    this.mongoDbName = mongoDbName;
    this.mongoCollectionName = mongoCollectionName;
    this.ocrQueueCollectionName = ocrQueueCollectionName;
    this.accountId = accountId;
    this.transcriptFullRetentionDays = Number.isFinite(Number(transcriptFullRetentionDays))
      ? Math.max(0, Number(transcriptFullRetentionDays))
      : 1;
    this.transcriptRetentionDays = Number.isFinite(Number(transcriptRetentionDays))
      ? Math.max(this.transcriptFullRetentionDays, Number(transcriptRetentionDays))
      : 7;
    this.useMongo = Boolean(mongoUri);
    this.mongoClient = null;
    this.mongoCollection = null;
    this.ocrQueueCollection = null;
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async ensureMongo() {
    if (!this.useMongo) return null;
    if (this.mongoCollection) return this.mongoCollection;
    if (!this.mongoClient) {
      this.mongoClient = new MongoClient(this.mongoUri);
    }
    await this.mongoClient.connect();
    this.mongoCollection = this.mongoClient.db(this.mongoDbName).collection(this.mongoCollectionName);
    return this.mongoCollection;
  }

  async ensureOcrQueueCollection() {
    if (!this.useMongo) return null;
    if (this.ocrQueueCollection) return this.ocrQueueCollection;
    await this.ensureMongo();
    this.ocrQueueCollection = this.mongoClient.db(this.mongoDbName).collection(this.ocrQueueCollectionName);
    await this.ocrQueueCollection.createIndex({ status: 1, queuedAt: 1 });
    await this.ocrQueueCollection.createIndex({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
    return this.ocrQueueCollection;
  }

  async load() {
    if (this.useMongo) {
      const collection = await this.ensureMongo();
      const doc = await collection.findOne({ _id: this.accountId });
      if (doc) {
        this.state = {
          ...structuredClone(EMPTY_STATE),
          ...doc,
          conversations: doc.conversations || {},
          topics: doc.topics || {},
          messages: doc.messages || {},
          credentials: doc.credentials || null,
          ai: { ...EMPTY_STATE.ai, ...(doc.ai || {}) },
        };
        if (this.pruneMessageHistory()) await this.save();
      } else {
        await this.save();
      }
      return;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        conversations: parsed.conversations || {},
        topics: parsed.topics || {},
        messages: parsed.messages || {},
        credentials: parsed.credentials || null,
        ai: { ...EMPTY_STATE.ai, ...(parsed.ai || {}) },
      };
      this.state.conversations ||= {};
      this.state.topics ||= {};
      this.state.messages ||= {};
      this.state.credentials ||= null;
      if (this.pruneMessageHistory()) await this.save();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.useMongo) {
        const collection = await this.ensureMongo();
        await collection.updateOne(
          { _id: this.accountId },
          {
            $set: {
              _id: this.accountId,
              ...this.state,
              updatedAt: new Date().toISOString(),
            },
          },
          { upsert: true },
        );
        return;
      }

      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, this.filePath);
    });
    return this.writeQueue;
  }

  async close() {
    if (!this.mongoClient) return;
    await this.mongoClient.close();
    this.mongoClient = null;
    this.mongoCollection = null;
    this.ocrQueueCollection = null;
  }

  async deleteState() {
    if (this.useMongo) {
      const collection = await this.ensureMongo();
      await collection.deleteOne({ _id: this.accountId });
    }
    await fs.rm(this.filePath, { force: true });
  }

  getByConversation(conversationId) {
    return this.state.conversations[String(conversationId)] || null;
  }

  getByTopic(topicId) {
    return this.state.topics[String(topicId)] || null;
  }

  listConversations() {
    return Object.values(this.state.conversations).sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    );
  }

  listMessages(conversationId, limit = 200) {
    return (this.state.messages[String(conversationId)] || []).slice(-limit);
  }

  listMappings() {
    return Object.values(this.state.conversations).sort((a, b) =>
      String(a.title).localeCompare(String(b.title)),
    );
  }

  getCredentials() {
    return this.state.credentials || null;
  }

  async setCredentials(credentials) {
    this.state.credentials = credentials ? structuredClone(credentials) : null;
    await this.save();
    return this.state.credentials;
  }

  getZaloAiMode() {
    return this.state.ai?.zaloMode || 'off';
  }

  async setZaloAiMode(mode) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    this.state.ai.zaloMode = mode;
    await this.save();
    return mode;
  }

  getTelegramAiHistory(userId) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    return structuredClone(this.state.ai.telegramHistory?.[String(userId)] || []);
  }

  async appendTelegramAiTurn(userId, userText, assistantText) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    this.state.ai.telegramHistory ||= {};
    const key = String(userId);
    const history = this.state.ai.telegramHistory[key] || [];
    history.push(
      { role: 'user', content: String(userText || '').slice(0, 4000) },
      { role: 'assistant', content: String(assistantText || '').slice(0, 4000) },
    );
    this.state.ai.telegramHistory[key] = history.slice(-20);
    await this.save();
  }

  async clearTelegramAiHistory(userId) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    this.state.ai.telegramHistory ||= {};
    delete this.state.ai.telegramHistory[String(userId)];
    await this.save();
  }

  getAllowedTelegramAiUsers() {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    return [...new Set((this.state.ai.allowedTelegramUserIds || []).map(Number).filter(Number.isSafeInteger))];
  }

  async setTelegramAiUserAllowed(userId, allowed) {
    const numericId = Number(userId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error('Telegram ID phải là số hợp lệ.');
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    const current = new Set(this.getAllowedTelegramAiUsers());
    if (allowed) current.add(numericId);
    else current.delete(numericId);
    this.state.ai.allowedTelegramUserIds = [...current];
    await this.save();
    return [...current];
  }

  getZaloAiHistory(conversationId) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    return structuredClone(this.state.ai.zaloHistory?.[String(conversationId)] || []);
  }

  async appendZaloAiTurn(conversationId, userText, assistantText) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    this.state.ai.zaloHistory ||= {};
    const key = String(conversationId);
    const history = this.state.ai.zaloHistory[key] || [];
    history.push(
      { role: 'user', content: String(userText || '').slice(0, 4000) },
      { role: 'assistant', content: String(assistantText || '').slice(0, 4000) },
    );
    this.state.ai.zaloHistory[key] = history.slice(-12);
    await this.save();
  }

  async clearZaloAiHistory(conversationId) {
    this.state.ai ||= structuredClone(EMPTY_STATE.ai);
    this.state.ai.zaloHistory ||= {};
    delete this.state.ai.zaloHistory[String(conversationId)];
    await this.save();
  }

  async upsertMapping(mapping) {
    const topicOwner = this.getByTopic(mapping.topicId);
    if (topicOwner && String(topicOwner.conversationId) !== String(mapping.conversationId)) {
      throw new Error('Topic này đã được gán cho cuộc trò chuyện Zalo khác.');
    }
    const normalized = {
      conversationId: String(mapping.conversationId),
      threadType: mapping.threadType,
      topicId: Number(mapping.topicId),
      title: mapping.title || `Zalo ${mapping.conversationId}`,
      updatedAt: new Date().toISOString(),
    };

    const previous = this.state.conversations[normalized.conversationId];
    if (previous && Number(previous.topicId) !== normalized.topicId) {
      delete this.state.topics[String(previous.topicId)];
    }

    this.state.conversations[normalized.conversationId] = normalized;
    this.state.topics[String(normalized.topicId)] = normalized;
    await this.save();
    return normalized;
  }

  async switchTelegramForum(previousChatId, nextChatId) {
    if (Number(previousChatId) === Number(nextChatId)) return;
    this.state.telegramDestinations ||= {};
    this.state.telegramDestinations[String(previousChatId)] = {
      conversations: structuredClone(this.state.conversations),
      topics: structuredClone(this.state.topics),
    };
    const restored = this.state.telegramDestinations[String(nextChatId)];
    this.state.conversations = structuredClone(restored?.conversations || {});
    this.state.topics = structuredClone(restored?.topics || {});
    // Telegram message IDs are scoped to a chat. Do not reuse old quotes/dedupe
    // records when switching groups; session and AI history remain intact.
    this.state.bridgeHistoryByChat ||= {};
    this.state.bridgeHistoryByChat[String(previousChatId)] = structuredClone(this.state.messages);
    this.state.messages = structuredClone(this.state.bridgeHistoryByChat[String(nextChatId)] || {});
    await this.save();
  }

  async appendMessage(conversationId, message) {
    this.pruneMessageHistory();
    const key = String(conversationId);
    const items = this.state.messages[key] || [];
    const messageId = String(message.id || '');
    const existing = messageId ? items.find((item) => String(item.id) === messageId) : null;
    if (existing) {
      if (message.telegramMessageId) existing.telegramMessageId = Number(message.telegramMessageId);
      if (message.replyData) existing.replyData = structuredClone(message.replyData);
      await this.save();
      return existing;
    }
    const entry = {
      id: message.id || crypto.randomUUID(),
      direction: message.direction || 'in',
      source: message.source || 'zalo',
      senderName: boundedString(message.senderName, 160),
      text: boundedUtf8String(message.text, MAX_STORED_TEXT_BYTES),
      attachment: storedAttachment(message.attachment),
      createdAt: message.createdAt || new Date().toISOString(),
      topicId: message.topicId ?? null,
      threadType: message.threadType ?? null,
      telegramMessageId: message.telegramMessageId ? Number(message.telegramMessageId) : null,
      replyData: storedQuoteData(message.replyData),
    };

    items.push(entry);
    this.state.messages[key] = items.slice(-MAX_MESSAGES_PER_CONVERSATION);
    this.pruneMessageHistory();

    const conversation = this.state.conversations[key];
    if (conversation) {
      conversation.updatedAt = entry.createdAt;
      conversation.lastMessage = boundedUtf8String(
        entry.text || entry.attachment?.title || '(attachment)',
        512,
      );
      conversation.lastDirection = entry.direction;
    }

    await this.save();
    return entry;
  }

  pruneMessageHistory(now = Date.now()) {
    const fullRetentionMs = this.transcriptFullRetentionDays * DAY_MS;
    const retentionMs = Math.max(fullRetentionMs, this.transcriptRetentionDays * DAY_MS);
    const entries = [];
    let changed = false;

    for (const [conversationId, messages] of Object.entries(this.state.messages || {})) {
      if (!Array.isArray(messages)) {
        delete this.state.messages[conversationId];
        changed = true;
        continue;
      }
      const kept = [];
      for (const message of messages) {
        const createdAt = messageTimestamp(message);
        const age = createdAt ? Math.max(0, now - createdAt) : 0;
        if (createdAt && age >= retentionMs) {
          changed = true;
          continue;
        }

        const retainedFull = {
          id: boundedString(message.id, 160),
          direction: boundedString(message.direction, 16),
          source: boundedString(message.source, 32),
          senderName: boundedString(message.senderName, 160),
          text: boundedUtf8String(message.text, MAX_STORED_TEXT_BYTES),
          attachment: storedAttachment(message.attachment),
          createdAt: message.createdAt || new Date(createdAt || now).toISOString(),
          topicId: message.topicId ?? null,
          threadType: message.threadType ?? null,
          ...(message.telegramMessageId ? { telegramMessageId: Number(message.telegramMessageId) } : {}),
          ...(message.replyData ? { replyData: storedQuoteData(message.replyData) } : {}),
        };
        let retained = retainedFull;
        if (createdAt && age >= fullRetentionMs) {
          retained = {
            id: retainedFull.id,
            createdAt: retainedFull.createdAt,
            ...(retainedFull.telegramMessageId ? { telegramMessageId: retainedFull.telegramMessageId } : {}),
            ...(retainedFull.replyData ? { replyData: retainedFull.replyData } : {}),
          };
        }
        if (JSON.stringify(retained) !== JSON.stringify(message)) changed = true;
        kept.push(retained);
        entries.push({ conversationId, message: retained, createdAt });
      }
      this.state.messages[conversationId] = kept;
    }

    entries.sort((a, b) => b.createdAt - a.createdAt);
    const retainedEntries = new Set(entries.slice(0, MAX_MESSAGES_PER_ACCOUNT).map((entry) => entry.message));
    if (entries.length > MAX_MESSAGES_PER_ACCOUNT) changed = true;
    for (const [conversationId, messages] of Object.entries(this.state.messages)) {
      const kept = messages.filter((message) => retainedEntries.has(message));
      if (kept.length !== messages.length) {
        this.state.messages[conversationId] = kept;
        changed = true;
      }
      if (kept.length === 0) delete this.state.messages[conversationId];
    }
    for (const conversation of Object.values(this.state.conversations || {})) {
      const updatedAt = Date.parse(conversation?.updatedAt || '');
      if (
        conversation?.lastMessage &&
        Number.isFinite(updatedAt) &&
        now - updatedAt >= fullRetentionMs
      ) {
        conversation.lastMessage = '';
        changed = true;
      }
    }
    return changed;
  }

  getReplyData(telegramMessageId) {
    const target = String(telegramMessageId ?? '');
    if (!target) return null;
    for (const items of Object.values(this.state.messages)) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (String(item.telegramMessageId ?? '') === target) return item.replyData || null;
      }
    }
    return null;
  }

  async enqueueOcrMessage(message) {
    if (!this.useMongo) return null;
    const collection = await this.ensureOcrQueueCollection();
    const messageId = String(
      message.id || message.messageId || `${message.conversationId || 'unknown'}-${message.createdAt || Date.now()}`,
    );
    const now = new Date().toISOString();
    const doc = {
      _id: `${this.accountId}:${messageId}`,
      accountId: this.accountId,
      messageId,
      conversationId: String(message.conversationId || ''),
      threadType: message.threadType ?? null,
      title: message.title || '',
      senderName: message.senderName || '',
      text: message.text || '',
      attachment: message.attachment || null,
      isGroup: Boolean(message.isGroup),
      isSelf: Boolean(message.isSelf),
      status: 'pending',
      payload: {
        ...message,
        id: messageId,
        accountId: this.accountId,
      },
      queuedAt: now,
      updatedAt: now,
    };

    await collection.updateOne(
      { _id: doc._id },
      {
        $setOnInsert: doc,
      },
      { upsert: true },
    );
    return doc;
  }
}
