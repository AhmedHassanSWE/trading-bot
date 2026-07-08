import { config, validateConfig } from './config';
import { TradingBot } from './bot/engine';
import { startApiServer } from './api/server';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  try {
    validateConfig();
  } catch (err) {
    logger.error(String(err));
    process.exit(1);
  }

  const bot = new TradingBot();
  const apiServer = startApiServer(bot);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    apiServer.close();
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start();
}

main().catch((err) => {
  logger.error('Fatal error', { error: String(err) });
  process.exit(1);
});
