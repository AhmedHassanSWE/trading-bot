import { config } from '../config';
import { ExchangeClient, positionToExitSide } from '../exchange/client';
import { RiskManager } from '../risk/manager';
import { ScalpingStrategy, logSignal } from '../strategy/scalping';
import { BotStore } from '../store/botStore';
import { logger } from '../utils/logger';
import { DashboardSnapshot, OpenPosition, Side, Signal, TradeSignal } from '../types';

export class TradingBot {
  private exchange: ExchangeClient;
  private riskManager: RiskManager;
  private strategy: ScalpingStrategy;
  private store: BotStore;
  private openPosition: OpenPosition | null = null;
  private lastSignal: TradeSignal | null = null;
  private running = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.exchange = new ExchangeClient();
    this.riskManager = new RiskManager();
    this.strategy = new ScalpingStrategy();
    this.store = new BotStore();
  }

  isRunning(): boolean {
    return this.running;
  }

  async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    const currentPrice = await this.exchange.getCurrentPrice();
    const startingBalance = config.trading.tradingCapital;
    const realizedPnl = this.store.getRealizedPnl();

    let unrealizedPnl = 0;
    let openPosition: DashboardSnapshot['openPosition'] = null;
    if (this.openPosition) {
      const pos = this.openPosition;
      const isLong = pos.side === 'buy';
      unrealizedPnl = isLong
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity;
      const unrealizedPnlPct = isLong
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

      openPosition = {
        ...pos,
        currentPrice,
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
      symbol: config.trading.symbol,
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

  async start(): Promise<void> {
    await this.exchange.initialize();
    this.running = true;

    // Convert any leftover BTC from previous sessions back to USDT
    const usdtBalance = await this.exchange.convertHoldingsToUsdt();

    this.store.addEvent('info', 'Bot started', {
      tradingCapital: config.trading.tradingCapital,
      usdtBalance,
      symbol: config.trading.symbol,
    });

    logger.info('Bot started', {
      symbol: config.trading.symbol,
      tradingCapital: `${config.trading.tradingCapital.toFixed(2)} USDT`,
      usdtBalance: `${usdtBalance.toFixed(2)} USDT`,
      riskPerTrade: `${(config.risk.maxRiskPerTrade * 100).toFixed(2)}%`,
      takeProfit: `${(config.risk.takeProfitMin * 100).toFixed(1)}–${(config.risk.takeProfitMax * 100).toFixed(1)}%`,
      stopLoss: `${(config.risk.stopLossPercent * 100).toFixed(2)}%`,
      trailingActivation: `${(config.risk.trailingActivationPercent * 100).toFixed(2)}%`,
      trailingStop: `${(config.risk.trailingStopPercent * 100).toFixed(2)}%`,
      maxHoldHours: config.position.maxHoldHours,
      rewardRisk: `${this.riskManager.getRewardRiskRatio().toFixed(1)}:1`,
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
    const tradeCheck = this.riskManager.canTrade(portfolio);

    if (!tradeCheck.allowed) {
      logger.warn(`Trading paused: ${tradeCheck.reason}`);
      return;
    }

    const candles = await this.exchange.fetchCandles(config.trading.candleLimit);
    const signal = this.strategy.analyze(candles);
    this.lastSignal = signal;
    logSignal(signal);

    if (signal.signal === 'none' || signal.strength < config.position.minSignalStrength) return;

    if (signal.signal === 'short' && config.trading.mode === 'spot') {
      logger.debug('Short signal ignored in spot mode (long only)');
      return;
    }

    const positionSize = this.riskManager.calculatePositionSize(
      portfolio,
      signal.price,
      signal.signal
    );

    if (!positionSize) return;

    await this.openTrade(signal.signal, signal.price, positionSize);
  }

  private async openTrade(
    signal: Signal,
    entryPrice: number,
    size: {
      quantity: number;
      stopLossPrice: number;
      takeProfitPrice: number;
      riskAmount: number;
      notionalUsdt: number;
    }
  ): Promise<void> {
    const side: Side = signal === 'long' ? 'buy' : 'sell';
    const quantity = this.exchange.formatQuantity(size.quantity);

    if (quantity <= 0) {
      logger.warn('Quantity rounded to zero, skipping trade');
      return;
    }

    if (!this.exchange.isOrderSizeValid(quantity, entryPrice)) {
      const { minAmount } = this.exchange.getMarketPrecision();
      logger.warn('Quantity below market minimum', { quantity, minAmount });
      return;
    }

    try {
      const orderId = await this.exchange.placeMarketOrder(side, quantity);
      const fillPrice = await this.exchange.getCurrentPrice();
      const stopLoss = this.exchange.formatPrice(size.stopLossPrice);
      const takeProfit = this.exchange.formatPrice(size.takeProfitPrice);

      this.openPosition = {
        id: orderId,
        symbol: config.trading.symbol,
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
        side: signal.toUpperCase(),
        entry: fillPrice,
        quantity,
        stopLoss,
        takeProfit,
        risk: `${size.riskAmount.toFixed(2)} USDT`,
        notional: `${size.notionalUsdt.toFixed(2)} USDT`,
      });
      this.store.addEvent('info', `Position opened (${signal.toUpperCase()})`, {
        entry: fillPrice,
        quantity,
        takeProfit,
        stopLoss,
      });
    } catch (err) {
      logger.error('Failed to open position', { error: String(err) });
    }
  }

  private async manageOpenPosition(): Promise<void> {
    if (!this.openPosition) return;

    const currentPrice = await this.exchange.getCurrentPrice();
    const pos = this.openPosition;
    const isLong = pos.side === 'buy';

    // ── Update peak price & trailing stop ─────────────────────────────────
    this.updateTrailingStop(pos, currentPrice, isLong);

    const unrealizedPct = isLong
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice;

    logger.debug(`Position monitor`, {
      side: pos.side,
      entry: pos.entryPrice,
      current: currentPrice,
      pnlPct: `${(unrealizedPct * 100).toFixed(3)}%`,
      tp: pos.takeProfit,
      sl: pos.trailingStop ?? pos.stopLoss,
      held: `${((Date.now() - pos.openedAt) / 60000).toFixed(1)}m`,
    });

    // ── Check take profit ─────────────────────────────────────────────────
    const hitTakeProfit = isLong
      ? currentPrice >= pos.takeProfit
      : currentPrice <= pos.takeProfit;

    if (hitTakeProfit) {
      await this.closePosition('take_profit', currentPrice);
      return;
    }

    // ── Check trailing stop (takes priority over fixed stop once active) ──
    if (pos.trailingStop !== null) {
      const hitTrailingStop = isLong
        ? currentPrice <= pos.trailingStop
        : currentPrice >= pos.trailingStop;

      if (hitTrailingStop) {
        await this.closePosition('trailing_stop', currentPrice);
        return;
      }
    }

    // ── Check fixed stop loss ─────────────────────────────────────────────
    const hitStopLoss = isLong
      ? currentPrice <= pos.stopLoss
      : currentPrice >= pos.stopLoss;

    if (hitStopLoss) {
      await this.closePosition('stop_loss', currentPrice);
      return;
    }

    // ── Max hold time exit ────────────────────────────────────────────────
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

    // Only activate trailing once we are sufficiently in profit
    if (gainPct < trailingActivationPercent) return;

    // Update peak price
    if (isLong && currentPrice > pos.peakPrice) {
      pos.peakPrice = currentPrice;
    } else if (!isLong && currentPrice < pos.peakPrice) {
      pos.peakPrice = currentPrice;
    }

    // Calculate new trailing stop from peak
    const newTrailingStop = isLong
      ? pos.peakPrice * (1 - trailingStopPercent)
      : pos.peakPrice * (1 + trailingStopPercent);

    // Only move trailing stop in the favorable direction
    if (pos.trailingStop === null) {
      pos.trailingStop = newTrailingStop;
      logger.info('Trailing stop activated', {
        entry: pos.entryPrice,
        peak: pos.peakPrice,
        trailingStop: pos.trailingStop.toFixed(2),
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
      await this.exchange.placeMarketOrder(exitSide, pos.quantity);

      const pnl =
        pos.side === 'buy'
          ? (exitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exitPrice) * pos.quantity;

      const pnlPct =
        pos.side === 'buy'
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

      const emoji = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
      logger.info(`Position CLOSED (${reason}) ${emoji}`, {
        entry: pos.entryPrice,
        exit: exitPrice,
        pnlPct: `${pnlPct.toFixed(3)}%`,
        pnlUsdt: `${pnl.toFixed(4)} USDT`,
        heldMinutes: heldMinutes.toFixed(1),
        stats: this.riskManager.getStats(),
      });
      this.store.addEvent(pnl >= 0 ? 'info' : 'warn', `Position closed (${reason})`, {
        pnlUsdt: pnl,
        pnlPct,
        entry: pos.entryPrice,
        exit: exitPrice,
      });
    } catch (err) {
      logger.error('Failed to close position', { error: String(err) });
    } finally {
      this.openPosition = null;
    }
  }
}
