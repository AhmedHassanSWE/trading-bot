import { config } from '../config';
import { ExchangeClient, positionToExitSide } from '../exchange/client';
import { RiskManager } from '../risk/manager';
import { ScalpingStrategy, MultiTimeframeCandles, TradeOpportunity, logSignal } from '../strategy/scalping';
import { BotStore } from '../store/botStore';
import { BotPersistentState } from '../store/persistentState';
import { logger } from '../utils/logger';
import { DashboardSnapshot, OpenPosition, Side, Signal, TradeSignal } from '../types';

export class TradingBot {
  private exchange: ExchangeClient;
  private riskManager: RiskManager;
  private strategy: ScalpingStrategy;
  private store: BotStore;
  private openPosition: OpenPosition | null = null;
  private lastSignal: TradeSignal | null = null;
  private lastOpportunity: TradeOpportunity | null = null;
  private running = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private exchangeInitialized = false;

  constructor() {
    this.exchange = new ExchangeClient();
    this.riskManager = new RiskManager();
    this.strategy = new ScalpingStrategy();
    this.store = new BotStore();
  }

  isRunning(): boolean { return this.running; }

  private activeSymbol(): string {
    if (this.openPosition) return this.openPosition.symbol;
    if (this.lastSignal?.symbol) return this.lastSignal.symbol;
    return 'BTC/USDT';
  }

  async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    const displaySymbol = this.activeSymbol();
    const currentPrice = this.openPosition
      ? await this.exchange.getCurrentPrice(this.openPosition.symbol)
      : this.lastSignal?.price ?? await this.exchange.getCurrentPrice('BTC/USDT').catch(() => 0);

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

  markRunning(): void { this.running = true; }

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
      tradingCapital: config.trading.tradingCapital,
      usdtBalance,
      watchlist: config.trading.watchlist,
    });

    logger.info('Bot started — Trend Continuation After Pullback strategy', {
      watchlist: config.trading.watchlist.join(', '),
      tradingCapital: `${config.trading.tradingCapital.toFixed(2)} USDT`,
      usdtBalance: `${usdtBalance.toFixed(2)} USDT`,
      takeProfit: `+${(config.risk.takeProfitPercent * 100).toFixed(1)}%`,
      stopLoss: `-${(config.risk.stopLossPercent * 100).toFixed(1)}%`,
      minScore: config.position.minScore,
      maxHoldHours: config.position.maxHoldHours,
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

  // ─── Main scan loop ────────────────────────────────────────────────────────

  private async scan(): Promise<void> {
    if (!this.running) return;

    if (this.openPosition) {
      await this.manageOpenPosition();
      return;
    }

    const portfolio = await this.exchange.getUsdtTradingBalance();
    const tradeCheck = this.riskManager.canTrade(portfolio);

    if (!tradeCheck.allowed) {
      logger.warn(`Trading paused: ${tradeCheck.reason}`);
      return;
    }

    const opportunity = await this.findBestOpportunity();

    if (!opportunity || !opportunity.shouldTrade) {
      if (opportunity) {
        this.lastSignal = {
          signal: 'none',
          price: opportunity.entryPrice,
          reason: opportunity.rejections[0] ?? 'Score below minimum',
          strength: opportunity.score / 100,
          symbol: opportunity.symbol,
        };
      } else {
        this.lastSignal = { signal: 'none', price: 0, reason: 'No qualifying setup', strength: 0 };
      }
      return;
    }

    this.lastOpportunity = opportunity;
    this.lastSignal = {
      signal: 'long',
      price: opportunity.entryPrice,
      reason: opportunity.summary,
      strength: opportunity.score / 100,
      symbol: opportunity.symbol,
    };

    const positionSize = this.riskManager.calculatePositionSize(
      portfolio,
      opportunity.entryPrice,
      'long'
    );

    if (!positionSize) return;

    await this.openTrade(opportunity.symbol, opportunity.entryPrice, positionSize);
  }

  // ─── Multi-timeframe data fetch ────────────────────────────────────────────

  private async fetchMultiTimeframe(symbol: string): Promise<MultiTimeframeCandles> {
    const [candles1h, candles15m, candles5m] = await Promise.all([
      this.exchange.fetchCandles(symbol, config.trading.candleLimit1h,  '1h'),
      this.exchange.fetchCandles(symbol, config.trading.candleLimit15m, '15m'),
      this.exchange.fetchCandles(symbol, config.trading.candleLimit5m,  '5m'),
    ]);
    return { candles1h, candles15m, candles5m };
  }

  private async findBestOpportunity(): Promise<TradeOpportunity | null> {
    // Fetch BTC candles first for market health check
    let btcCandles1h = await this.exchange.fetchCandles('BTC/USDT', config.trading.candleLimit1h, '1h').catch(() => []);
    let btcCandles15m = await this.exchange.fetchCandles('BTC/USDT', config.trading.candleLimit15m, '15m').catch(() => []);

    // Fetch all watchlist coins in parallel
    const watchlist = config.trading.watchlist.filter((s) => s !== 'BTC/USDT');
    const coinDataResults = await Promise.allSettled(
      watchlist.map(async (symbol): Promise<{ symbol: string; tf: MultiTimeframeCandles }> => ({
        symbol,
        tf: await this.fetchMultiTimeframe(symbol),
      }))
    );

    const coins: { symbol: string; tf: MultiTimeframeCandles }[] = coinDataResults
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ symbol: string; tf: MultiTimeframeCandles }>).value);

    if (coins.length === 0) {
      logger.warn('Could not fetch candle data for any watchlist coin');
      return null;
    }

    const { best, all } = this.strategy.findBestOpportunity(coins, btcCandles1h, btcCandles15m);

    // Log the ranked summary
    if (all.length > 0) {
      const top3 = all.slice(0, 3).map((o) => `${o.symbol} ${o.score}/100`).join(' | ');
      logger.debug(`Top candidates: ${top3}`);
    }

    return best;
  }

  // ─── Trade execution ───────────────────────────────────────────────────────

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
      logger.warn('Quantity rounded to zero, skipping trade', { symbol });
      return;
    }

    if (!this.exchange.isOrderSizeValid(symbol, quantity, entryPrice)) {
      const { minAmount } = this.exchange.getMarketPrecision(symbol);
      logger.warn('Quantity below market minimum', { symbol, quantity, minAmount });
      return;
    }

    try {
      const orderId = await this.exchange.placeMarketOrder(symbol, side, quantity);
      const fillPrice = await this.exchange.getCurrentPrice(symbol);
      const stopLoss   = this.exchange.formatPrice(symbol, size.stopLossPrice);
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
        risk: `${size.riskAmount.toFixed(2)} USDT`,
        notional: `${size.notionalUsdt.toFixed(2)} USDT`,
        score: this.lastOpportunity?.score ?? '?',
      });

      this.store.addEvent('info', `Position opened (LONG ${symbol})`, {
        symbol, entry: fillPrice, quantity, takeProfit, stopLoss,
      });
    } catch (err) {
      logger.error('Failed to open position', { symbol, error: String(err) });
    }
  }

  // ─── Position management ───────────────────────────────────────────────────

  private async manageOpenPosition(): Promise<void> {
    if (!this.openPosition) return;

    const pos = this.openPosition;
    const currentPrice = await this.exchange.getCurrentPrice(pos.symbol);
    const isLong = pos.side === 'buy';

    this.updateTrailingStop(pos, currentPrice, isLong);

    const unrealizedPct = isLong
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice;

    logger.debug('Position monitor', {
      symbol: pos.symbol,
      entry: pos.entryPrice,
      current: currentPrice,
      pnlPct: `${(unrealizedPct * 100).toFixed(3)}%`,
      tp: pos.takeProfit,
      sl: pos.trailingStop ?? pos.stopLoss,
      held: `${((Date.now() - pos.openedAt) / 60000).toFixed(1)}m`,
    });

    const hitTakeProfit = isLong ? currentPrice >= pos.takeProfit : currentPrice <= pos.takeProfit;
    if (hitTakeProfit) { await this.closePosition('take_profit', currentPrice); return; }

    if (pos.trailingStop !== null) {
      const hitTrailingStop = isLong ? currentPrice <= pos.trailingStop : currentPrice >= pos.trailingStop;
      if (hitTrailingStop) { await this.closePosition('trailing_stop', currentPrice); return; }
    }

    const hitStopLoss = isLong ? currentPrice <= pos.stopLoss : currentPrice >= pos.stopLoss;
    if (hitStopLoss) { await this.closePosition('stop_loss', currentPrice); return; }

    const maxHoldMs = config.position.maxHoldHours * 60 * 60 * 1000;
    if (Date.now() - pos.openedAt > maxHoldMs) {
      await this.closePosition('time_exit', currentPrice);
    }
  }

  private updateTrailingStop(pos: OpenPosition, currentPrice: number, isLong: boolean): void {
    const { trailingActivationPercent, trailingStopPercent } = config.risk;

    const gainPct = isLong
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice;

    if (gainPct < trailingActivationPercent) return;

    if (isLong && currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
    else if (!isLong && currentPrice < pos.peakPrice) pos.peakPrice = currentPrice;

    const newTrailingStop = isLong
      ? pos.peakPrice * (1 - trailingStopPercent)
      : pos.peakPrice * (1 + trailingStopPercent);

    if (pos.trailingStop === null) {
      pos.trailingStop = newTrailingStop;
      logger.info('Trailing stop activated', {
        symbol: pos.symbol,
        peak: pos.peakPrice,
        trailingStop: newTrailingStop.toFixed(4),
        gainPct: `${(gainPct * 100).toFixed(3)}%`,
      });
    } else if (isLong && newTrailingStop > pos.trailingStop) {
      pos.trailingStop = newTrailingStop;
    } else if (!isLong && newTrailingStop < pos.trailingStop) {
      pos.trailingStop = newTrailingStop;
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

      const pnl = pos.side === 'buy'
        ? (exitPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - exitPrice) * pos.quantity;

      const pnlPct = pos.side === 'buy'
        ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;

      const heldMinutes = (Date.now() - pos.openedAt) / 60000;

      this.riskManager.recordTrade(pnl);
      this.store.addTrade({
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity: pos.quantity,
        pnlUsdt: pnl,
        pnlPct,
        reason,
        openedAt: pos.openedAt,
        closedAt: Date.now(),
        heldMinutes,
      });

      const result = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
      logger.info(`Position CLOSED (${reason}) ${result}`, {
        symbol: pos.symbol,
        entry: pos.entryPrice,
        exit: exitPrice,
        pnlPct: `${pnlPct.toFixed(3)}%`,
        pnlUsdt: `${pnl.toFixed(4)} USDT`,
        heldMinutes: heldMinutes.toFixed(1),
        stats: this.riskManager.getStats(),
      });

      this.store.addEvent(pnl >= 0 ? 'info' : 'warn', `Position closed (${reason}) ${pos.symbol}`, {
        symbol: pos.symbol, pnlUsdt: pnl, pnlPct, entry: pos.entryPrice, exit: exitPrice,
      });
    } catch (err) {
      logger.error('Failed to close position', { symbol: pos.symbol, error: String(err) });
    } finally {
      this.openPosition = null;
    }
  }
}
