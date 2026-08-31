import pino from 'pino';
import { config } from './config.js';
import { BridgeController } from './bridgeController.js';
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
  const account = {
    id: 'primary',
    label: 'Primary',
    telegramBotToken: config.telegramBotToken,
    telegramForumChatId: config.telegramForumChatId,
    allowedTelegramUserIds: [...config.allowedTelegramUserIds].join(','),
    mongoUri: config.mongoUri,
    mongoDbName: config.mongoDbName,
    mongoCollectionName: config.mongoCollectionName,
    zaloLoginMode: config.zaloLoginMode,
    zaloSelfListen: config.zaloSelfListen,
    zaloCredentialsFile: config.zaloCredentialsFile,
    dataFile: config.dataFile,
    downloadDir: config.downloadDir,
    localIngestUrl: config.localIngestUrl,
    localIngestToken: config.localIngestToken,
    localIngestZaloTitle: config.localIngestZaloTitle,
    autoStart: true,
    enabled: true,
  };

  const controller = new BridgeController(account, {
    logger,
  });

  const webServer = startWebServer({
    port: config.webPort,
    accessToken: config.webAccessToken,
    logger,
    getQrPath: () => controller.qrPath,
    getStatus: () => ({
      status: controller.status,
      startedAt: controller.startedAt,
      lastError: controller.lastError,
      qrImageBase64: controller.qrImageBase64,
      listenerConnected: controller.listenerConnected,
      accountName: controller.zalo?.selfProfile?.displayName || controller.zalo?.selfProfile?.zaloName || account.label,
      webAccessProtected: Boolean(config.webAccessToken),
    }),
  });

  async function shutdown(reason) {
    await controller.stop(reason);
    webServer.close();
  }

  await controller.start();

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ error }, 'ChatTeleZola crashed');
  process.exitCode = 1;
});
