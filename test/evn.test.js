import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  calcElectricityCost,
  computeBillingRange,
  fetchEvnUsage,
  formatEvnReport,
} from '../src/evn.js';
import { BridgeManager } from '../src/bridgeManager.js';
import { TelegramBridgeBot, startTelegramControlBot, stopTelegramControlBot } from '../src/telegramBot.js';
import { TelegramGroupQueue } from '../src/telegramGroupQueue.js';

const noWait = async () => {};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('EVNHANOI client logs in, fetches daily readings + debt, and computes 6-tier residential cost', async () => {
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url, method: options.method, body: options.body });
    if (url.includes('cskh.evn.com.vn/cskh/v1/auth/login')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          accessToken: 'cskh-jwt-token',
          data: {
            maDviqly: 'HN0400',
            maKhang: 'PD01001234567',
            tenKhang: 'Nguyễn Văn A',
            diaChi: 'Hà Nội',
            maDviCaptct: 'HN',
          },
        },
      }), { status: 200 });
    }
    if (url.includes('/api/evn/customers/diemdo')) {
      return new Response(JSON.stringify({
        success: true,
        data: [{ MA_KHANG: 'PD01001234567', MA_DDO: 'PD01001234567001' }],
      }), { status: 200 });
    }
    if (url.includes('/api/evn/tracuu/diennangngay')) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.MA_DDO, 'PD01001234567001');
      return new Response(JSON.stringify({
        success: true,
        data: [
          { NGAY: '01/11/2026', NGAY_HTHI: '01/11/2026', CHI_SO: 1000.00, DIEN_TTHU: 210.00 },
          { NGAY: '23/11/2026', NGAY_HTHI: '23/11/2026', CHI_SO: 1210.00, DIEN_TTHU: 10.50 },
          { NGAY: '24/11/2026', NGAY_HTHI: '24/11/2026', CHI_SO: 1220.50, DIEN_TTHU: 12.50 },
        ],
      }), { status: 200 });
    }
    if (url.includes('/api/evn/tracuu/hoadon-thanhtoan')) {
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const now = new Date('2026-11-24T23:05:00Z'); // 06:05 AM 25/11/2026 Vietnam time
  const report = await fetchEvnUsage({
    username: '0912345678',
    password: 'secret-password',
    customerId: 'pd01001234567',
    billingStartDay: 1,
    fetchImpl: fakeFetch,
    now,
  });

  assert.equal(report.area, 'EVNHANOI');
  assert.equal(report.customerId, 'PD01001234567');
  assert.equal(report.latestReadingDate, '24/11/2026');
  assert.equal(report.previousReadingDate, '23/11/2026');
  assert.equal(report.dailyLatestKwh, 12.5);
  assert.equal(report.dailyPreviousKwh, 10.5);
  assert.equal(report.monthlyKwh, 233);
  assert.equal(report.paymentStatus, 'Đã thanh toán');
  assert.equal(report.monthlyCost.tiers.length, 4);

  const expectedCost = calcElectricityCost(233);
  assert.equal(report.monthlyCost.total, expectedCost.total);

  const text = formatEvnReport(report);
  assert.match(text, /PD01001234567/);
  assert.match(text, /24\/11\/2026\): 12\.5 kWh/);
  assert.match(text, /\+2 kWh/);
  assert.match(text, /Tổng điện từ đầu kỳ: 233 kWh/);
  assert.match(text, /Đã thanh toán/);
});

test('6:00 AM Vietnam time scheduler delivers EVN report to all 3 destinations once per day', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evn-sched-'));
  const manager = new BridgeManager({ baseDir: dir });
  await manager.load();

  await manager.updateEvnConfig({
    enabled: true,
    username: '0912345678',
    password: 'pw',
    customerId: 'PD01001234567',
    billingStartDay: 1,
    reportHour: 6,
    zaloAccountId: 'zalo1',
    zaloConversationId: 'family-group-1',
    zaloConversationTitle: 'Gia đình',
  });

  manager.evnFetcher = async () => ({
    area: 'EVNHANOI',
    customerId: 'PD01001234567',
    fromDate: '01/11/2026',
    toDate: '24/11/2026',
    latestReadingDate: '24/11/2026',
    previousReadingDate: '23/11/2026',
    meterStart: 100,
    meterLatest: 220,
    dailyLatestKwh: 8.5,
    dailyPreviousKwh: 7.5,
    monthlyKwh: 120,
    dailyLatestCost: 22000,
    monthlyCost: calcElectricityCost(120),
    paymentStatus: 'Đã thanh toán',
    unpaidAmount: 0,
  });

  manager.weatherFetcher = async () => ({
    locationName: 'Hà Nội',
    displayDate: '25/11/2026',
    current: { temperature: 22, feelsLike: 22, humidity: 70, windSpeed: 10, icon: '🌤', text: 'Trời ít mây' },
    today: { minTemp: 18, maxTemp: 26, feelsMin: 18, feelsMax: 26, rainProbMax: 15, rainSum: 0, uvMax: 5, sunrise: '06:10', sunset: '17:15', icon: '🌤', text: 'Trời ít mây' },
    periods: {},
    tomorrow: null,
    tips: ['✨ Thời tiết dễ chịu'],
  });

  const zaloSent = [];
  manager.controllers.set('zalo1', {
    status: 'running',
    stop: async () => {},
    store: { getByConversation: () => ({ conversationId: 'family-group-1', threadType: 1, topicId: 55, title: 'Gia đình' }) },
    registerPendingEcho: () => {},
    consumePendingEcho: () => {},
    zalo: {
      sendText: async (payload) => { zaloSent.push(payload); return { msgId: 'z1' }; },
    },
  });

  const config = {
    telegramBotToken: '889:evn-schedule-test',
    telegramForumChatId: -10099,
    telegramAdminIds: new Set([111]),
    allowedTelegramUserIds: new Set([111]),
    accountId: 'zalo1',
    accountLabel: 'Zalo HJ',
    downloadDir: dir,
  };
  const bridge = new TelegramBridgeBot({
    config,
    store: { getByTopic: () => null, listMappings: () => [] },
    zalo: {},
    logger,
  });
  const runtime = bridge.runtime;
  runtime.groupQueue = new TelegramGroupQueue({ wait: noWait, transientDelaysMs: [1, 1] });
  runtime.addBridge(bridge);
  runtime.bot.launch = (_opts, ready) => { ready(); return new Promise(() => {}); };
  runtime.bot.telegram.setMyCommands = async () => {};

  const tgMessages = [];
  const createdTopics = [];
  runtime.bot.telegram.createForumTopic = async (chatId, name) => {
    createdTopics.push({ chatId, name });
    return { message_thread_id: 909 };
  };
  runtime.bot.telegram.sendMessage = async (chatId, text, options) => {
    tgMessages.push({ chatId, text, options });
    return { message_id: tgMessages.length };
  };

  try {
    await startTelegramControlBot({ config, manager, logger });

    // At 05:30 AM Vietnam time (22:30 UTC previous day) -> outside window
    const before6am = new Date('2026-11-24T22:30:00Z');
    const early = await runtime.checkEvnSchedule(before6am);
    assert.equal(early.skipped, 'outside-window');

    // At 06:00 AM Vietnam time (23:00 UTC previous day) -> delivers to all 3 places!
    const at6am = new Date('2026-11-24T23:00:00Z');
    const run1 = await runtime.checkEvnSchedule(at6am);
    assert.equal(run1.delivered, true);
    assert.equal(run1.delivery.privateChat, true);
    assert.equal(run1.delivery.forumTopic, true);
    assert.equal(run1.delivery.zalo, true);

    // Verify all 3 destinations received 2 separate messages (1 EVN + 1 Weather)
    assert.equal(createdTopics.length, 1);
    assert.match(createdTopics[0].name, /Điện lực EVNHANOI/);
    const privateMsgs = tgMessages.filter((m) => m.chatId === 111);
    const topicMsgs = tgMessages.filter((m) => m.chatId === -10099 && m.options?.message_thread_id === 909);
    assert.equal(privateMsgs.length, 2, 'admin private chat must receive 2 separate messages');
    assert.match(privateMsgs[0].text, /BÁO CÁO ĐIỆN NĂNG EVNHANOI/);
    assert.match(privateMsgs[1].text, /DỰ BÁO THỜI TIẾT HÔM NAY/);
    assert.equal(topicMsgs.length, 2, 'dedicated Telegram forum topic must receive 2 separate messages');
    assert.equal(zaloSent.length, 2, 'Zalo conversation must receive 2 separate messages');
    assert.equal(zaloSent[0].conversationId, 'family-group-1');
    assert.match(zaloSent[0].text, /BÁO CÁO ĐIỆN NĂNG EVNHANOI/);
    assert.match(zaloSent[1].text, /DỰ BÁO THỜI TIẾT HÔM NAY/);

    // Subsequent check at 06:15 AM same day -> skipped (no duplicate)
    const at615am = new Date('2026-11-24T23:15:00Z');
    const run2 = await runtime.checkEvnSchedule(at615am);
    assert.equal(run2.skipped, 'already-sent-today');
    assert.equal(zaloSent.length, 2);
  } finally {
    stopTelegramControlBot(runtime);
    runtime.removeBridge(bridge);
    await manager.stopAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('computeBillingRange handles start-of-month and mid-month billing cycles across year boundary', () => {
  const rangeNov = computeBillingRange(1, new Date('2026-11-24T23:00:00Z')); // 25/11 VN
  assert.equal(rangeNov.fromDate, '01/11/2026');
  assert.equal(rangeNov.toDate, '25/11/2026');

  const rangeJanEarly = computeBillingRange(10, new Date('2026-01-05T00:00:00Z')); // 05/01 VN <= 10 -> Dec prev year
  assert.equal(rangeJanEarly.fromDate, '10/12/2025');
  assert.equal(rangeJanEarly.toDate, '05/01/2026');
});
