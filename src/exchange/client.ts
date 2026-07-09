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
    logger.info(`Connected to Binance — ${config.trading.symbol} loaded`);
  }

  async fetchCandles(limit: number): Promise<Candle[]> {
    const ohlcv: OHLCV[] = await this.exchange.fetchOHLCV(
      config.trading.symbol,
      config.trading.timeframe,
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

  /** USDT-only view for trading when no position is open */
  async getUsdtTradingBalance(): Promise<PortfolioBalance> {
    const wallet = await this.getWalletBalance();
    const baseAsset = config.trading.symbol.split('/')[0];
    return {
      ...wallet,
      baseAsset,
      baseHoldings: 0,
      baseValueUsdt: 0,
      portfolioValueUsdt: wallet.totalUsdt,
    };
  }

  /** Total portfolio value = USDT cash + base asset (e.g. BTC) valued in USDT */
  async getPortfolioBalance(): Promise<PortfolioBalance> {
    const balance = await this.exchange.fetchBalance();
    const usdt = balance.USDT ?? { total: 0, free: 0, used: 0 };
    const baseAsset = config.trading.symbol.split('/')[0];
    const base = balance[baseAsset] ?? { total: 0, free: 0, used: 0 };
    const baseHoldings = base.total ?? 0;
    const currentPrice = await this.getCurrentPrice();
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

  async getCurrentPrice(): Promise<number> {
    const ticker = await this.exchange.fetchTicker(config.trading.symbol);
    return ticker.last ?? ticker.close ?? 0;
  }

  async placeMarketOrder(side: Side, quantity: number): Promise<string> {
    const order = await this.exchange.createOrder(
      config.trading.symbol,
      'market',
      side,
      quantity
    );
    const orderId = order.id ?? `order-${Date.now()}`;
    logger.info(`Market ${side} order placed`, { orderId, quantity });
    return orderId;
  }

  async placeLimitOrder(
    side: Side,
    quantity: number,
    price: number
  ): Promise<string> {
    const order = await this.exchange.createOrder(
      config.trading.symbol,
      'limit',
      side,
      quantity,
      price
    );
    const orderId = order.id ?? `order-${Date.now()}`;
    logger.info(`Limit ${side} order placed`, { orderId, quantity, price });
    return orderId;
  }

  async cancelAllOpenOrders(): Promise<void> {
    await this.exchange.cancelAllOrders(config.trading.symbol);
    logger.info('Cancelled all open orders');
  }

  /** Sell all base asset (BTC) holdings and return USDT balance */
  async convertHoldingsToUsdt(): Promise<number> {
    try {
      const wallet = await this.getWalletBalance();
      const balance = await this.exchange.fetchBalance();
      const baseAsset = config.trading.symbol.split('/')[0];
      const baseHoldings = balance[baseAsset]?.free ?? balance[baseAsset]?.total ?? 0;

      if (baseHoldings <= 0) {
        return wallet.freeUsdt;
      }

      const quantity = this.formatQuantity(baseHoldings);
      const price = await this.getCurrentPrice();
      const notional = quantity * price;
      const { minAmount, minCost } = this.getMarketPrecision();

      // Binance rejects amounts <= 0.00001 BTC — use strict greater-than check
      const effectiveMin = Math.max(minAmount, 0.00001);
      if (quantity <= effectiveMin || notional < minCost) {
        logger.info('Skipping BTC→USDT conversion (dust or below minimum)', {
          holdings: baseHoldings,
          quantity,
          effectiveMin,
          notional,
        });
        return wallet.freeUsdt;
      }

      await this.placeMarketOrder('sell', quantity);
      const updated = await this.getWalletBalance();
      logger.info('Converted BTC holdings back to USDT', {
        sold: quantity,
        usdtBalance: updated.freeUsdt,
      });
      return updated.freeUsdt;
    } catch (err) {
      const wallet = await this.getWalletBalance().catch(() => ({ freeUsdt: 0, totalUsdt: 0, usedUsdt: 0 }));
      logger.warn('BTC→USDT conversion skipped — bot continuing with USDT', {
        error: String(err),
      });
      return wallet.freeUsdt;
    }
  }

  getMarketPrecision(): { minAmount: number; minCost: number } {
    const market = this.exchange.market(config.trading.symbol);
    const minAmount = Math.max(market.limits?.amount?.min ?? 0, 0.00001);

    return {
      minAmount,
      minCost: market.limits?.cost?.min ?? config.trading.minOrderUsdt,
    };
  }

  isOrderSizeValid(quantity: number, price: number): boolean {
    const { minAmount, minCost } = this.getMarketPrecision();
    return quantity > minAmount && quantity * price >= minCost;
  }

  formatQuantity(quantity: number): number {
    return parseFloat(
      this.exchange.amountToPrecision(config.trading.symbol, quantity)
    );
  }

  formatPrice(price: number): number {
    return parseFloat(
      this.exchange.priceToPrecision(config.trading.symbol, price)
    );
  }
}

export function positionToExitSide(position: OpenPosition): Side {
  return position.side === 'buy' ? 'sell' : 'buy';
}
