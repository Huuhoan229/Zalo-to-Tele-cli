import { Context } from 'telegraf';

// Telegraf's default network timeout is much longer than a management command
// should wait. Bound both the bot client and each update's Context client.
export function boundTelegramApi(telegram, { requestTimeoutMs = 20000, pollingTimeoutMs = 65000 } = {}) {
  const callApi = telegram.callApi.bind(telegram);
  telegram.callApi = async (method, payload, options = {}) => {
    const controller = new AbortController();
    const externalSignal = options?.signal;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    const timeout = method === 'getUpdates' && payload?.timeout > 0 ? pollingTimeoutMs : requestTimeoutMs;
    const timer = setTimeout(abort, timeout);
    timer.unref?.();
    try {
      return await callApi(method, payload, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  };
  return telegram;
}

export class BoundedTelegramContext extends Context {
  constructor(update, telegram, botInfo) {
    super(update, boundTelegramApi(telegram), botInfo);
  }
}

export function normalizedMenuText(text) {
  return String(text || '').normalize('NFC').replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/^[^\p{L}\p{N}/]+/u, '').trim();
}
