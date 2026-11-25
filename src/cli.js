import pino from 'pino';
import { config } from './config.js';
import { BridgeManager } from './bridgeManager.js';
import { startWebServer } from './webServer.js';
import { webhookHandlers, startTelegramControlBot, stopTelegramControlBot } from './telegramBot.js';

const logger = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true },
        },
});

async function main() {
  const manager = new BridgeManager({
    baseDir: config.rootDir,
    consoleOutput: process.env.NODE_ENV !== 'production',
  });
  await manager.load();
  let telegramControl = null;

  const webServer = startWebServer({
    port: config.webPort,
    accessToken: config.webAccessToken,
    logger,
    webhookHandlers,
    onEvnProbe: async (sendToTelegram = false, pushedReport = null) => {
      const cfg = await manager.getEvnConfig();
      if (pushedReport && pushedReport.customerId && (!cfg.customerId || pushedReport.customerId === cfg.customerId)) {
        await manager.updateEvnConfig({
          customerId: pushedReport.customerId,
          cachedReport: pushedReport,
          enabled: true,
        });
      }
      const nextCfg = await manager.getEvnConfig();
      const configured = Boolean((nextCfg.username && nextCfg.password && nextCfg.customerId) || nextCfg.cachedReport);
      if (!configured) return { ok: false, configured: false, lastError: manager.lastEvnError || null };
      try {
        const { report, text, fromCache } = await manager.fetchEvnReport();
        let weatherText = null;
        if (nextCfg.weatherEnabled !== false && typeof manager.fetchWeatherReport === 'function') {
          try {
            const w = await manager.fetchWeatherReport();
            weatherText = w?.text || null;
          } catch {
            weatherText = null;
          }
        }
        let delivered = null;
        if (sendToTelegram && telegramControl) {
          delivered = await telegramControl.deliverEvnReport({
            report,
            text,
            weatherText,
            config: nextCfg,
            destinations: { privateChat: true, forumTopic: true, zalo: true },
          });
        }
        return {
          ok: true,
          configured: true,
          fromCache: Boolean(fromCache),
          lastLiveError: manager.lastEvnError || null,
          area: report.area,
          latestReadingDate: report.latestReadingDate,
          dailyLatestKwh: report.dailyLatestKwh,
          monthlyKwh: report.monthlyKwh,
          delivered,
        };
      } catch (error) {
        return {
          ok: false,
          configured: true,
          error: String(error?.message || error).slice(0, 300),
        };
      }
    },
    getQrPath: (accountId) => {
      const id = accountId || manager.getState().selectedAccountId;
      return id ? manager.getController(id)?.qrPath : null;
    },
    getStatus: () => {
      const state = manager.getState();
      const accounts = state.accounts.map((account) => {
        const controller = manager.getController(account.id);
        const snapshot = controller?.snapshot() || {};
        return {
          id: account.id,
          label: account.label,
          status: snapshot.status || account.status,
          startedAt: snapshot.startedAt || account.startedAt || null,
          lastError: snapshot.lastError || account.lastError || null,
          lastTelegramError: snapshot.lastTelegramError || null,
          lastAiError: snapshot.lastAiError || null,
          qrImageBase64: snapshot.qrImageBase64 || null,
          listenerConnected: Boolean(snapshot.listenerConnected),
          accountName:
            controller?.zalo?.selfProfile?.displayName ||
            controller?.zalo?.selfProfile?.zaloName ||
            account.label,
          conversationCount: snapshot.conversations?.length || account.conversationCount || 0,
        };
      });
      return {
        status: accounts.some((account) => account.status === 'running') ? 'running' : 'starting',
        accounts,
        selectedAccountId: state.selectedAccountId,
        webAccessProtected: Boolean(config.webAccessToken),
        telegram: telegramControl?.snapshot() || { status: 'connecting' },
      };
    },
    onAddAccount: async (input) => {
      const account = await manager.addAccount(input);
      await manager.startAccount(account.id);
      return manager.publicAccount(account, manager.getController(account.id));
    },
    onReloginAccount: async (id) => {
      await manager.reloginAccount(id);
      return manager.publicAccount(manager.getAccount(id), manager.getController(id));
    },
    onRemoveAccount: (id) => manager.removeAccount(id),
  });

  telegramControl = await startTelegramControlBot({ config, manager, logger });

  async function shutdown(reason) {
    await manager.stopAll(reason);
    stopTelegramControlBot(telegramControl, reason);
    webServer.close();
  }

  await manager.startAll();

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ error }, 'ChatTeleZola crashed');
  process.exitCode = 1;
});
