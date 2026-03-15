import 'dotenv/config';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';
import { createTelegramBot } from './bot/index.js';
import { AgentOrchestrator } from './services/agent/orchestrator.js';
import { runDailyFeeAccrual } from './services/fees/accrual.js';
import { startTonPricePolling } from './services/market/tonPriceCache.js';

async function main(): Promise<void> {
  const config = getConfig();
  const app = createServer();
  const bot = createTelegramBot();
  const orchestrator = new AgentOrchestrator();

  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'HTTP API listening');
  });

  bot.start({
    onStart: () => logger.info('Telegram bot polling started')
  });
  await startTonPricePolling(1000);

  await orchestrator.runCycle('startup');
  await runDailyFeeAccrual();

  setInterval(() => {
    void orchestrator.runCycle('schedule');
  }, 15 * 60 * 1000);

  setInterval(() => {
    void runDailyFeeAccrual();
  }, 24 * 60 * 60 * 1000);
}

main().catch((error) => {
  logger.error({ err: (error as Error).message }, 'Fatal startup error');
  process.exit(1);
});
