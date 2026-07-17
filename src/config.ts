/**
 * All bot settings live here — no .env file needed.
 * Edit values below before deploying.
 */

export const config = {
  exchange: {
    apiKey: 'JzfMjbSFHB6VBE5dsXaM7Yju7cc2fiTSopjgH1ToCZ5TF6xk7XBErfQs9dYJ7yro',
    apiSecret: 'jdhK7xHfgLmqKySqaxaR0JbrWiUdT1DFjU5weNZOlzyaAhdr8nNsZEXt93jLEjPz',
    useTestnet: true,
  },
  trading: {
    mode: 'spot' as 'spot' | 'futures',
    /** Liquid majors — better for multi-hour swings than thin mid-caps */
    watchlist: [
      'SOL/USDT',
      'AVAX/USDT',
      'LINK/USDT',
      'ADA/USDT',
      'DOT/USDT',
      'NEAR/USDT',
      'ATOM/USDT',
      'APT/USDT',
      'SUI/USDT',
      'INJ/USDT',
      'AAVE/USDT',
      'UNI/USDT',
    ],
    candleLimit4h: 120,
    candleLimit1h: 120,
    /** Check every 5 minutes — setups are 1h/4h, not 5m noise */
    scanIntervalMs: 300000,
    minOrderUsdt: 10,
    maxOpenPositions: 1,
    tradingCapital: 1000,
    /** Smaller size — one SL shouldn't erase a week of wins */
    maxPositionPercent: 0.35,
  },
  commission: {
    rate: 0.001, // 0.1% per side
  },
  risk: {
    /** Risk ~1% of capital per trade */
    maxRiskPerTrade: 0.01,
    /** Swing targets: fees are tiny vs move size */
    takeProfitPercent: 0.035,
    stopLossPercent: 0.015,
    maxDailyLossPercent: 0.04,
    /** Lock gains after +2%; trail 0.8% — don't cut winners at +0.3% */
    trailingActivationPercent: 0.02,
    trailingStopPercent: 0.008,
  },
  position: {
    /** Allow multi-hour / overnight holds */
    maxHoldHours: 36,
    /** Selective — fewer trades, higher quality */
    minScore: 70,
  },
  api: {
    port: Number(process.env.PORT) || 3000,
  },
} as const;

export function validateConfig(): void {
  if (!config.exchange.apiKey || !config.exchange.apiSecret) {
    throw new Error('Missing Binance API key or secret in src/config.ts');
  }

  if (config.risk.maxRiskPerTrade <= 0 || config.risk.maxRiskPerTrade > 0.05) {
    throw new Error('maxRiskPerTrade must be between 0 and 0.05 (5%)');
  }

  if (config.risk.takeProfitPercent <= 0 || config.risk.stopLossPercent <= 0) {
    throw new Error('takeProfitPercent and stopLossPercent must be positive');
  }

  if (config.trading.maxPositionPercent <= 0 || config.trading.maxPositionPercent > 1) {
    throw new Error('maxPositionPercent must be between 0 and 1');
  }

  if (!config.trading.watchlist.length) {
    throw new Error('watchlist must contain at least one pair');
  }

  for (const pair of config.trading.watchlist) {
    if (!pair.endsWith('/USDT')) {
      throw new Error(`watchlist pairs must be USDT pairs (got ${pair})`);
    }
  }
}
