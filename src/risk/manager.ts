import { config } from '../config';
import { logger } from '../utils/logger';
import { BotStats, PositionSize, Signal, WalletBalance } from '../types';

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

  canTrade(wallet: WalletBalance): { allowed: boolean; reason: string } {
    this.resetIfNewDay();

    if (wallet.freeUsdt < config.trading.minOrderUsdt) {
      return {
        allowed: false,
        reason: `Insufficient balance: ${wallet.freeUsdt.toFixed(2)} USDT (min ${config.trading.minOrderUsdt})`,
      };
    }

    const maxDailyLoss = wallet.totalUsdt * config.risk.maxDailyLossPercent;
    if (this.stats.dailyPnl <= -maxDailyLoss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: ${this.stats.dailyPnl.toFixed(2)} USDT`,
      };
    }

    return { allowed: true, reason: 'OK' };
  }

  /**
   * Position sizing: risk exactly maxRiskPerTrade % of total wallet.
   * Uses full available capital only as the notional cap — actual size
   * is driven by stop distance so dollar risk stays at 0.2%.
   */
  calculatePositionSize(
    wallet: WalletBalance,
    entryPrice: number,
    signal: Signal
  ): PositionSize | null {
    if (signal === 'none' || entryPrice <= 0) return null;

    const riskAmount = wallet.totalUsdt * config.risk.maxRiskPerTrade;
    const stopDistance = entryPrice * config.risk.stopLossPercent;

    if (stopDistance <= 0) return null;

    let quantity = riskAmount / stopDistance;

    const maxNotional = wallet.freeUsdt * 0.99;
    const notionalUsdt = quantity * entryPrice;

    if (notionalUsdt > maxNotional) {
      quantity = maxNotional / entryPrice;
    }

    if (quantity * entryPrice < config.trading.minOrderUsdt) {
      logger.warn('Position too small for exchange minimum', {
        notional: quantity * entryPrice,
        min: config.trading.minOrderUsdt,
      });
      return null;
    }

    const takeProfitPercent = this.pickTakeProfit(signal);
    const stopLossPrice =
      signal === 'long'
        ? entryPrice * (1 - config.risk.stopLossPercent)
        : entryPrice * (1 + config.risk.stopLossPercent);

    const takeProfitPrice =
      signal === 'long'
        ? entryPrice * (1 + takeProfitPercent)
        : entryPrice * (1 - takeProfitPercent);

    return {
      quantity,
      notionalUsdt: quantity * entryPrice,
      stopLossPrice,
      takeProfitPrice,
      riskAmount,
    };
  }

  private pickTakeProfit(_signal: Signal): number {
    const { takeProfitMin, takeProfitMax } = config.risk;
    return takeProfitMin + (takeProfitMax - takeProfitMin) * 0.5;
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

  getRewardRiskRatio(): number {
    const avgTp =
      (config.risk.takeProfitMin + config.risk.takeProfitMax) / 2;
    return avgTp / config.risk.stopLossPercent;
  }
}
