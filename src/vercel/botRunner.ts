import { TradingBot } from '../bot/engine';
import { loadBotState, saveBotState, isKvConfigured } from '../store/kvStore';
import { BotPersistentState } from '../store/persistentState';
import { DashboardSnapshot } from '../types';

function isFirstRun(state: BotPersistentState): boolean {
  return !state.exchangeInitialized && !state.trades.length && !state.openPosition;
}

async function withBot(runTick: boolean): Promise<DashboardSnapshot> {
  const state = await loadBotState();
  const bot = new TradingBot();
  bot.loadState(state);

  await bot.ensureInitialized(state.exchangeInitialized);

  if (runTick) {
    if (isFirstRun(state)) {
      await bot.bootstrapOnVercel(isKvConfigured());
    }
    await bot.runTick();
  } else {
    bot.markRunning();
  }

  const snapshot = await bot.getDashboardSnapshot();
  await saveBotState(bot.exportState());
  return snapshot;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  return withBot(false);
}

export async function runBotCron(): Promise<DashboardSnapshot> {
  return withBot(true);
}

export { isKvConfigured };
