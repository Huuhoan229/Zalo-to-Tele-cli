import pino from 'pino';
import { config } from './config.js';
import { Store } from './store.js';
import { ZaloClient } from './zaloClient.js';
import { TelegramBridgeBot } from './telegramBot.js';
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
  const runtime = {
    status: 'starting',
    startedAt: new Date().toISOString(),
    zaloStatus: 'starting',
    telegramStatus: 'stopped',
    accountName: null,
    lastError: null,
    qrPath: null,
  };

  const webServer = startWebServer({
    port: config.webPort,
    accessToken: config.webAccessToken,
    logger,
    getQrPath: () => runtime.qrPath,
    getStatus: () => ({
      status: runtime.status,
      startedAt: runtime.startedAt,
      zaloStatus: runtime.zaloStatus,
      telegramStatus: runtime.telegramStatus,
      accountName: runtime.accountName,
      lastError: runtime.lastError,
      webAccessProtected: Boolean(config.webAccessToken),
    }),
  });

  const store = new Store(config.dataFile);
  await store.load();

  const zalo = new ZaloClient({
    credentialsFile: config.zaloCredentialsFile,
    loginMode: config.zaloLoginMode,
    selfListen: config.zaloSelfListen,
    logger,
  });

  zalo.on('qr', ({ qrPath }) => {
    runtime.status = 'waiting-zalo-qr';
    runtime.zaloStatus = 'waiting-qr';
    runtime.qrPath = qrPath;
  });

  zalo.on('qrScanned', ({ account }) => {
    runtime.status = 'waiting-zalo-confirm';
    runtime.zaloStatus = 'qr-scanned';
    runtime.accountName = account || runtime.accountName;
  });

  zalo.on('credentialsSaved', () => {
    runtime.status = 'starting';
    runtime.zaloStatus = 'credentials-saved';
    runtime.qrPath = null;
  });

  await zalo.connect();
  runtime.zaloStatus = 'connected';
  runtime.accountName =
    zalo.selfProfile?.displayName || zalo.selfProfile?.zaloName || runtime.accountName || null;

  const telegram = new TelegramBridgeBot({
    config,
    store,
    zalo,
    logger,
  });

  zalo.onMessage((message) => telegram.forwardZaloMessage(message));
  await telegram.start();
  runtime.telegramStatus = 'running';
  runtime.status = 'running';

  function shutdown(reason) {
    runtime.status = 'stopping';
    telegram.stop(reason);
    webServer.close();
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ error }, 'ChatTeleZola crashed');
  process.exitCode = 1;
});
