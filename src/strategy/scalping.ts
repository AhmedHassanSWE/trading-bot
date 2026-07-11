import { EMA, RSI, ATR, MACD, BollingerBands } from 'technicalindicators';
import { Candle, TradeSignal } from '../types';
import { logger } from '../utils/logger';

/**
 * Enhanced multi-signal strategy.
 *
 * Entry types (in priority order):
 *  1. RSI Bounce      — RSI recovers from extreme oversold/overbought (strongest reversal)
 *  2. MACD Cross      — MACD histogram flips sign, confirming momentum shift
 *  3. BB Bounce       — Price taps Bollinger lower/upper band and reverses
 *  4. EMA Cross       — EMA 9/21 crossover with optional volume confirmation
 *  5. EMA Momentum    — Price riding the trend (EMA aligned + RSI in range)
 *
 * Volume is a bonus to signal strength, not a hard gate.
 * This generates significantly more trades while still filtering noise.
 */

interface StrategyConfig {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  atrPeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  bbPeriod: number;
  bbStdDev: number;
  minVolumeMultiplier: number;
}

const DEFAULT_CONFIG: StrategyConfig = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  rsiOversold: 33,
  rsiOverbought: 67,
  atrPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bbPeriod: 20,
  bbStdDev: 2,
  minVolumeMultiplier: 1.1,
};

interface Indicators {
  fastNow: number;
  fastPrev: number;
  slowNow: number;
  slowPrev: number;
  rsiNow: number;
  rsiPrev: number;
  atrNow: number;
  macdHist: number;
  macdHistPrev: number;
  bbUpper: number;
  bbLower: number;
  bbMiddle: number;
  currentPrice: number;
  prevPrice: number;
  volumeRatio: number;
}

export class ScalpingStrategy {
  private cfg: StrategyConfig;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  analyze(candles: Candle[]): TradeSignal {
    const minCandles = Math.max(this.cfg.macdSlow + this.cfg.macdSignal + 2, 30);
    if (candles.length < minCandles) {
      return { signal: 'none', price: 0, reason: 'Insufficient candle data', strength: 0 };
    }

    const ind = this.buildIndicators(candles);
    if (!ind) {
      return { signal: 'none', price: candles[candles.length - 1].close, reason: 'Indicators not ready', strength: 0 };
    }

    // ── 1. RSI Bounce (highest confidence reversal) ───────────────────────
    const rsiBullishBounce = ind.rsiPrev < this.cfg.rsiOversold && ind.rsiNow >= this.cfg.rsiOversold;
    const rsiBearishBounce = ind.rsiPrev > this.cfg.rsiOverbought && ind.rsiNow <= this.cfg.rsiOverbought;

    if (rsiBullishBounce) {
      return this.signal('long', ind, 0.90,
        `RSI bounce from oversold (${ind.rsiPrev.toFixed(1)} → ${ind.rsiNow.toFixed(1)})`);
    }
    if (rsiBearishBounce) {
      return this.signal('short', ind, 0.90,
        `RSI bounce from overbought (${ind.rsiPrev.toFixed(1)} → ${ind.rsiNow.toFixed(1)})`);
    }

    // ── 2. MACD Histogram Cross ──────────────────────────────────────────
    const macdBullishCross = ind.macdHistPrev < 0 && ind.macdHist >= 0;
    const macdBearishCross = ind.macdHistPrev > 0 && ind.macdHist <= 0;

    if (macdBullishCross && ind.rsiNow < this.cfg.rsiOverbought) {
      const strength = 0.80 + (ind.volumeRatio >= this.cfg.minVolumeMultiplier ? 0.08 : 0);
      return this.signal('long', ind, strength, `MACD histogram cross UP, RSI=${ind.rsiNow.toFixed(1)}`);
    }
    if (macdBearishCross && ind.rsiNow > this.cfg.rsiOversold) {
      const strength = 0.80 + (ind.volumeRatio >= this.cfg.minVolumeMultiplier ? 0.08 : 0);
      return this.signal('short', ind, strength, `MACD histogram cross DOWN, RSI=${ind.rsiNow.toFixed(1)}`);
    }

    // ── 3. Bollinger Band Bounce (mean reversion) ────────────────────────
    const bbBullishBounce =
      ind.prevPrice <= ind.bbLower && ind.currentPrice > ind.bbLower && ind.rsiNow < 50;
    const bbBearishBounce =
      ind.prevPrice >= ind.bbUpper && ind.currentPrice < ind.bbUpper && ind.rsiNow > 50;

    if (bbBullishBounce) {
      const strength = 0.78 + (ind.rsiNow < 40 ? 0.07 : 0) + (ind.volumeRatio >= this.cfg.minVolumeMultiplier ? 0.05 : 0);
      return this.signal('long', ind, strength,
        `BB lower band bounce, RSI=${ind.rsiNow.toFixed(1)}, BB_lower=${ind.bbLower.toFixed(2)}`);
    }
    if (bbBearishBounce) {
      const strength = 0.78 + (ind.rsiNow > 60 ? 0.07 : 0) + (ind.volumeRatio >= this.cfg.minVolumeMultiplier ? 0.05 : 0);
      return this.signal('short', ind, strength,
        `BB upper band bounce, RSI=${ind.rsiNow.toFixed(1)}, BB_upper=${ind.bbUpper.toFixed(2)}`);
    }

    // ── 4. Bollinger Band Breakout (momentum continuation) ───────────────
    const bbBullishBreakout =
      ind.prevPrice < ind.bbUpper && ind.currentPrice >= ind.bbUpper &&
      ind.rsiNow > 50 && ind.rsiNow < this.cfg.rsiOverbought;
    const bbBearishBreakout =
      ind.prevPrice > ind.bbLower && ind.currentPrice <= ind.bbLower &&
      ind.rsiNow < 50 && ind.rsiNow > this.cfg.rsiOversold;

    if (bbBullishBreakout && ind.volumeRatio >= this.cfg.minVolumeMultiplier) {
      return this.signal('long', ind, 0.82,
        `BB upper breakout, RSI=${ind.rsiNow.toFixed(1)}, vol=${ind.volumeRatio.toFixed(2)}x`);
    }
    if (bbBearishBreakout && ind.volumeRatio >= this.cfg.minVolumeMultiplier) {
      return this.signal('short', ind, 0.82,
        `BB lower breakout, RSI=${ind.rsiNow.toFixed(1)}, vol=${ind.volumeRatio.toFixed(2)}x`);
    }

    // ── 5. EMA Cross ──────────────────────────────────────────────────────
    const emaBullishCross = ind.fastPrev <= ind.slowPrev && ind.fastNow > ind.slowNow;
    const emaBearishCross = ind.fastPrev >= ind.slowPrev && ind.fastNow < ind.slowNow;

    if (emaBullishCross && ind.rsiNow < this.cfg.rsiOverbought) {
      const strength = 0.72 + (ind.volumeRatio >= this.cfg.minVolumeMultiplier ? 0.10 : 0) + (ind.rsiNow > 40 && ind.rsiNow < 60 ? 0.05 : 0);
      return this.signal('long', ind, strength,
        `EMA 9/21 bullish cross, RSI=${ind.rsiNow.toFixed(1)}, vol=${ind.volumeRatio.toFixed(2)}x`);
    }
    if (emaBearishCross && ind.rsiNow > this.cfg.rsiOversold) {
      const strength = 0.72 + (ind.volumeRatio >= this.cfg.minVolumeMultiplier ? 0.10 : 0) + (ind.rsiNow > 40 && ind.rsiNow < 60 ? 0.05 : 0);
      return this.signal('short', ind, strength,
        `EMA 9/21 bearish cross, RSI=${ind.rsiNow.toFixed(1)}, vol=${ind.volumeRatio.toFixed(2)}x`);
    }

    // ── 6. EMA Momentum Continuation ─────────────────────────────────────
    const trendUp = ind.fastNow > ind.slowNow;
    const trendDown = ind.fastNow < ind.slowNow;
    const rsiMomentumLong = ind.rsiNow > 45 && ind.rsiNow < this.cfg.rsiOverbought;
    const rsiMomentumShort = ind.rsiNow < 55 && ind.rsiNow > this.cfg.rsiOversold;

    if (trendUp && rsiMomentumLong && ind.volumeRatio >= this.cfg.minVolumeMultiplier) {
      const strength = 0.60 + (ind.rsiNow > 50 && ind.rsiNow < 65 ? 0.08 : 0);
      return this.signal('long', ind, strength,
        `EMA momentum UP, RSI=${ind.rsiNow.toFixed(1)}, vol=${ind.volumeRatio.toFixed(2)}x`);
    }
    if (trendDown && rsiMomentumShort && ind.volumeRatio >= this.cfg.minVolumeMultiplier) {
      const strength = 0.60 + (ind.rsiNow < 50 && ind.rsiNow > 35 ? 0.08 : 0);
      return this.signal('short', ind, strength,
        `EMA momentum DOWN, RSI=${ind.rsiNow.toFixed(1)}, vol=${ind.volumeRatio.toFixed(2)}x`);
    }

    return {
      signal: 'none',
      price: ind.currentPrice,
      reason: `No setup — RSI=${ind.rsiNow.toFixed(1)}, EMA_fast=${ind.fastNow.toFixed(2)} EMA_slow=${ind.slowNow.toFixed(2)}, MACD_hist=${ind.macdHist.toFixed(2)}, vol=${ind.volumeRatio.toFixed(2)}x`,
      strength: 0,
    };
  }

  private signal(
    direction: 'long' | 'short',
    ind: Indicators,
    strength: number,
    reason: string
  ): TradeSignal {
    return {
      signal: direction,
      price: ind.currentPrice,
      reason,
      strength: Math.min(strength, 1),
    };
  }

  private buildIndicators(candles: Candle[]): Indicators | null {
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    const emaFast = EMA.calculate({ period: this.cfg.emaFast, values: closes });
    const emaSlow = EMA.calculate({ period: this.cfg.emaSlow, values: closes });
    const rsi = RSI.calculate({ period: this.cfg.rsiPeriod, values: closes });
    const atr = ATR.calculate({
      period: this.cfg.atrPeriod,
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: closes,
    });
    const macdResult = MACD.calculate({
      values: closes,
      fastPeriod: this.cfg.macdFast,
      slowPeriod: this.cfg.macdSlow,
      signalPeriod: this.cfg.macdSignal,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const bb = BollingerBands.calculate({
      values: closes,
      period: this.cfg.bbPeriod,
      stdDev: this.cfg.bbStdDev,
    });

    if (
      emaFast.length < 2 || emaSlow.length < 2 || rsi.length < 2 ||
      atr.length < 1 || macdResult.length < 2 || bb.length < 1
    ) {
      return null;
    }

    const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

    const lastMacd = macdResult[macdResult.length - 1];
    const prevMacd = macdResult[macdResult.length - 2];
    const lastBb = bb[bb.length - 1];

    return {
      fastNow: emaFast[emaFast.length - 1],
      fastPrev: emaFast[emaFast.length - 2],
      slowNow: emaSlow[emaSlow.length - 1],
      slowPrev: emaSlow[emaSlow.length - 2],
      rsiNow: rsi[rsi.length - 1],
      rsiPrev: rsi[rsi.length - 2],
      atrNow: atr[atr.length - 1],
      macdHist: lastMacd.histogram ?? 0,
      macdHistPrev: prevMacd.histogram ?? 0,
      bbUpper: lastBb.upper,
      bbLower: lastBb.lower,
      bbMiddle: lastBb.middle,
      currentPrice: closes[closes.length - 1],
      prevPrice: closes[closes.length - 2],
      volumeRatio,
    };
  }
}

export function logSignal(signal: TradeSignal, symbol?: string): void {
  const pair = symbol ?? signal.symbol ?? '';
  const prefix = pair ? `${pair} ` : '';

  if (signal.signal === 'none') {
    logger.debug(`${prefix}${signal.reason}`);
  } else {
    logger.info(`${prefix}Signal: ${signal.signal.toUpperCase()} (strength: ${(signal.strength * 100).toFixed(0)}%)`, {
      price: signal.price,
      reason: signal.reason,
    });
  }
}
