import pino from 'pino';
import { config } from './config.js';
import { Store } from './store.js';
import { ZaloClient } from './zaloClient.js';
import { TelegramBridgeBot } from './telegramBot.js';

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
  const store = new Store(config.dataFile);
  await store.load();

  const zalo = await new ZaloClient({
    credentialsFile: config.zaloCredentialsFile,
    loginMode: config.zaloLoginMode,
    selfListen: config.zaloSelfListen,
    logger,
  }).connect();

  const telegram = new TelegramBridgeBot({
    config,
    store,
    zalo,
    logger,
  });

  zalo.onMessage((message) => telegram.forwardZaloMessage(message));
  await telegram.start();

  process.once('SIGINT', () => telegram.stop('SIGINT'));
  process.once('SIGTERM', () => telegram.stop('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ error }, 'ChatTeleZola crashed');
  process.exitCode = 1;
});
