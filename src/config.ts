import dotenv from 'dotenv';

dotenv.config();

function parseFloatEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for ${key}: ${value}`);
  }
  return parsed;
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

export const config = {
  exchange: {
    apiKey: process.env.BINANCE_API_KEY ?? '',
    apiSecret: process.env.BINANCE_API_SECRET ?? '',
    useTestnet: parseBoolEnv('USE_TESTNET', true),
  },
  trading: {
    mode: (process.env.TRADING_MODE ?? 'spot') as 'spot' | 'futures',
    symbol: process.env.SYMBOL ?? 'BTC/USDT',
    timeframe: process.env.TIMEFRAME ?? '1m',
    candleLimit: Math.floor(parseFloatEnv('CANDLE_LIMIT', 100)),
    scanIntervalMs: Math.floor(parseFloatEnv('SCAN_INTERVAL_MS', 15000)),
    minOrderUsdt: parseFloatEnv('MIN_ORDER_USDT', 10),
    maxOpenPositions: Math.floor(parseFloatEnv('MAX_OPEN_POSITIONS', 1)),
  },
  risk: {
    maxRiskPerTrade: parseFloatEnv('MAX_RISK_PER_TRADE', 0.002),
    takeProfitMin: parseFloatEnv('TAKE_PROFIT_MIN', 0.01),
    takeProfitMax: parseFloatEnv('TAKE_PROFIT_MAX', 0.02),
    stopLossPercent: parseFloatEnv('STOP_LOSS_PERCENT', 0.002),
    maxDailyLossPercent: parseFloatEnv('MAX_DAILY_LOSS_PERCENT', 0.02),
    trailingActivationPercent: parseFloatEnv('TRAILING_ACTIVATION_PERCENT', 0.005),
    trailingStopPercent: parseFloatEnv('TRAILING_STOP_PERCENT', 0.003),
  },
  position: {
    maxHoldHours: parseFloatEnv('MAX_HOLD_HOURS', 6),
    minSignalStrength: parseFloatEnv('MIN_SIGNAL_STRENGTH', 0.60),
  },
  api: {
    port: Math.floor(parseFloatEnv('API_PORT', 3000)),
  },
} as const;

export function validateConfig(): void {
  if (!config.exchange.apiKey || !config.exchange.apiSecret) {
    throw new Error(
      'Missing BINANCE_API_KEY or BINANCE_API_SECRET. Copy .env.example to .env and fill in your keys.'
    );
  }

  if (config.risk.maxRiskPerTrade <= 0 || config.risk.maxRiskPerTrade > 0.05) {
    throw new Error('MAX_RISK_PER_TRADE must be between 0 and 5% (0.05)');
  }

  if (config.risk.takeProfitMin >= config.risk.takeProfitMax) {
    throw new Error('TAKE_PROFIT_MIN must be less than TAKE_PROFIT_MAX');
  }
}
