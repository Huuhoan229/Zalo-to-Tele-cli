import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STATE = {
  version: 1,
  conversations: {},
  topics: {},
  messages: {},
};

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = { ...structuredClone(EMPTY_STATE), ...JSON.parse(raw) };
      this.state.conversations ||= {};
      this.state.topics ||= {};
      this.state.messages ||= {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, this.filePath);
    });
    return this.writeQueue;
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

  async upsertMapping(mapping) {
    const normalized = {
      conversationId: String(mapping.conversationId),
      threadType: mapping.threadType,
      topicId: Number(mapping.topicId),
      title: mapping.title || `Zalo ${mapping.conversationId}`,
      updatedAt: new Date().toISOString(),
    };

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
