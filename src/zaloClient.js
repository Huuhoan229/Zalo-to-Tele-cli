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

function formatCallDuration(secondsInput) {
  let seconds = Math.round(Number(secondsInput) || 0);
  if (seconds > 36000) seconds = Math.round(seconds / 1000);
  if (seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0 && secs > 0) return `${mins} phút ${secs} giây`;
  if (mins > 0) return `${mins} phút`;
  return `${secs} giây`;
}

export function pickText(content, messageData = null, isSelf = false) {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return trimmed;
    const parsed = parseObject(trimmed);
    if (!parsed) return trimmed;
    content = parsed;
  }
  const obj = parseObject(content) || {};
  const params = parseObject(obj.params) || parseObject(obj.item) || {};
  const msgType = String(messageData?.msgType || obj.msgType || '').toLowerCase();
  const action = String(obj.action || params.action || '').toLowerCase();
  const subType = String(obj.type || params.type || '').toLowerCase();
  const titleAndDesc = `${obj.title || ''} ${obj.description || ''} ${params.title || ''} ${params.description || ''} ${messageData?.notify || ''}`.trim();

  const isCall =
    /call|voip/.test(msgType) ||
    /call|voip/.test(action) ||
    /call|voip/.test(subType) ||
    obj.callId !== undefined ||
    obj.call_id !== undefined ||
    params.callId !== undefined ||
    params.call_id !== undefined ||
    params.calltype !== undefined ||
    params.callType !== undefined ||
    /cuộc gọi|gọi nhỡ|gọi thoại|gọi video|missed call|video call|voice call/i.test(titleAndDesc);

  if (isCall) {
    const isVideo = Boolean(
      obj.isVideo ||
      params.isVideo ||
      obj.video ||
      params.video ||
      Number(obj.callType ?? params.callType ?? params.calltype) === 2 ||
      /video/i.test(`${msgType} ${action} ${subType} ${titleAndDesc}`),
    );
    const durationSec = Number(
      params.duration ?? obj.duration ?? params.callDuration ?? obj.callDuration ?? 0,
    );
    const durationLabel = formatCallDuration(durationSec);
    if (durationLabel) {
      return `${isVideo ? '📹 Cuộc gọi video Zalo' : '📞 Cuộc gọi thoại Zalo'} (${durationLabel})`;
    }
    if (isSelf) {
      return isVideo
        ? '📹 Bạn đã gọi video trên Zalo (không bắt máy)'
        : '📞 Bạn đã gọi trên Zalo (không bắt máy)';
    }
    return isVideo
      ? '📹 Cuộc gọi video nhỡ trên Zalo'
      : '📞 Cuộc gọi nhỡ trên Zalo';
  }

  if (/location/.test(msgType) || (params.lat !== undefined && (params.lon !== undefined || params.lng !== undefined))) {
    const lat = params.lat ?? obj.lat;
    const lon = params.lon ?? params.lng ?? obj.lon ?? obj.lng;
    const address = obj.title || obj.description || params.address || params.name || '';
    const mapLink = lat && lon ? `\nhttps://maps.google.com/?q=${lat},${lon}` : '';
    return `📍 Đã chia sẻ vị trí${address ? `: ${address}` : ''}${mapLink}`;
  }

  if (/poll/.test(msgType) || /poll/.test(action)) {
    const q = obj.title || params.question || obj.description || '';
    return `📊 Bình chọn trong nhóm${q ? `: ${q}` : ''}`;
  }

  if (/todo/.test(msgType) || /todo|reminder/.test(action)) {
    const item = parseObject(params.item);
    const todoText = item?.content || params.content || obj.title || obj.description || '';
    return `📅 Nhắc hẹn / Công việc${todoText ? `: ${todoText}` : ''}`;
  }

  if (/recommened\.user|vcard|contact/.test(`${msgType} ${action}`)) {
    const name = obj.title || params.displayName || params.name || obj.description || '';
    const phone = params.phone || params.phoneNumber || '';
    return `👤 Đã gửi danh thiếp Zalo${name ? `: ${name}` : ''}${phone ? ` (${phone})` : ''}`;
  }

  if (/doodle/.test(msgType)) return '🎨 Hình vẽ tay trên Zalo';
  if (/ecard/.test(msgType)) return '🎉 Thiệp chúc mừng trên Zalo';

  const direct =
    obj.title ||
    obj.href ||
    obj.description ||
    obj.text ||
    obj.msg ||
    params.title ||
    params.description ||
    params.text ||
    params.msg ||
    messageData?.notify ||
    '';
  return String(direct || '').trim();
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

function foldVietnamese(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses @all and @MemberName mentions in a text message for a Zalo group.
 * Supports:
 *  - @all, @All, @mọi người, @moinguoi -> uid: "-1" (tag all group members)
 *  - bare "@" when replying to a message -> expands to "@<RepliedSenderName>"
 *  - @<FullName> or @<GivenName> (with or without Vietnamese diacritics)
 */
export function buildZaloMentions(inputText, participants = [], repliedParticipant = null) {
  let text = String(inputText ?? '');
  if (!text || !text.includes('@')) return { text, mentions: [] };

  // 1. Expand bare "@" (e.g. "@ kiểm tra giúp nhé") when replying to a group member
  if (repliedParticipant?.uid && repliedParticipant?.name && String(repliedParticipant.uid) !== '0') {
    text = text.replace(/(^|\s)@(?=\s|[,.!?:;]|$)/g, `$1@${repliedParticipant.name}`);
  }

  // Merge unique participants (repliedParticipant first)
  const pool = [];
  const seenUids = new Set();
  const addCandidate = (p) => {
    const uid = String(p?.uid || '').trim();
    const name = String(p?.name || '').trim();
    if (!uid || uid === '0' || !name || name === 'Tôi' || name === 'AI' || seenUids.has(uid)) return;
    seenUids.add(uid);
    const words = name.split(/\s+/).filter(Boolean);
    const lastWord = words.at(-1) || '';
    const lastTwoWords = words.length >= 2 ? words.slice(-2).join(' ') : '';
    const aliases = [...new Set([name, lastTwoWords, lastWord].filter((a) => a && a.length >= 2))];
    pool.push({ uid, name, aliases });
  };
  if (repliedParticipant) addCandidate(repliedParticipant);
  for (const p of participants || []) addCandidate(p);

  // 2. Replace shorthand @alias (including accent-insensitive) with full @DisplayName
  const aliasEntries = [];
  for (const member of pool) {
    for (const alias of member.aliases) {
      aliasEntries.push({
        uid: member.uid,
        fullName: member.name,
        alias,
        foldedAlias: foldVietnamese(alias),
      });
    }
  }
  aliasEntries.sort((a, b) => b.alias.length - a.alias.length);

  // Scan "@" positions to expand shorthand aliases to canonical "@fullName"
  let cursor = 0;
  while (cursor < text.length) {
    const atIdx = text.indexOf('@', cursor);
    if (atIdx === -1) break;
    if (atIdx > 0 && /[\p{L}\p{N}_]/u.test(text[atIdx - 1])) {
      cursor = atIdx + 1;
      continue;
    }
    const afterAt = text.slice(atIdx + 1);
    const foldedAfter = foldVietnamese(afterAt);
    if (/^(?:all|moi\s*nguoi)(?=$|[^\p{L}\p{N}_])/iu.test(foldedAfter)) {
      cursor = atIdx + 4;
      continue;
    }
    let matchedEntry = null;
    for (const entry of aliasEntries) {
      if (foldedAfter.startsWith(entry.foldedAlias)) {
        const boundaryChar = afterAt[entry.alias.length] || '';
        if (!boundaryChar || !/[\p{L}\p{N}_]/u.test(boundaryChar)) {
          matchedEntry = entry;
          break;
        }
      }
    }
    if (matchedEntry) {
      const replacement = `@${matchedEntry.fullName}`;
      text = text.slice(0, atIdx) + replacement + text.slice(atIdx + 1 + matchedEntry.alias.length);
      cursor = atIdx + replacement.length;
    } else {
      cursor = atIdx + 1;
    }
  }

  // 3. Collect exact { pos, len, uid } mentions on the final text
  const mentions = [];
  const occupied = [];
  const isOverlapping = (start, end) => occupied.some(([s, e]) => start < e && end > s);

  const allRegex = /(^|[^\p{L}\p{N}_])(@(?:all|mọi\s*người|moi\s*nguoi))(?=$|[^\p{L}\p{N}_])/giu;
  let allMatch;
  while ((allMatch = allRegex.exec(text)) !== null) {
    const prefixLen = allMatch[1].length;
    const token = allMatch[2];
    const pos = allMatch.index + prefixLen;
    const len = token.length;
    if (!isOverlapping(pos, pos + len)) {
      occupied.push([pos, pos + len]);
      mentions.push({ pos, len, uid: '-1' });
    }
  }

  const membersByNameLen = [...pool].sort((a, b) => b.name.length - a.name.length);
  for (const member of membersByNameLen) {
    const tagToken = `@${member.name}`;
    const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegex(tagToken)})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    let m;
    while ((m = regex.exec(text)) !== null) {
      const pos = m.index + m[1].length;
      const len = m[2].length;
      if (!isOverlapping(pos, pos + len)) {
        occupied.push([pos, pos + len]);
        mentions.push({ pos, len, uid: String(member.uid) });
      }
    }
  }

  mentions.sort((a, b) => a.pos - b.pos);
  return { text, mentions };
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
      uidFrom: data.uidFrom !== undefined && data.uidFrom !== null ? String(data.uidFrom) : null,
      senderName: isSelf ? 'Tôi' : (data.dName || data.uidFrom || 'Zalo'),
      rIcon: typeof content.rIcon === 'string' ? content.rIcon : '',
      rType: content.rType,
      targets,
      raw: reaction,
    };
  }

  async resolveUserName(uid, conversationId = null) {
    const cleanUid = String(uid || '').trim();
    if (!cleanUid || cleanUid === '0') return null;
    if (this.selfUserId && cleanUid === String(this.selfUserId)) return 'Tôi';
    this.userNameCache ||= new Map();
    if (this.userNameCache.has(cleanUid)) return this.userNameCache.get(cleanUid);
    if (conversationId && this.groupMembersCache?.has(String(conversationId))) {
      const found = this.groupMembersCache.get(String(conversationId))?.members?.find((m) => String(m.uid) === cleanUid);
      if (found?.name) {
        this.userNameCache.set(cleanUid, found.name);
        return found.name;
      }
    }
    if (typeof this.api?.getUserInfo === 'function') {
      try {
        const info = await this.api.getUserInfo([cleanUid]);
        const profiles = info?.changed_profiles || info || {};
        const profile = profiles[cleanUid] || profiles[`${cleanUid}_0`];
        const name = String(profile?.displayName || profile?.zaloName || '').trim();
        if (name) {
          this.userNameCache.set(cleanUid, name);
          return name;
        }
      } catch {
        // Ignore lookup error
      }
    }
    return null;
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
    const rawMentions = Array.isArray(message.data?.mentions) ? message.data.mentions : [];
    const mentionsSelf = Boolean(
      this.selfUserId && rawMentions.some((item) => String(item?.uid) === String(this.selfUserId)),
    );
    const mentionsAll = rawMentions.some((item) => String(item?.uid) === '-1' || Number(item?.type) === 1);

    return {
      id: message.data?.msgId || message.messageId || `${message.threadId}-${Date.now()}`,
      conversationId: String(message.threadId),
      threadType: message.type,
      isGroup,
      isSelf,
      mentionsSelf,
      mentionsAll,
      senderName: isSelf ? 'Tôi' : pickSenderName(message),
      title: await this.resolveConversationTitle(message, isGroup, isSelf),
      text: attachment?.type === 'sticker' ? '' : pickText(content, message.data, isSelf),
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

  async fetchGroupMembers(groupId) {
    if (!this.api?.getGroupInfo) return [];
    const key = String(groupId || '');
    if (!key) return [];
    this.groupMembersCache ||= new Map();
    const cached = this.groupMembersCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.members;

    try {
      const response = await this.api.getGroupInfo(key);
      const group = response?.gridInfoMap?.[key];
      const rawList = Array.isArray(group?.memVerList)
        ? group.memVerList
        : Array.isArray(group?.memberIds)
          ? group.memberIds
          : [];
      const memberIds = [...new Set(rawList.map((item) => String(item || '').split('_')[0]).filter(Boolean))].slice(0, 50);
      const members = [];
      if (memberIds.length > 0 && typeof this.api.getUserInfo === 'function') {
        const info = await this.api.getUserInfo(memberIds);
        const profiles = info?.changed_profiles || info || {};
        for (const uid of memberIds) {
          const profile = profiles[uid] || profiles[`${uid}_0`];
          const name = String(profile?.displayName || profile?.zaloName || '').trim();
          if (name && uid !== String(this.selfUserId || '')) {
            members.push({ uid: String(uid), name });
          }
        }
      }
      this.groupMembersCache.set(key, { members, expiresAt: Date.now() + 10 * 60 * 1000 });
      return members;
    } catch (error) {
      this.logger?.debug?.({ error, groupId: key }, 'Could not fetch Zalo group members for mention lookup.');
      return [];
    }
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

  async sendText({ conversationId, threadType, text, quote = null, mentions = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const validQuote = this.prepareQuote(quote);
    const validMentions = Array.isArray(mentions) && mentions.length > 0 ? mentions : null;
    const response = await this.api.sendMessage({
      msg: text,
      ...(validQuote ? { quote: validQuote } : {}),
      ...(validMentions ? { mentions: validMentions } : {}),
    }, conversationId, threadType);
    return extractSentIds(response);
  }

  async sendImage({ conversationId, threadType, filePath, caption, quote = null, mentions = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const validQuote = this.prepareQuote(quote);
    const validMentions = Array.isArray(mentions) && mentions.length > 0 ? mentions : null;
    const payload = {
      msg: caption || '',
      attachments: [path.resolve(filePath)],
      ...(validQuote ? { quote: validQuote } : {}),
      ...(validMentions ? { mentions: validMentions } : {}),
    };
    const response = await this.api.sendMessage(payload, conversationId, threadType);
    return extractSentIds(response);
  }

  async sendFile({ conversationId, threadType, filePath, filename, caption, quote = null, mentions = null }) {
    if (!this.api) throw new Error('Zalo is not connected');
    const data = await fs.readFile(filePath);
    const validQuote = this.prepareQuote(quote);
    const validMentions = Array.isArray(mentions) && mentions.length > 0 ? mentions : null;
    const response = await this.api.sendMessage({
      msg: caption || '',
      attachments: [{
        data,
        filename: safeFilename(filename, path.basename(filePath)),
        metadata: { totalSize: data.length },
      }],
      ...(validQuote ? { quote: validQuote } : {}),
      ...(validMentions ? { mentions: validMentions } : {}),
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
