import pino from 'pino';
import { config } from './config.js';
import { BridgeManager } from './bridgeManager.js';
import { startWebServer } from './webServer.js';

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

  const webServer = startWebServer({
    port: config.webPort,
    accessToken: config.webAccessToken,
    logger,
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
      };
    },
  });

  async function shutdown(reason) {
    await manager.stopAll(reason);
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
