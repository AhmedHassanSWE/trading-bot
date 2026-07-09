import {
  BotEvent,
  BotStats,
  ClosedTrade,
  OpenPosition,
  TradeSignal,
} from '../types';

export interface BotPersistentState {
  openPosition: OpenPosition | null;
  lastSignal: TradeSignal | null;
  trades: ClosedTrade[];
  events: BotEvent[];
  stats: BotStats;
  dayStart: string;
  running: boolean;
  exchangeInitialized: boolean;
}

export function createEmptyState(): BotPersistentState {
  return {
    openPosition: null,
    lastSignal: null,
    trades: [],
    events: [],
    stats: {
      tradesToday: 0,
      winsToday: 0,
      lossesToday: 0,
      dailyPnl: 0,
      lastTradeAt: null,
    },
    dayStart: new Date().toISOString().slice(0, 10),
    running: false,
    exchangeInitialized: false,
  };
}
