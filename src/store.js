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
};

export class Store {
  constructor(filePath, { mongoUri = '', mongoDbName = 'zalo-to-tele', mongoCollectionName = 'bridge_state', accountId = 'primary' } = {}) {
    this.filePath = filePath;
    this.mongoUri = mongoUri;
    this.mongoDbName = mongoDbName;
    this.mongoCollectionName = mongoCollectionName;
    this.accountId = accountId;
    this.useMongo = Boolean(mongoUri);
    this.mongoClient = null;
    this.mongoCollection = null;
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
        };
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
      };
      this.state.conversations ||= {};
      this.state.topics ||= {};
      this.state.messages ||= {};
      this.state.credentials ||= null;
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

  async upsertMapping(mapping) {
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

  async appendMessage(conversationId, message) {
    const key = String(conversationId);
    const items = this.state.messages[key] || [];
    const entry = {
      id: message.id || crypto.randomUUID(),
      direction: message.direction || 'in',
      source: message.source || 'zalo',
      senderName: message.senderName || '',
      text: message.text || '',
      attachment: message.attachment || null,
      createdAt: message.createdAt || new Date().toISOString(),
      topicId: message.topicId ?? null,
      threadType: message.threadType ?? null,
    };

    items.push(entry);
    this.state.messages[key] = items.slice(-500);

    const conversation = this.state.conversations[key];
    if (conversation) {
      conversation.updatedAt = entry.createdAt;
      conversation.lastMessage = entry.text || entry.attachment?.title || '(attachment)';
      conversation.lastDirection = entry.direction;
    }

    await this.save();
    return entry;
  }
}
