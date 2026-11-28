import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LoginQRCallbackEventType, Zalo, ThreadType, Reactions } from 'zca-js';
import { imageMetadataGetter, safeFilename } from './media.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecoverableQrLoginError(error) {
  const message = String(error?.message || error || '');
  return (
    error?.name === 'ZcaApiError' ||
    /QR expired|cannot get scan result|cannot get confirm result|login qr/i.test(message)
  );
}

function pickText(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  return content.title || content.href || content.description || content.text || '';
}

function pickSenderName(message) {
  return (
    message.data?.dName ||
    message.data?.senderName ||
    message.data?.fromDName ||
    message.senderName ||
    message.fromDisplayName ||
    message.uidFrom ||
    'Zalo'
  );
}

function pickConversationTitle(message, isGroup) {
  if (isGroup) {
    return (
      message.data?.threadName ||
      message.data?.groupName ||
      message.data?.groupTitle ||
      message.threadName ||
      message.groupName ||
      message.title ||
      `Zalo group ${message.threadId}`
    );
  }

  return (
    message.data?.dName ||
    message.data?.threadName ||
    message.data?.displayName ||
    message.threadName ||
    message.title ||
    `Zalo user ${message.threadId}`
  );
}

function parseObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAttachment(content, messageType = '') {
  const value = parseObject(content);
  const typeText = String(messageType || '');
  if (!value && !/sticker/i.test(typeText)) return null;
  const params = parseObject(value?.params);
  const sticker = value?.sticker || value?.stickerInfo ||
    (String(value?.type || '').toLowerCase() === 'sticker' ? value : null) ||
    (/sticker/i.test(typeText) ? params?.sticker || params || value || {} : null);
  const href =
    value?.href ||
    value?.hdUrl ||
    value?.normalUrl ||
    value?.videoUrl ||
    value?.voiceUrl ||
    value?.m4aUrl ||
    value?.fileUrl ||
    value?.url ||
    value?.previewUrl ||
    value?.thumb ||
    sticker?.url ||
    sticker?.href ||
    sticker?.staticUrl ||
    sticker?.gifUrl ||
    sticker?.stickerUrl ||
    sticker?.stickerWebpUrl;
  const stickerId = sticker?.stickerId || sticker?.sticker_id || sticker?.id || value?.stickerId || value?.sticker_id;
  const isSticker = Boolean(sticker || /sticker/i.test(typeText));
  if (!href && !stickerId && !isSticker) return null;
  let type = 'file';
  if (isSticker) type = 'sticker';
  else if (/voice/i.test(typeText) || value?.voiceUrl || value?.m4aUrl) type = 'voice';
  else if (/video/i.test(typeText) || value?.videoUrl) type = 'video';
  else if (/photo|image/i.test(typeText)) type = 'image';
  return {
    url: href || null,
    stickerId: stickerId ? Number(stickerId) || String(stickerId) : null,
    title: isSticker ? 'sticker' : value?.title || value?.fileName || (type === 'voice' ? 'voice.m4a' : type === 'video' ? 'video.mp4' : 'attachment'),
    type,
    raw: value || content,
  };
}

function extractSentIds(response) {
  const msgId = response?.message?.msgId ?? response?.attachment?.[0]?.msgId ?? response?.msgId ?? null;
  const cliMsgId = response?.message?.cliMsgId ?? response?.attachment?.[0]?.cliMsgId ?? response?.cliMsgId ?? null;
  return {
    msgId: msgId !== null && msgId !== undefined ? String(msgId) : null,
    cliMsgId: cliMsgId !== null && cliMsgId !== undefined ? String(cliMsgId) : null,
  };
}

function quotedMessageText(quote) {
  if (!quote || typeof quote !== 'object') return '';
  const content = quote.msg || quote.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    return content.title || content.text || content.description || '';
  }
  return '';
}

export class ZaloClient extends EventEmitter {
  constructor({ credentialsFile, sessionStore = null, loginMode, selfListen = true, logger }) {
    super();
    this.credentialsFile = credentialsFile;
    this.sessionStore = sessionStore;
    this.loginMode = loginMode;
    this.selfListen = selfListen;
    this.logger = logger;
    this.api = null;
    this.selfProfile = null;
    this.selfUserId = null;
    this.lastQrPath = null;
    this.manualStop = false;
    this.heartbeatTimer = null;
    this.ThreadType = ThreadType;
  }

  async connect() {
    const zalo = new Zalo({
      imageMetadataGetter,
      selfListen: this.selfListen,
    });

    if (this.sessionStore?.getCredentials) {
      const storedCredentials = await this.sessionStore.getCredentials();
      if (storedCredentials) {
        try {
          this.api = await zalo.login(storedCredentials);
          this.logger.info('Logged into Zalo with Mongo-backed credentials.');
        } catch (error) {
          if (this.loginMode === 'cookie') throw error;
          this.logger.warn({ error }, 'Mongo-backed Zalo credentials unavailable; falling back to file or QR login.');
        }
      }
    }

    if (this.loginMode === 'cookie' || this.loginMode === 'auto') {
      try {
        if (!this.api) {
          const raw = await fs.readFile(this.credentialsFile, 'utf8');
          const credentials = JSON.parse(raw);
          this.api = await zalo.login(credentials);
          if (this.sessionStore?.setCredentials) {
            await this.sessionStore.setCredentials(credentials);
          }
          this.logger.info({ credentialsFile: this.credentialsFile }, 'Logged into Zalo with saved credentials.');
        }
      } catch (error) {
        if (this.loginMode === 'cookie') throw error;
        this.logger.warn({ error }, 'Saved Zalo credentials unavailable; falling back to QR login.');
      }
    }

    if (!this.api) {
      await this.loginWithQr(zalo);
    }

    if (this.manualStop) throw new Error('Zalo login cancelled');
    await this.loadSelfProfile();
    this.startHeartbeat();
    this.logger.info('Connected to Zalo');
    return this;
  }

  async loadSelfProfile() {
    try {
      const response = await this.api.fetchAccountInfo();
      this.selfProfile = response?.profile || null;
      this.selfUserId = String(
        this.selfProfile?.userId ||
        this.selfProfile?.globalId ||
        this.selfProfile?.uid ||
      this.api.getOwnId?.() ||
        '',
      ) || null;
      this.logger.info(
        {
          selfUserId: this.selfUserId,
          selfDisplayName: this.selfProfile?.displayName || this.selfProfile?.zaloName || null,
        },
        'Loaded Zalo profile.',
      );
    } catch (error) {
      this.logger.warn({ error }, 'Could not load Zalo profile for self detection.');
    }
  }

  async loginWithQr(zalo) {
    await fs.mkdir(path.dirname(this.credentialsFile), { recursive: true });
    const qrPath = path.join(path.dirname(this.credentialsFile), 'zalo-qr.png');
    this.lastQrPath = qrPath;
    while (true) {
      if (this.manualStop) throw new Error('Zalo login cancelled');
      try {
        this.api = await zalo.loginQR({ qrPath }, async (event) => {
          if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
            if (this.manualStop) return;
            await event.actions.saveToFile(qrPath);
            this.emit('qr', {
              qrPath,
              qrImageBase64: event.data.image,
              qrCode: event.data.code,
            });
            this.logger.info({ qrPath }, 'Zalo QR generated. Open this file and scan it with Zalo mobile.');
          }

          if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
            if (this.manualStop) return;
            this.emit('qrScanned', { account: event.data.display_name });
            this.logger.info({ account: event.data.display_name }, 'Zalo QR scanned. Confirm login on mobile.');
          }

          if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
            if (this.manualStop) return;
            await fs.rm(qrPath, { force: true });
            this.emit('qrExpired', { qrPath });
            this.logger.warn({ qrPath }, 'Zalo QR expired. Requesting a fresh QR code.');
          }

          if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
            if (this.manualStop) return;
            await fs.rm(qrPath, { force: true });
            this.emit('qrDeclined', { qrPath, code: event.data.code });
            this.logger.warn({ qrPath }, 'Zalo QR declined. Requesting a fresh QR code.');
          }

          if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
            if (this.manualStop) return;
            const credentials = {
              cookie: event.data.cookie,
              imei: event.data.imei,
              userAgent: event.data.userAgent,
            };
            if (this.sessionStore?.setCredentials) {
              await this.sessionStore.setCredentials(credentials);
            } else {
              await fs.writeFile(
                this.credentialsFile,
                `${JSON.stringify(credentials, null, 2)}\n`,
                'utf8',
              );
            }
            this.emit('credentialsSaved', { credentialsFile: this.credentialsFile });
            this.logger.info({ credentialsFile: this.credentialsFile }, 'Zalo credentials saved.');
          }
        });
        return;
      } catch (error) {
        if (this.manualStop) throw new Error('Zalo login cancelled');
        if (this.logger) this.logger.warn({ error }, 'Zalo QR login attempt failed.');
        if (!isRecoverableQrLoginError(error)) throw error;
        if (!this.lastQrPath) throw error;
        await sleep(1000);
      }
    }
  }

  onMessage(handler) {
    if (!this.api) throw new Error('Zalo is not connected');

    this.api.listener.on('connected', () => {
      this.logger.info('Zalo listener connected.');
      this.emit('connected');
    });

    this.api.listener.on('disconnected', (code, reason) => {
      this.logger.warn({ code, reason }, 'Zalo listener disconnected.');
      this.emit('disconnected', { code, reason });
    });

    this.api.listener.on('closed', (code, reason) => {
      this.logger.warn({ code, reason }, 'Zalo listener closed.');
      this.emit('closed', { code, reason });
    });

    this.api.listener.on('error', (error) => {
      this.logger.error({ error }, 'Zalo listener error.');
      this.emit('listenerError', error);
    });

    this.api.listener.on('message', async (message) => {
      try {
        await handler(await this.normalizeMessage(message));
      } catch (error) {
        this.logger.error({ error, message }, 'Failed to handle Zalo message');
      }
    });

    this.api.listener.on('undo', async (undo) => {
      try {
        this.emit('undo', this.normalizeUndo(undo));
      } catch (error) {
        this.logger.error({ error, undo }, 'Failed to handle Zalo undo event');
      }
    });

    this.api.listener.on('reaction', async (reaction) => {
      try {
        this.emit('reaction', this.normalizeReaction(reaction));
      } catch (error) {
        this.logger.error({ error, reaction }, 'Failed to handle Zalo reaction event');
      }
    });

    this.api.listener.start({ retryOnClose: false });
  }

  normalizeUndo(undo) {
    const data = undo?.data || {};
    const content = parseObject(data.content) || {};
    const isSelf = Boolean(
      undo?.isSelf ||
      (this.selfUserId && String(data.uidFrom || '') === this.selfUserId),
    );
    const msgId = content.globalMsgId ?? data.realMsgId ?? data.msgId ?? null;
    const cliMsgId = content.cliMsgId ?? data.cliMsgId ?? null;
    return {
      conversationId: String(undo?.threadId || data.idTo || data.uidFrom || ''),
      threadType: undo?.isGroup ? ThreadType.Group : ThreadType.User,
      isGroup: Boolean(undo?.isGroup),
      isSelf,
      senderName: isSelf ? 'Tôi' : (data.dName || data.uidFrom || 'Zalo'),
      msgId: msgId !== null && msgId !== undefined ? String(msgId) : null,
      cliMsgId: cliMsgId !== null && cliMsgId !== undefined ? String(cliMsgId) : null,
      raw: undo,
    };
  }

  normalizeReaction(reaction) {
    const data = reaction?.data || {};
    const content = parseObject(data.content) || {};
    const isSelf = Boolean(
      reaction?.isSelf ||
      (this.selfUserId && String(data.uidFrom || '') === this.selfUserId),
    );
    const targets = Array.isArray(content.rMsg) && content.rMsg.length > 0
      ? content.rMsg.map((item) => ({
          msgId: item?.gMsgID !== undefined && item?.gMsgID !== null ? String(item.gMsgID) : null,
          cliMsgId: item?.cMsgID !== undefined && item?.cMsgID !== null ? String(item.cMsgID) : null,
        }))
      : [{
          msgId: data.msgId !== undefined && data.msgId !== null ? String(data.msgId) : null,
          cliMsgId: data.cliMsgId !== undefined && data.cliMsgId !== null ? String(data.cliMsgId) : null,
        }];
    return {
      conversationId: String(reaction?.threadId || data.idTo || data.uidFrom || ''),
      threadType: reaction?.isGroup ? ThreadType.Group : ThreadType.User,
      isGroup: Boolean(reaction?.isGroup),
      isSelf,
      senderName: isSelf ? 'Tôi' : (data.dName || data.uidFrom || 'Zalo'),
      rIcon: typeof content.rIcon === 'string' ? content.rIcon : '',
      rType: content.rType,
      targets,
      raw: reaction,
    };
  }

  stop() {
    this.manualStop = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.api?.listener?.stop?.();
  }

  startHeartbeat() {
    if (!this.api?.keepAlive) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.api.keepAlive();
        this.logger.debug('Zalo heartbeat ok.');
      } catch (error) {
        this.logger.warn({ error }, 'Zalo heartbeat failed.');
        this.emit('heartbeatError', error);
      }
    }, 5 * 60 * 1000);
  }

  async normalizeMessage(message) {
    const content = message.data?.content;
    const attachment = normalizeAttachment(content, message.data?.msgType);
    if (attachment?.type === 'sticker' && attachment.stickerId && !attachment.url) {
      try {
        const detail = (await this.api.getStickersDetail(attachment.stickerId))?.[0];
        attachment.url = detail?.stickerUrl || detail?.stickerWebpUrl || null;
      } catch (error) {
        this.logger.debug({ error, stickerId: attachment.stickerId }, 'Could not resolve Zalo sticker image.');
      }
    }
    const isGroup = message.type === ThreadType.Group;
    const isSelf = Boolean(
      message.isSelf ||
      (this.selfUserId && String(message.data?.uidFrom || message.uidFrom || '') === this.selfUserId),
    );

    return {
      id: message.data?.msgId || message.messageId || `${message.threadId}-${Date.now()}`,
      conversationId: String(message.threadId),
      threadType: message.type,
      isGroup,
      isSelf,
      senderName: isSelf ? 'Tôi' : pickSenderName(message),
      title: await this.resolveConversationTitle(message, isGroup, isSelf),
      text: attachment?.type === 'sticker' ? '' : pickText(content),
      replyTo: message.data?.quote
        ? {
            senderName: message.data.quote.fromD || message.data.quote.dName || message.data.quote.senderName || '',
            text: quotedMessageText(message.data.quote),
            msgId:
              message.data.quote.globalMsgId !== undefined && message.data.quote.globalMsgId !== null
                ? String(message.data.quote.globalMsgId)
                : message.data.quote.msgId !== undefined && message.data.quote.msgId !== null
                  ? String(message.data.quote.msgId)
                  : null,
            cliMsgId:
              message.data.quote.cliMsgId !== undefined && message.data.quote.cliMsgId !== null
                ? String(message.data.quote.cliMsgId)
                : null,
          }
        : null,
      attachment,
      raw: message,
    };
  }

  async resolveConversationTitle(message, isGroup, isSelf = false) {
    // Chat 1-1 mà là tin nhắn của chính mình: trả về null để không
    // rename topic sang tên của mình. Topic luôn giữ tên người đối diện.
    if (!isGroup && isSelf) return null;
    if (!isGroup) return pickConversationTitle(message, false);

    try {
      const response = await this.api.getGroupInfo(String(message.threadId));
      const group = response?.gridInfoMap?.[String(message.threadId)];
      if (group?.name) return group.name;
    } catch (error) {
      this.logger.warn({ error, threadId: message.threadId }, 'Could not fetch Zalo group name; using message fallback.');
    }

    return pickConversationTitle(message, true);
  }

  prepareQuote(quote) {
    if (!quote) return null;
    if (quote.content !== undefined && quote.msgType !== undefined) {
      if ((quote.uidFrom === '0' || !quote.uidFrom) && this.selfUserId) {
        return { ...quote, uidFrom: this.selfUserId };
      }
      return quote;
    }
    if (!quote.msgId) return quote;
    const uidFrom = (!quote.uidFrom || quote.uidFrom === '0') && this.selfUserId ? this.selfUserId : (quote.uidFrom || '0');
    return {
      ...quote,
      uidFrom,
      content: String(quote.content ?? ''),
      msgType: quote.msgType || 'webchat',
      cliMsgId: String(quote.cliMsgId ?? quote.msgId),
      ts: String(quote.ts ?? Date.now()),
      ttl: quote.ttl ?? 0,
    };
  }

  async sendText({ conversationId, threadType, text, quote = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const validQuote = this.prepareQuote(quote);
    const response = await this.api.sendMessage({ msg: text, ...(validQuote ? { quote: validQuote } : {}) }, conversationId, threadType);
    return extractSentIds(response);
  }

  async sendImage({ conversationId, threadType, filePath, caption, quote = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const validQuote = this.prepareQuote(quote);
    const payload = {
      msg: caption || '',
      attachments: [path.resolve(filePath)],
      ...(validQuote ? { quote: validQuote } : {}),
    };
    const response = await this.api.sendMessage(payload, conversationId, threadType);
    return extractSentIds(response);
  }

  async sendFile({ conversationId, threadType, filePath, filename, caption, quote = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const data = await fs.readFile(filePath);
    const validQuote = this.prepareQuote(quote);
    const response = await this.api.sendMessage({
      msg: caption || '',
      attachments: [{
        data,
        filename: safeFilename(filename, path.basename(filePath)),
        metadata: { totalSize: data.length },
      }],
      ...(validQuote ? { quote: validQuote } : {}),
    }, conversationId, threadType);
    return extractSentIds(response);
  }

  async sendVoice({ conversationId, threadType, filePath, filename, caption, quote = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const data = await fs.readFile(filePath);
    const cleanName = safeFilename(filename || 'voice.m4a', path.basename(filePath));
    if (typeof this.api.uploadAttachment === 'function' && typeof this.api.sendVoice === 'function') {
      try {
        const uploaded = await this.api.uploadAttachment([{
          data,
          filename: cleanName,
          metadata: { totalSize: data.length },
        }], conversationId, threadType);
        const voiceUrl = uploaded?.[0]?.fileUrl || uploaded?.[0]?.normalUrl || uploaded?.[0]?.hdUrl;
        if (voiceUrl) {
          const response = await this.api.sendVoice({ voiceUrl }, conversationId, threadType);
          if (caption) {
            await this.api.sendMessage({ msg: caption, ...(quote ? { quote } : {}) }, conversationId, threadType);
          }
          return extractSentIds(response);
        }
      } catch (error) {
        this.logger?.warn?.({ error }, 'Could not send native Zalo voice; falling back to file attachment.');
      }
    }
    return this.sendFile({ conversationId, threadType, filePath, filename: cleanName, caption, quote });
  }

  async sendVideo({
    conversationId,
    threadType,
    filePath,
    filename,
    thumbnailPath = null,
    duration = 0,
    width = 1280,
    height = 720,
    caption,
    quote = null,
  }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const data = await fs.readFile(filePath);
    const rawName = safeFilename(filename || 'video.mp4', path.basename(filePath));
    const videoFilename = /\.mp4$/i.test(rawName) ? rawName : `${rawName.replace(/\.[a-z0-9]{1,8}$/i, '') || 'video'}.mp4`;
    if (typeof this.api.uploadAttachment === 'function' && typeof this.api.sendVideo === 'function') {
      try {
        const uploaded = await this.api.uploadAttachment([{
          data,
          filename: videoFilename,
          metadata: { totalSize: data.length },
        }], conversationId, threadType);
        const videoUrl = uploaded?.[0]?.fileUrl;
        if (videoUrl) {
          let thumbnailUrl = videoUrl;
          if (thumbnailPath) {
            try {
              const thumbUploaded = await this.api.uploadAttachment([path.resolve(thumbnailPath)], conversationId, threadType);
              thumbnailUrl = thumbUploaded?.[0]?.thumbUrl || thumbUploaded?.[0]?.normalUrl || thumbUploaded?.[0]?.hdUrl || videoUrl;
            } catch (thumbError) {
              this.logger?.debug?.({ error: thumbError }, 'Could not upload Zalo video thumbnail; using fallback.');
            }
          }
          const response = await this.api.sendVideo({
            videoUrl,
            thumbnailUrl,
            msg: caption || '',
            duration: Math.round((Number(duration) || 0) * 1000),
            width: Number(width) || 1280,
            height: Number(height) || 720,
          }, conversationId, threadType);
          return extractSentIds(response);
        }
      } catch (error) {
        this.logger?.warn?.({ error }, 'Could not send native Zalo video bubble; falling back to file attachment.');
      }
    }
    return this.sendFile({ conversationId, threadType, filePath, filename: videoFilename, caption, quote });
  }

  async undoMessage({ conversationId, threadType, msgId, cliMsgId = 0 }) {
    if (!this.api) throw new Error('Zalo is not connected');
    if (!msgId) throw new Error('Không tìm thấy msgId Zalo của tin nhắn này để thu hồi.');
    return this.api.undo({
      msgId: String(msgId),
      cliMsgId: String(cliMsgId ?? msgId),
    }, String(conversationId), threadType ?? ThreadType.User);
  }

  async sendReaction({ conversationId, threadType, msgId, cliMsgId = 0, reaction = Reactions.HEART }) {
    if (!this.api) throw new Error('Zalo is not connected');
    if (!msgId) throw new Error('Không tìm thấy msgId Zalo của tin nhắn này để thả cảm xúc.');
    return this.api.addReaction(reaction, {
      data: {
        msgId: String(msgId),
        cliMsgId: String(cliMsgId ?? msgId),
      },
      threadId: String(conversationId),
      type: threadType ?? ThreadType.User,
    });
  }
}
