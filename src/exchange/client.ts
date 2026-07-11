import ccxt, { Exchange, OHLCV } from 'ccxt';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Candle, OpenPosition, Side, PortfolioBalance, WalletBalance } from '../types';

export class ExchangeClient {
  private exchange: Exchange;

  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: config.exchange.apiKey,
      secret: config.exchange.apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: config.trading.mode === 'futures' ? 'future' : 'spot',
        adjustForTimeDifference: true,
      },
    });

    if (config.exchange.useTestnet) {
      this.exchange.setSandboxMode(true);
      logger.info('Running in TESTNET (sandbox) mode');
    }
  }

  async initialize(): Promise<void> {
    await this.exchange.loadMarkets();
    logger.info(`Connected to Binance — watchlist: ${config.trading.watchlist.join(', ')}`);
  }

  async fetchCandles(symbol: string, limit: number, timeframe = '5m'): Promise<Candle[]> {
    const ohlcv: OHLCV[] = await this.exchange.fetchOHLCV(
      symbol,
      timeframe,
      undefined,
      limit
    );

    return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp: timestamp ?? 0,
      open: open ?? 0,
      high: high ?? 0,
      low: low ?? 0,
      close: close ?? 0,
      volume: volume ?? 0,
    }));
  }

  async getWalletBalance(): Promise<WalletBalance> {
    const balance = await this.exchange.fetchBalance();
    const usdt = balance.USDT ?? { total: 0, free: 0, used: 0 };

    return {
      totalUsdt: usdt.total ?? 0,
      freeUsdt: usdt.free ?? 0,
      usedUsdt: usdt.used ?? 0,
    };
  }

  async getUsdtTradingBalance(): Promise<PortfolioBalance> {
    const wallet = await this.getWalletBalance();
    return {
      ...wallet,
      baseAsset: 'USDT',
      baseHoldings: 0,
      baseValueUsdt: 0,
      portfolioValueUsdt: wallet.totalUsdt,
    };
  }

  async getPortfolioBalance(symbol: string): Promise<PortfolioBalance> {
    const balance = await this.exchange.fetchBalance();
    const usdt = balance.USDT ?? { total: 0, free: 0, used: 0 };
    const baseAsset = symbol.split('/')[0];
    const base = balance[baseAsset] ?? { total: 0, free: 0, used: 0 };
    const baseHoldings = base.total ?? 0;
    const currentPrice = await this.getCurrentPrice(symbol);
    const baseValueUsdt = baseHoldings * currentPrice;

    return {
      totalUsdt: usdt.total ?? 0,
      freeUsdt: usdt.free ?? 0,
      usedUsdt: usdt.used ?? 0,
      baseAsset,
      baseHoldings,
      baseValueUsdt,
      portfolioValueUsdt: (usdt.total ?? 0) + baseValueUsdt,
    };
  }

  async getCurrentPrice(symbol: string): Promise<number> {
    const ticker = await this.exchange.fetchTicker(symbol);
    return ticker.last ?? ticker.close ?? 0;
  }

  async placeMarketOrder(symbol: string, side: Side, quantity: number): Promise<string> {
    const order = await this.exchange.createOrder(symbol, 'market', side, quantity);
    const orderId = order.id ?? `order-${Date.now()}`;
    logger.info(`Market ${side} order placed`, { symbol, orderId, quantity });
    return orderId;
  }

  async placeLimitOrder(
    symbol: string,
    side: Side,
    quantity: number,
    price: number
  ): Promise<string> {
    const order = await this.exchange.createOrder(symbol, 'limit', side, quantity, price);
    const orderId = order.id ?? `order-${Date.now()}`;
    logger.info(`Limit ${side} order placed`, { symbol, orderId, quantity, price });
    return orderId;
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.exchange.cancelAllOrders(symbol);
    logger.info('Cancelled all open orders', { symbol });
  }

  /** Sell watchlist base-asset holdings back to USDT on startup */
  async convertWatchlistHoldingsToUsdt(skipSymbol?: string): Promise<number> {
    for (const pair of config.trading.watchlist) {
      if (pair === skipSymbol) continue;

      const baseAsset = pair.split('/')[0];
      try {
        const balance = await this.exchange.fetchBalance();
        const baseHoldings = balance[baseAsset]?.free ?? balance[baseAsset]?.total ?? 0;
        if (baseHoldings <= 0) continue;

        const quantity = this.formatQuantity(pair, baseHoldings);
        const price = await this.getCurrentPrice(pair);
        const notional = quantity * price;
        const { minAmount, minCost } = this.getMarketPrecision(pair);
        const effectiveMin = Math.max(minAmount, 0.00001);

        if (quantity <= effectiveMin || notional < minCost) {
          logger.info('Skipping dust conversion', { pair, holdings: baseHoldings });
          continue;
        }

        await this.placeMarketOrder(pair, 'sell', quantity);
        logger.info('Converted holdings back to USDT', { pair, sold: quantity });
      } catch (err) {
        logger.warn('Conversion skipped', { pair, error: String(err) });
      }
    }

    const updated = await this.getWalletBalance();
    return updated.freeUsdt;
  }

  getMarketPrecision(symbol: string): { minAmount: number; minCost: number } {
    const market = this.exchange.market(symbol);
    const minAmount = Math.max(market.limits?.amount?.min ?? 0, 0.00001);
    return {
      minAmount,
      minCost: market.limits?.cost?.min ?? config.trading.minOrderUsdt,
    };
  }

  isOrderSizeValid(symbol: string, quantity: number, price: number): boolean {
    const { minAmount, minCost } = this.getMarketPrecision(symbol);
    return quantity > minAmount && quantity * price >= minCost;
  }

  formatQuantity(symbol: string, quantity: number): number {
    return parseFloat(this.exchange.amountToPrecision(symbol, quantity));
  }

  formatPrice(symbol: string, price: number): number {
    return parseFloat(this.exchange.priceToPrecision(symbol, price));
  }
}

export function positionToExitSide(position: OpenPosition): Side {
  return position.side === 'buy' ? 'sell' : 'buy';
}
