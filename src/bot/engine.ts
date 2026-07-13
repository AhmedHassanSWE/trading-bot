import { config } from '../config';
import { ExchangeClient, positionToExitSide } from '../exchange/client';
import { RiskManager } from '../risk/manager';
import {
  MediumRiskStrategy,
  MultiTimeframeCandles,
  TradeOpportunity,
  logSignal,
} from '../strategy/mediumRisk';
import { BotStore } from '../store/botStore';
import { BotPersistentState } from '../store/persistentState';
import { logger } from '../utils/logger';
import { Candle, DashboardSnapshot, OpenPosition, Side, TradeSignal } from '../types';

export class TradingBot {
  private exchange: ExchangeClient;
  private riskManager: RiskManager;
  private strategy: MediumRiskStrategy;
  private store: BotStore;

  private openPosition: OpenPosition | null = null;
  private lastSignal: TradeSignal | null = null;
  private lastOpportunity: TradeOpportunity | null = null;
  private running = false;
  private exchangeInitialized = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** Skip pair after SL (ms timestamp) — stops revenge re-entries like LDO twice */
  private symbolCooldownUntil = new Map<string, number>();
  private static readonly SL_COOLDOWN_MS = 30 * 60 * 1000;
  private static readonly ANY_EXIT_COOLDOWN_MS = 8 * 60 * 1000;

  constructor() {
    this.exchange = new ExchangeClient();
    this.riskManager = new RiskManager();
    this.strategy = new MediumRiskStrategy();
    this.store = new BotStore();
  }

  isRunning(): boolean {
    return this.running;
  }

  private activeSymbol(): string {
    return this.openPosition?.symbol ?? this.lastSignal?.symbol ?? 'BTC/USDT';
  }

  async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    const displaySymbol = this.activeSymbol();
    const currentPrice = this.openPosition
      ? await this.exchange.getCurrentPrice(this.openPosition.symbol)
      : this.lastSignal?.price ??
        (await this.exchange.getCurrentPrice('BTC/USDT').catch(() => 0));

    const startingBalance = config.trading.tradingCapital;
    const realizedPnl = this.store.getRealizedPnl();

    let unrealizedPnl = 0;
    let openPosition: DashboardSnapshot['openPosition'] = null;

    if (this.openPosition) {
      const pos = this.openPosition;
      const posPrice = await this.exchange.getCurrentPrice(pos.symbol);
      const isLong = pos.side === 'buy';
      unrealizedPnl = isLong
        ? (posPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - posPrice) * pos.quantity;
      const unrealizedPnlPct = isLong
        ? ((posPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - posPrice) / pos.entryPrice) * 100;

      openPosition = {
        ...pos,
        currentPrice: posPrice,
        unrealizedPnlUsdt: unrealizedPnl,
        unrealizedPnlPct,
        heldMinutes: (Date.now() - pos.openedAt) / 60000,
      };
    }

    const totalPnl = realizedPnl + unrealizedPnl;
    const currentBalance = startingBalance + totalPnl;
    const totalPnlPct = startingBalance > 0 ? (totalPnl / startingBalance) * 100 : 0;

    return {
      startingBalance,
      currentBalance,
      running: this.running,
      testnet: config.exchange.useTestnet,
      symbol: displaySymbol,
      watchlist: [...config.trading.watchlist],
      currentPrice,
      totalPnl,
      totalPnlPct,
      openPosition,
      stats: this.riskManager.getStats(),
      recentTrades: this.store.getTrades(),
      recentEvents: this.store.getEvents(),
      lastSignal: this.lastSignal,
      updatedAt: Date.now(),
    };
  }

  loadState(state: BotPersistentState): void {
    this.openPosition = state.openPosition;
    this.lastSignal = state.lastSignal;
    this.running = state.running;
    this.exchangeInitialized = state.exchangeInitialized;
    this.store.importData(state.trades, state.events);
    this.riskManager.importStats(state.stats, state.dayStart);
  }

  exportState(): BotPersistentState {
    const { stats, dayStart } = this.riskManager.exportStats();
    const { trades, events } = this.store.exportData();
    return {
      openPosition: this.openPosition,
      lastSignal: this.lastSignal,
      trades,
      events,
      stats,
      dayStart,
      running: this.running,
      exchangeInitialized: this.exchangeInitialized,
    };
  }

  async ensureInitialized(alreadyInitialized: boolean): Promise<void> {
    if (this.exchangeInitialized || alreadyInitialized) {
      this.exchangeInitialized = true;
      return;
    }
    await this.exchange.initialize();
    this.exchangeInitialized = true;
  }

  async runTick(): Promise<void> {
    this.running = true;
    await this.scan();
  }

  markRunning(): void {
    this.running = true;
  }

  async bootstrapOnVercel(kvConfigured: boolean): Promise<void> {
    this.store.addEvent('info', 'Bot started on Vercel', { kvConfigured });
  }

  async start(): Promise<void> {
    await this.ensureInitialized(false);
    this.running = true;

    const usdtBalance = await this.exchange.convertWatchlistHoldingsToUsdt(
      this.openPosition?.symbol
    );

    this.store.addEvent('info', 'Bot started', {
      strategy: 'balanced',
      tradingCapital: config.trading.tradingCapital,
      usdtBalance,
      watchlist: config.trading.watchlist,
    });

    logger.info('Bot started — Balanced strategy', {
      watchlist: config.trading.watchlist.join(', '),
      tradingCapital: `${config.trading.tradingCapital.toFixed(2)} USDT`,
      takeProfit: `+${(config.risk.takeProfitPercent * 100).toFixed(1)}%`,
      stopLoss: `-${(config.risk.stopLossPercent * 100).toFixed(1)}%`,
      minScore: config.position.minScore,
      commission: `${(config.commission.rate * 100).toFixed(2)}% per side`,
      testnet: config.exchange.useTestnet,
    });

    await this.scan();
    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => logger.error('Scan error', { error: String(err) }));
    }, config.trading.scanIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    logger.info('Bot stopped', { stats: this.riskManager.getStats() });
  }

  private async scan(): Promise<void> {
    if (!this.running) return;

    if (this.openPosition) {
      await this.manageOpenPosition();
      return;
    }

    const portfolio = await this.exchange.getUsdtTradingBalance();
    const realizedPnl = this.store.getRealizedPnl();
    const tradeCheck = this.riskManager.canTrade(portfolio, realizedPnl);

    if (!tradeCheck.allowed) {
      logger.warn(`Trading paused: ${tradeCheck.reason}`);
      return;
    }

    const { btcCandles1h, btcCandles15m, coins } = await this.fetchAllCandles();
    const { all } = this.strategy.findBestOpportunity(
      coins,
      btcCandles1h,
      btcCandles15m
    );

    const now = Date.now();
    const best =
      all.find(
        (r) =>
          r.shouldTrade && now >= (this.symbolCooldownUntil.get(r.symbol) ?? 0)
      ) ?? null;

    this.lastOpportunity = best;

    if (!best || !best.shouldTrade) {
      const top = all[0];
      const cooled = all.find(
        (r) => r.shouldTrade && now < (this.symbolCooldownUntil.get(r.symbol) ?? 0)
      );
      this.lastSignal = {
        signal: 'none',
        price: top?.entryPrice ?? 0,
        reason: cooled
          ? `${cooled.symbol} on cooldown after recent exit`
          : top?.rejections[0] ?? 'No qualifying setup',
        strength: (top?.score ?? 0) / 100,
        symbol: top?.symbol,
      };
      return;
    }

    this.lastSignal = {
      signal: 'long',
      price: best.entryPrice,
      reason: best.summary,
      strength: best.score / 100,
      symbol: best.symbol,
    };
    logSignal(this.lastSignal, best.symbol);

    const positionSize = this.riskManager.calculatePositionSize(
      portfolio,
      best.entryPrice,
      'long',
      realizedPnl
    );
    if (!positionSize) return;

    await this.openTrade(best.symbol, best.entryPrice, positionSize);
  }

  private async fetchAllCandles(): Promise<{
    btcCandles1h: Candle[];
    btcCandles15m: Candle[];
    coins: { symbol: string; tf: MultiTimeframeCandles }[];
  }> {
    const [btcCandles1h, btcCandles15m] = await Promise.all([
      this.exchange.fetchCandles('BTC/USDT', config.trading.candleLimit1h, '1h').catch(() => []),
      this.exchange.fetchCandles('BTC/USDT', config.trading.candleLimit15m, '15m').catch(() => []),
    ]);

    const watchlist = [...config.trading.watchlist];
    const coinResults = await Promise.allSettled(
      watchlist.map(async (symbol): Promise<{ symbol: string; tf: MultiTimeframeCandles }> => ({
        symbol,
        tf: {
          candles1h: await this.exchange.fetchCandles(symbol, config.trading.candleLimit1h, '1h'),
          candles15m: await this.exchange.fetchCandles(symbol, config.trading.candleLimit15m, '15m'),
          candles5m: await this.exchange.fetchCandles(symbol, config.trading.candleLimit5m, '5m'),
        },
      }))
    );

    const coins: { symbol: string; tf: MultiTimeframeCandles }[] = coinResults
      .filter((r) => r.status === 'fulfilled')
      .map(
        (r) =>
          (r as PromiseFulfilledResult<{ symbol: string; tf: MultiTimeframeCandles }>).value
      );

    return { btcCandles1h, btcCandles15m, coins };
  }

  private async openTrade(
    symbol: string,
    entryPrice: number,
    size: {
      quantity: number;
      stopLossPrice: number;
      takeProfitPrice: number;
      riskAmount: number;
      notionalUsdt: number;
    }
  ): Promise<void> {
    const side: Side = 'buy';
    const quantity = this.exchange.formatQuantity(symbol, size.quantity);

    if (quantity <= 0) {
      logger.warn('Quantity rounded to zero', { symbol });
      return;
    }
    if (!this.exchange.isOrderSizeValid(symbol, quantity, entryPrice)) {
      logger.warn('Quantity below market minimum', { symbol, quantity });
      return;
    }

    try {
      const orderId = await this.exchange.placeMarketOrder(symbol, side, quantity);
      const fillPrice = await this.exchange.getCurrentPrice(symbol);
      const stopLoss = this.exchange.formatPrice(symbol, size.stopLossPrice);
      const takeProfit = this.exchange.formatPrice(symbol, size.takeProfitPrice);

      this.openPosition = {
        id: orderId,
        symbol,
        side,
        entryPrice: fillPrice,
        quantity,
        stopLoss,
        takeProfit,
        openedAt: Date.now(),
        peakPrice: fillPrice,
        trailingStop: null,
      };

      logger.info('Position OPENED', {
        symbol,
        side: 'LONG',
        entry: fillPrice,
        quantity,
        stopLoss,
        takeProfit,
        score: this.lastOpportunity?.score ?? '?',
        notional: `${size.notionalUsdt.toFixed(2)} USDT`,
        commissionEntry: `≈${(fillPrice * quantity * config.commission.rate).toFixed(4)} USDT`,
      });

      this.store.addEvent('info', `Position opened (LONG ${symbol})`, {
        symbol,
        entry: fillPrice,
        quantity,
        takeProfit,
        stopLoss,
      });
    } catch (err) {
      logger.error('Failed to open position', { symbol, error: String(err) });
    }
  }

  private async manageOpenPosition(): Promise<void> {
    if (!this.openPosition) return;
    const pos = this.openPosition;
    const currentPrice = await this.exchange.getCurrentPrice(pos.symbol);
    const isLong = pos.side === 'buy';

    this.updateTrailingStop(pos, currentPrice, isLong);

    const pnlPct = isLong
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice;

    logger.debug('Position monitor', {
      symbol: pos.symbol,
      entry: pos.entryPrice,
      current: currentPrice,
      pnlPct: `${(pnlPct * 100).toFixed(3)}%`,
      tp: pos.takeProfit,
      sl: pos.trailingStop ?? pos.stopLoss,
      held: `${((Date.now() - pos.openedAt) / 60000).toFixed(1)}m`,
    });

    if (isLong ? currentPrice >= pos.takeProfit : currentPrice <= pos.takeProfit) {
      await this.closePosition('take_profit', currentPrice);
      return;
    }

    if (pos.trailingStop !== null) {
      const hitTS = isLong
        ? currentPrice <= pos.trailingStop
        : currentPrice >= pos.trailingStop;
      if (hitTS) {
        await this.closePosition('trailing_stop', currentPrice);
        return;
      }
    }

    if (isLong ? currentPrice <= pos.stopLoss : currentPrice >= pos.stopLoss) {
      await this.closePosition('stop_loss', currentPrice);
      return;
    }

    const maxHoldMs = config.position.maxHoldHours * 60 * 60 * 1000;
    if (Date.now() - pos.openedAt > maxHoldMs) {
      await this.closePosition('time_exit', currentPrice);
    }
  }

  private updateTrailingStop(pos: OpenPosition, price: number, isLong: boolean): void {
    const { trailingActivationPercent, trailingStopPercent } = config.risk;
    const gainPct = isLong
      ? (price - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - price) / pos.entryPrice;

    if (gainPct < trailingActivationPercent) return;

    if (isLong && price > pos.peakPrice) pos.peakPrice = price;
    else if (!isLong && price < pos.peakPrice) pos.peakPrice = price;

    const newTS = isLong
      ? pos.peakPrice * (1 - trailingStopPercent)
      : pos.peakPrice * (1 + trailingStopPercent);

    if (pos.trailingStop === null) {
      pos.trailingStop = newTS;
      logger.info('Trailing stop activated', {
        symbol: pos.symbol,
        trailingStop: newTS.toFixed(4),
      });
    } else if (isLong && newTS > pos.trailingStop) {
      pos.trailingStop = newTS;
    } else if (!isLong && newTS < pos.trailingStop) {
      pos.trailingStop = newTS;
    }
  }

  private async closePosition(
    reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_exit',
    exitPrice: number
  ): Promise<void> {
    if (!this.openPosition) return;
    const pos = this.openPosition;
    const exitSide = positionToExitSide(pos);

    try {
      await this.exchange.placeMarketOrder(pos.symbol, exitSide, pos.quantity);

      const grossPnl =
        pos.side === 'buy'
          ? (exitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exitPrice) * pos.quantity;

      const grossPnlPct =
        pos.side === 'buy'
          ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;

      const heldMinutes = (Date.now() - pos.openedAt) / 60000;

      // Binance fee: 0.1% entry + 0.1% exit (applied on testnet too for realism)
      const commissionUsdt =
        pos.entryPrice * pos.quantity * config.commission.rate +
        exitPrice * pos.quantity * config.commission.rate;
      const netPnlUsdt = grossPnl - commissionUsdt;

      this.riskManager.recordTrade(netPnlUsdt);
      this.store.addTrade({
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity: pos.quantity,
        pnlUsdt: netPnlUsdt,
        pnlPct: grossPnlPct,
        reason,
        openedAt: pos.openedAt,
        closedAt: Date.now(),
        heldMinutes,
      });

      const result = netPnlUsdt >= 0 ? '✅ WIN' : '❌ LOSS';
      logger.info(`Position CLOSED (${reason}) ${result}`, {
        symbol: pos.symbol,
        entry: pos.entryPrice,
        exit: exitPrice,
        grossPnl: `${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)} USDT`,
        commission: `−${commissionUsdt.toFixed(4)} USDT`,
        netPnl: `${netPnlUsdt >= 0 ? '+' : ''}${netPnlUsdt.toFixed(4)} USDT`,
        heldMinutes: heldMinutes.toFixed(1),
        stats: this.riskManager.getStats(),
      });

      this.store.addEvent(
        netPnlUsdt >= 0 ? 'info' : 'warn',
        `Position closed (${reason}) ${pos.symbol} ${result}`,
        {
          symbol: pos.symbol,
          netPnlUsdt,
          commissionUsdt,
          entry: pos.entryPrice,
          exit: exitPrice,
        }
      );
    } catch (err) {
      logger.error('Failed to close position', { symbol: pos.symbol, error: String(err) });
    } finally {
      const coolMs =
        reason === 'stop_loss'
          ? TradingBot.SL_COOLDOWN_MS
          : TradingBot.ANY_EXIT_COOLDOWN_MS;
      this.symbolCooldownUntil.set(pos.symbol, Date.now() + coolMs);
      logger.info(`${pos.symbol} cooldown ${(coolMs / 60000).toFixed(0)}m after ${reason}`);
      this.openPosition = null;
    }
  }
}
