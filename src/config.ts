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
    // Top 10 liquid USDT pairs — bot scans all and trades the strongest signal
    watchlist: [
      'BTC/USDT',
      'ETH/USDT',
      'SOL/USDT',
      'BNB/USDT',
      'XRP/USDT',
      'DOGE/USDT',
      'ADA/USDT',
      'AVAX/USDT',
      'LINK/USDT',
      'DOT/USDT',
    ],
    /** Candle limits per timeframe (need ≥210 for EMA200) */
    candleLimit1h:  250,
    candleLimit15m: 250,
    candleLimit5m:  250,
    /** How often to scan in milliseconds (every 5 minutes matches the 5m candle close) */
    scanIntervalMs: 300000,
    minOrderUsdt: 10,
    maxOpenPositions: 1,
    tradingCapital: 1000,
    /** Max % of trading capital per trade */
    maxPositionPercent: 0.95,
  },
  risk: {
    /** Risk per trade as % of capital */
    maxRiskPerTrade: 0.006,
    /** +0.5% take profit */
    takeProfitPercent: 0.005,
    /** −0.6% stop loss */
    stopLossPercent: 0.006,
    maxDailyLossPercent: 0.03,
    /** Trailing stop disabled by default — activate after backtesting */
    trailingActivationPercent: 1.0,
    trailingStopPercent: 0.003,
  },
  position: {
    /** Max hours to hold before time-exit */
    maxHoldHours: 2,
    /** Minimum strategy confidence score to execute a trade (0–100) */
    minScore: 95,
  },
  api: {
    // Cloud hosts (Railway, Render) inject PORT automatically
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
