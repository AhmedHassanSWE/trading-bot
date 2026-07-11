import { config } from '../config';
import { logger } from '../utils/logger';
import { BotStats, PortfolioBalance, PositionSize, Signal, WalletBalance } from '../types';

export class RiskManager {
  private stats: BotStats = {
    tradesToday: 0,
    winsToday: 0,
    lossesToday: 0,
    dailyPnl: 0,
    lastTradeAt: null,
  };

  private dayStart: string = this.todayKey();

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private resetIfNewDay(): void {
    const today = this.todayKey();
    if (today !== this.dayStart) {
      this.stats = {
        tradesToday: 0,
        winsToday: 0,
        lossesToday: 0,
        dailyPnl: 0,
        lastTradeAt: null,
      };
      this.dayStart = today;
      logger.info('Daily stats reset for new trading day');
    }
  }

  canTrade(portfolio: PortfolioBalance): { allowed: boolean; reason: string } {
    this.resetIfNewDay();

    const equity = Math.min(portfolio.freeUsdt, config.trading.tradingCapital);

    if (equity < config.trading.minOrderUsdt) {
      return {
        allowed: false,
        reason: `Insufficient USDT: ${equity.toFixed(2)} (minimum ${config.trading.minOrderUsdt} USDT required)`,
      };
    }

    const maxDailyLoss = config.trading.tradingCapital * config.risk.maxDailyLossPercent;
    if (this.stats.dailyPnl <= -maxDailyLoss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: ${this.stats.dailyPnl.toFixed(2)} USDT`,
      };
    }

    return { allowed: true, reason: 'OK' };
  }

  /**
   * Size the position based on the risk budget (maxRiskPerTrade × equity).
   * Loss at stop ≤ maxRiskPerTrade × equity. Capped by maxPositionPercent.
   */
  calculatePositionSize(
    portfolio: PortfolioBalance,
    entryPrice: number,
    signal: Signal
  ): PositionSize | null {
    if (signal === 'none' || entryPrice <= 0) return null;

    const equity = Math.min(portfolio.freeUsdt, config.trading.tradingCapital);
    const takeProfitPercent = config.risk.takeProfitPercent;
    const stopDistance = entryPrice * config.risk.stopLossPercent;

    if (stopDistance <= 0 || takeProfitPercent <= 0) return null;

    const maxNotional = Math.min(
      portfolio.freeUsdt * 0.99,
      equity * config.trading.maxPositionPercent
    );

    // Size based on risk budget: lose at most maxRiskPerTrade * equity at stop
    const riskAmount = equity * config.risk.maxRiskPerTrade;
    const riskBasedNotional = (riskAmount / stopDistance) * entryPrice;

    let notionalUsdt = Math.min(riskBasedNotional, maxNotional);

    if (notionalUsdt < config.trading.minOrderUsdt) {
      logger.warn('Position too small for exchange minimum', {
        notional: notionalUsdt.toFixed(2),
        min: config.trading.minOrderUsdt,
      });
      return null;
    }

    const quantity = notionalUsdt / entryPrice;
    const stopLossPrice =
      signal === 'long'
        ? entryPrice * (1 - config.risk.stopLossPercent)
        : entryPrice * (1 + config.risk.stopLossPercent);

    const takeProfitPrice =
      signal === 'long'
        ? entryPrice * (1 + takeProfitPercent)
        : entryPrice * (1 - takeProfitPercent);

    const actualRisk = notionalUsdt * config.risk.stopLossPercent;

    const expectedProfit = notionalUsdt * takeProfitPercent;
    logger.info('Position sized', {
      notional: `${notionalUsdt.toFixed(2)} USDT`,
      expectedProfit: `${expectedProfit.toFixed(2)} USDT`,
      riskAtStop: `${actualRisk.toFixed(2)} USDT`,
      takeProfitPct: `${(takeProfitPercent * 100).toFixed(1)}%`,
    });

    return {
      quantity,
      notionalUsdt,
      stopLossPrice,
      takeProfitPrice,
      riskAmount: actualRisk,
    };
  }

  getRewardRiskRatio(): number {
    return config.risk.takeProfitPercent / config.risk.stopLossPercent;
  }

  recordTrade(pnl: number): void {
    this.resetIfNewDay();
    this.stats.tradesToday += 1;
    this.stats.dailyPnl += pnl;
    this.stats.lastTradeAt = Date.now();

    if (pnl >= 0) {
      this.stats.winsToday += 1;
    } else {
      this.stats.lossesToday += 1;
    }
  }

  getStats(): BotStats {
    this.resetIfNewDay();
    return { ...this.stats };
  }

  importStats(stats: BotStats, dayStart: string): void {
    this.stats = { ...stats };
    this.dayStart = dayStart;
    this.resetIfNewDay();
  }

  exportStats(): { stats: BotStats; dayStart: string } {
    this.resetIfNewDay();
    return { stats: { ...this.stats }, dayStart: this.dayStart };
  }
}
