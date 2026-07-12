import { config } from '../config';
import { logger } from '../utils/logger';
import { BotStats, PortfolioBalance, PositionSize, Signal } from '../types';

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

  /**
   * Trading equity = bot capital that compounds from tradingCapital,
   * never larger than free USDT on the exchange.
   *
   * Example: start 1000, realized +5 → size next trade with min(free, 1005).
   * Testnet wallet of 14000 will NOT be used — capped at bot capital.
   */
  private tradingEquity(freeUsdt: number, realizedPnlUsdt: number): number {
    const botCapital = config.trading.tradingCapital + realizedPnlUsdt;
    return Math.min(freeUsdt, Math.max(botCapital, 0));
  }

  canTrade(
    portfolio: PortfolioBalance,
    realizedPnlUsdt = 0
  ): { allowed: boolean; reason: string } {
    this.resetIfNewDay();

    const equity = this.tradingEquity(portfolio.freeUsdt, realizedPnlUsdt);

    if (equity < config.trading.minOrderUsdt) {
      return {
        allowed: false,
        reason: `Insufficient trading capital: ${equity.toFixed(4)} USDT (minimum ${config.trading.minOrderUsdt})`,
      };
    }

    const maxDailyLoss = config.trading.tradingCapital * config.risk.maxDailyLossPercent;
    if (this.stats.dailyPnl <= -maxDailyLoss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: ${this.stats.dailyPnl.toFixed(4)} USDT`,
      };
    }

    return { allowed: true, reason: 'OK' };
  }

  /**
   * Size from bot capital only (tradingCapital + realized PnL), capped by free USDT.
   * At TP (+0.5%) on ~1000 → ~+$5, not tens of dollars from full testnet wallet.
   */
  calculatePositionSize(
    portfolio: PortfolioBalance,
    entryPrice: number,
    signal: Signal,
    realizedPnlUsdt = 0
  ): PositionSize | null {
    if (signal === 'none' || entryPrice <= 0) return null;

    const equity = this.tradingEquity(portfolio.freeUsdt, realizedPnlUsdt);
    const takeProfitPercent = config.risk.takeProfitPercent;
    const stopDistance = entryPrice * config.risk.stopLossPercent;

    if (stopDistance <= 0 || takeProfitPercent <= 0 || equity <= 0) return null;

    const maxNotional = Math.min(
      portfolio.freeUsdt * 0.99,
      equity * config.trading.maxPositionPercent
    );

    // With stopLossPercent == maxRiskPerTrade, this ≈ full equity (then capped by maxNotional)
    const riskAmount = equity * config.risk.maxRiskPerTrade;
    const riskBasedNotional = (riskAmount / stopDistance) * entryPrice;

    const notionalUsdt = Math.min(riskBasedNotional, maxNotional);

    if (notionalUsdt < config.trading.minOrderUsdt) {
      logger.warn('Position too small for exchange minimum', {
        notional: notionalUsdt.toFixed(4),
        equity: equity.toFixed(4),
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

    logger.info('Position sized (capped to bot capital)', {
      botCapital: `${equity.toFixed(4)} USDT`,
      walletFree: `${portfolio.freeUsdt.toFixed(4)} USDT`,
      notional: `${notionalUsdt.toFixed(4)} USDT`,
      expectedProfitAtTp: `${expectedProfit.toFixed(4)} USDT`,
      riskAtStop: `${actualRisk.toFixed(4)} USDT`,
      takeProfitPct: `${(takeProfitPercent * 100).toFixed(2)}%`,
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
