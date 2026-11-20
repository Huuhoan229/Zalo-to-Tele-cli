import { setTimeout as sleep } from 'node:timers/promises';

export function telegramRateLimitSeconds(error) {
  if (Number(error?.response?.error_code ?? error?.code) !== 429) return null;
  const match = String(error?.response?.description || error?.message || '').match(/retry after\s+(\d+)/i);
  const seconds = Number(error?.response?.parameters?.retry_after ?? error?.parameters?.retry_after ?? match?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3;
}

// One queue per destination group, shared by all Zalo accounts and topics on this bot.
export class TelegramGroupQueue {
  constructor({ wait = sleep, now = Date.now } = {}) {
    this.wait = wait;
    this.now = now;
    this.groups = new Map();
  }

  run(chatId, send, signal) {
    const key = String(chatId);
    const group = this.groups.get(key) || { tail: Promise.resolve(), sentAt: [], retryAt: 0 };
    this.groups.set(key, group);
    const task = group.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const now = this.now();
        group.sentAt = group.sentAt.filter((at) => now - at < 61000);
        const due = Math.max(
          now,
          group.retryAt,
          (group.sentAt.at(-1) ?? -Infinity) + 1050,
          group.sentAt.length >= 20 ? group.sentAt[0] + 61000 : 0,
        );
        if (due > now) await this.wait(due - now, undefined, { signal });
        signal?.throwIfAborted();
        group.sentAt.push(this.now());
        try {
          return await send();
        } catch (error) {
          const seconds = telegramRateLimitSeconds(error);
          // Only retry requests explicitly rejected by Telegram, not ambiguous timeouts.
          if (seconds === null) throw error;
          group.retryAt = this.now() + seconds * 1000 + 250;
          if (attempt >= 3 || seconds > 120) throw error;
        }
      }
    });
    group.tail = task.catch(() => {});
    return task;
  }
}
