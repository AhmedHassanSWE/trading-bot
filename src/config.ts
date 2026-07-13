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
    // Liquid pairs that move enough for 0.5% scalps.
    // Includes majors that exist on Binance testnet + mid-caps for live.
    watchlist: [
      'SOL/USDT',
      'AVAX/USDT',
      'DOGE/USDT',
      'LINK/USDT',
      'ADA/USDT',
      'DOT/USDT',
      'NEAR/USDT',
      'ATOM/USDT',
      'APT/USDT',
      'ARB/USDT',
      'OP/USDT',
      'SUI/USDT',
      'INJ/USDT',
      'FIL/USDT',
      'AAVE/USDT',
      'UNI/USDT',
      'LDO/USDT',
      'FET/USDT',
      'RENDER/USDT',
      'HBAR/USDT',
    ],
    /** Candle limits per timeframe */
    candleLimit1h:  120,
    candleLimit15m: 120,
    candleLimit5m:  120,
    /** Scan every 1 minute so setups are not missed */
    scanIntervalMs: 60000,
    minOrderUsdt: 10,
    maxOpenPositions: 1,
    tradingCapital: 1000,
    /** Lower risk: half capital per trade so one SL doesn't wreck the day */
    maxPositionPercent: 0.45,
  },
  /**
   * Binance standard maker/taker fee: 0.1% per side = 0.2% round trip.
   * Applied to every trade even on testnet so P&L reflects real conditions.
   */
  commission: {
    rate: 0.001, // 0.1% per side
  },
  risk: {
    maxRiskPerTrade: 0.003,
    /** 0.8% gross ≈ 0.6% net; 0.35% SL ≈ 0.55% net — slight edge after fees */
    takeProfitPercent: 0.008,
    stopLossPercent: 0.0035,
    maxDailyLossPercent: 0.02,
    /** Was 1.0 (100% — never activated). Lock gains after +0.45%. */
    trailingActivationPercent: 0.0045,
    trailingStopPercent: 0.002,
  },
  position: {
    maxHoldHours: 1.5,
    /** Balanced — high enough to skip junk, low enough to take real setups */
    /** Balanced — still filtered, but reachable during normal sessions */
    minScore: 55,
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
