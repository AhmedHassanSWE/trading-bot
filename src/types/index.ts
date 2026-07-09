export type Side = 'buy' | 'sell';

export type Signal = 'long' | 'short' | 'none';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeSignal {
  signal: Signal;
  price: number;
  reason: string;
  strength: number;
}

export interface PositionSize {
  quantity: number;
  notionalUsdt: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  riskAmount: number;
}

export interface OpenPosition {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  /** Highest price seen since entry (long) or lowest price seen (short) */
  peakPrice: number;
  /** Trailing stop price, updated as price moves in our favor */
  trailingStop: number | null;
}

export interface WalletBalance {
  totalUsdt: number;
  freeUsdt: number;
  usedUsdt: number;
}

export interface PortfolioBalance extends WalletBalance {
  /** Base asset symbol, e.g. BTC */
  baseAsset: string;
  /** Total base asset held (e.g. BTC amount) */
  baseHoldings: number;
  /** Base asset value converted to USDT */
  baseValueUsdt: number;
  /** Total portfolio = USDT + base asset value */
  portfolioValueUsdt: number;
}

export interface BotStats {
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  dailyPnl: number;
  lastTradeAt: number | null;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsdt: number;
  pnlPct: number;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_exit';
  openedAt: number;
  closedAt: number;
  heldMinutes: number;
}

export interface BotEvent {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

export interface DashboardSnapshot {
  startingBalance: number;
  currentBalance: number;
  running: boolean;
  testnet: boolean;
  symbol: string;
  currentPrice: number;
  totalPnl: number;
  totalPnlPct: number;
  openPosition: (OpenPosition & {
    currentPrice: number;
    unrealizedPnlUsdt: number;
    unrealizedPnlPct: number;
    heldMinutes: number;
  }) | null;
  stats: BotStats;
  recentTrades: ClosedTrade[];
  recentEvents: BotEvent[];
  lastSignal: TradeSignal | null;
  updatedAt: number;
}
