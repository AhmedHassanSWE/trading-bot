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
    symbol: 'BTC/USDT',
    timeframe: '1m',
    candleLimit: 100,
    scanIntervalMs: 10000,
    minOrderUsdt: 10,
    maxOpenPositions: 1,
    tradingCapital: 1000,
  },
  risk: {
    maxRiskPerTrade: 0.002,
    takeProfitMin: 0.01,
    takeProfitMax: 0.02,
    stopLossPercent: 0.002,
    maxDailyLossPercent: 0.02,
    trailingActivationPercent: 0.005,
    trailingStopPercent: 0.003,
  },
  position: {
    maxHoldHours: 6,
    minSignalStrength: 0.60,
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

  if (config.risk.takeProfitMin >= config.risk.takeProfitMax) {
    throw new Error('takeProfitMin must be less than takeProfitMax');
  }
}
