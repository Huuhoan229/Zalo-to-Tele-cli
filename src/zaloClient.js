import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LoginQRCallbackEventType, Zalo, ThreadType } from 'zca-js';
import { imageMetadataGetter } from './media.js';

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
  if (!value && !/sticker/i.test(String(messageType))) return null;
  const params = parseObject(value?.params);
  const sticker = value?.sticker || value?.stickerInfo ||
    (String(value?.type || '').toLowerCase() === 'sticker' ? value : null) ||
    (/sticker/i.test(String(messageType)) ? params?.sticker || params || value || {} : null);
  const href =
    value?.href ||
    value?.thumb ||
    value?.previewUrl ||
    value?.url ||
    sticker?.url ||
    sticker?.href ||
    sticker?.staticUrl ||
    sticker?.gifUrl ||
    sticker?.stickerUrl ||
    sticker?.stickerWebpUrl;
  const stickerId = sticker?.stickerId || sticker?.sticker_id || sticker?.id || value?.stickerId || value?.sticker_id;
  const isSticker = Boolean(sticker || /sticker/i.test(String(messageType)));
  if (!href && !stickerId && !isSticker) return null;
  return {
    url: href || null,
    stickerId: stickerId ? Number(stickerId) || String(stickerId) : null,
    title: isSticker ? 'sticker' : value?.title || value?.fileName || 'attachment',
    type: isSticker ? 'sticker' : 'file',
    raw: value || content,
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

    this.api.listener.start({ retryOnClose: false });
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

  async sendText({ conversationId, threadType, text, quote = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    await this.api.sendMessage({ msg: text, ...(quote ? { quote } : {}) }, conversationId, threadType);
  }

  async sendImage({ conversationId, threadType, filePath, caption, quote = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const payload = {
      msg: caption || '',
      attachments: [path.resolve(filePath)],
      ...(quote ? { quote } : {}),
    };
    await this.api.sendMessage(payload, conversationId, threadType);
  }
}
