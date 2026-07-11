/**
 * Strategy: Trend Continuation After Pullback
 *
 * Philosophy: Do not trade. Wait. Only enter when almost everything aligns.
 * A missed trade is acceptable. A low-quality trade is not.
 *
 * Timeframes:
 *   1h  — trend direction
 *   15m — trend health
 *   5m  — entry timing
 *
 * Score required: ≥95 / 100
 */

import { EMA, RSI, ATR, MACD, ADX } from 'technicalindicators';
import { Candle, TradeSignal } from '../types';
import { logger } from '../utils/logger';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MultiTimeframeCandles {
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
}

export interface TradeOpportunity {
  symbol: string;
  shouldTrade: boolean;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  riskReward: string;
  trend: string;
  bitcoinStatus: string;
  reasons: string[];
  rejections: string[];
  summary: string;
}

export interface ScoreBreakdown {
  bitcoinHealth: number;     // max 20
  trendQuality: number;      // max 20
  emaAlignment: number;      // max 15
  pullbackQuality: number;   // max 15
  volumeConfirmation: number;// max 15
  resistanceDistance: number;// max 10
  momentumAdx: number;       // max 5
  total: number;             // max 100
}

export interface BitcoinAnalysis {
  bias: 'bullish' | 'bearish' | 'sideways';
  trendStrength: 'strong' | 'moderate' | 'weak';
  volatility: 'high' | 'normal' | 'low';
  healthy: boolean;
  reason: string;
}

// ─── Internal indicator snapshots ─────────────────────────────────────────────

interface TfSnapshot {
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  adx: number;
  atrPct: number;
  macdHist: number;
  macdHistPrev: number;
  higherHighs: boolean;
  higherLows: boolean;
  volumeRatio: number;
  lastCandle: Candle;
  prevCandle: Candle;
  recentHighs: number[];
  recentLows: number[];
}

// ─── Strategy class ───────────────────────────────────────────────────────────

export class ScalpingStrategy {
  private readonly TP_PCT = 0.005;   // +0.5%
  private readonly SL_PCT = 0.006;   // −0.6%
  private readonly MIN_SCORE = 95;   // must reach 95/100

  // ── Bitcoin health gate ─────────────────────────────────────────────────────

  analyzeBitcoin(candles1h: Candle[], candles15m: Candle[]): BitcoinAnalysis {
    const snap1h = this.buildSnapshot(candles1h);
    const snap15m = this.buildSnapshot(candles15m);

    if (!snap1h || !snap15m) {
      return { bias: 'sideways', trendStrength: 'weak', volatility: 'normal', healthy: false, reason: 'Insufficient BTC candle data' };
    }

    // Volatility check — if ATR > 1.5% on 1h, market is too chaotic
    if (snap1h.atrPct > 0.015) {
      return { bias: 'sideways', trendStrength: 'weak', volatility: 'high', healthy: false, reason: `BTC extremely volatile (ATR ${(snap1h.atrPct * 100).toFixed(2)}% on 1h)` };
    }

    // Trend direction from 1h EMA stack
    const bullish1h = snap1h.price > snap1h.ema20 && snap1h.ema20 > snap1h.ema50;
    const bearish1h = snap1h.price < snap1h.ema20 && snap1h.ema20 < snap1h.ema50;
    const sideways1h = !bullish1h && !bearish1h;

    // 15m must agree
    const bullish15m = snap15m.price > snap15m.ema20 && snap15m.ema20 > snap15m.ema50;

    if (bearish1h) {
      return { bias: 'bearish', trendStrength: 'strong', volatility: 'normal', healthy: false, reason: 'BTC 1h trend is bearish (EMA20 < EMA50)' };
    }

    if (sideways1h || snap1h.adx < 20) {
      return { bias: 'sideways', trendStrength: 'weak', volatility: 'normal', healthy: false, reason: `BTC trending sideways (ADX ${snap1h.adx.toFixed(1)})` };
    }

    if (!bullish15m) {
      return { bias: 'bullish', trendStrength: 'moderate', volatility: 'normal', healthy: false, reason: 'BTC 1h bullish but 15m not confirming — possible pullback in progress' };
    }

    // RSI must not be overbought (no chasing)
    if (snap1h.rsi > 72) {
      return { bias: 'bullish', trendStrength: 'moderate', volatility: 'normal', healthy: false, reason: `BTC 1h RSI overbought (${snap1h.rsi.toFixed(1)})` };
    }

    const trendStrength: BitcoinAnalysis['trendStrength'] =
      snap1h.adx >= 30 ? 'strong' : snap1h.adx >= 22 ? 'moderate' : 'weak';

    return {
      bias: 'bullish',
      trendStrength,
      volatility: snap1h.atrPct > 0.008 ? 'high' : 'normal',
      healthy: true,
      reason: `BTC bullish on 1h and 15m. ADX ${snap1h.adx.toFixed(1)}, RSI ${snap1h.rsi.toFixed(1)}`,
    };
  }

  // ── Full coin analysis ──────────────────────────────────────────────────────

  analyzeCoin(
    symbol: string,
    tf: MultiTimeframeCandles,
    btc: BitcoinAnalysis
  ): TradeOpportunity {
    const noTrade = (reason: string, extra: string[] = []): TradeOpportunity => ({
      symbol,
      shouldTrade: false,
      score: 0,
      scoreBreakdown: { bitcoinHealth: 0, trendQuality: 0, emaAlignment: 0, pullbackQuality: 0, volumeConfirmation: 0, resistanceDistance: 0, momentumAdx: 0, total: 0 },
      entryPrice: tf.candles5m[tf.candles5m.length - 1]?.close ?? 0,
      takeProfit: 0,
      stopLoss: 0,
      riskReward: '0.5:0.6',
      trend: 'Unknown',
      bitcoinStatus: btc.reason,
      reasons: [],
      rejections: [reason, ...extra],
      summary: `NO TRADE — ${reason}`,
    });

    const snap1h  = this.buildSnapshot(tf.candles1h);
    const snap15m = this.buildSnapshot(tf.candles15m);
    const snap5m  = this.buildSnapshot(tf.candles5m);

    if (!snap1h || !snap15m || !snap5m) return noTrade('Insufficient candle data for one or more timeframes');

    const price = snap5m.price;
    const reasons: string[] = [];
    const rejections: string[] = [];

    // ─── Component 1: Bitcoin Health (max 20) ─────────────────────────────────
    let bitcoinHealth = 0;
    if (!btc.healthy) {
      return noTrade(`Bitcoin not healthy: ${btc.reason}`);
    }
    bitcoinHealth = btc.trendStrength === 'strong' ? 20 : btc.trendStrength === 'moderate' ? 15 : 10;
    reasons.push(`BTC ${btc.trendStrength} uptrend confirmed`);

    // ─── Component 2: Trend Quality (max 20) ──────────────────────────────────
    let trendQuality = 0;

    const bullish1h = snap1h.price > snap1h.ema20 && snap1h.ema20 > snap1h.ema50 && snap1h.ema50 > snap1h.ema200;
    const bullish15m = snap15m.price > snap15m.ema20 && snap15m.ema20 > snap15m.ema50;
    const hh1h = snap1h.higherHighs;
    const hl1h = snap1h.higherLows;

    if (!bullish1h) {
      rejections.push(`1h trend weak — price not above EMA20/50/200`);
      return noTrade('1h EMA stack not bullish', rejections);
    }
    if (!hh1h || !hl1h) {
      rejections.push(`1h market structure broken — no HH/HL`);
      return noTrade('Market structure not showing higher highs and higher lows on 1h', rejections);
    }
    if (!bullish15m) {
      rejections.push(`15m trend not confirming 1h`);
      return noTrade('15m trend not aligned with 1h', rejections);
    }

    trendQuality = (bullish1h ? 10 : 0) + (hh1h && hl1h ? 7 : 0) + (bullish15m ? 3 : 0);
    reasons.push(`Strong uptrend on 1h and 15m with HH/HL structure`);

    // ─── Component 3: EMA Alignment (max 15) ──────────────────────────────────
    let emaAlignment = 0;

    const ema5mFull = snap5m.ema20 > 0 && snap5m.ema50 > 0 && snap5m.ema200 > 0;
    const ema5mStack = snap5m.price > snap5m.ema20 && snap5m.ema20 > snap5m.ema50 && snap5m.ema50 > snap5m.ema200;

    if (!ema5mFull) {
      return noTrade('EMA200 not available on 5m — insufficient candle data');
    }
    if (!ema5mStack) {
      rejections.push(`5m EMA stack not bullish (price ${price.toFixed(4)} vs EMA20 ${snap5m.ema20.toFixed(4)})`);
      return noTrade('5m EMA alignment not bullish', rejections);
    }

    emaAlignment = 15;
    reasons.push(`Full EMA20/50/200 bullish stack on 5m`);

    // ─── Component 4: Pullback Quality (max 15) ───────────────────────────────
    // A good pullback: price pulled toward EMA20 on 5m but held above it,
    // with the last candle showing buyers returning.

    let pullbackQuality = 0;
    const pullbackToEma20 = snap5m.price <= snap5m.ema20 * 1.003 && snap5m.price >= snap5m.ema20 * 0.997;
    const pullbackToEma50 = snap5m.price <= snap5m.ema50 * 1.004 && snap5m.price >= snap5m.ema50 * 0.996;
    const aboveEma20 = snap5m.price > snap5m.ema20;
    const aboveEma50 = snap5m.price > snap5m.ema50;

    // Last candle must be green (buyers returned)
    const lastCandleBullish = snap5m.lastCandle.close > snap5m.lastCandle.open;
    // Previous candle should have been a red (down) candle = pullback
    const prevCandleWasBearish = snap5m.prevCandle.close < snap5m.prevCandle.open;
    // Pullback volume should be less than bullish move volume
    const pullbackLowVolume = snap5m.lastCandle.volume < snap5m.prevCandle.volume * 1.1;

    if (!aboveEma20 || !aboveEma50) {
      return noTrade('Price broke below EMA20 or EMA50 on 5m — pullback too deep', rejections);
    }

    if (lastCandleBullish && prevCandleWasBearish && (pullbackToEma20 || pullbackToEma50)) {
      pullbackQuality = 15;
      reasons.push(`Classic pullback to EMA${pullbackToEma20 ? '20' : '50'} with bullish reversal candle`);
    } else if (lastCandleBullish && prevCandleWasBearish) {
      pullbackQuality = 9;
      reasons.push(`Bearish-to-bullish candle flip — possible pullback entry`);
    } else if (lastCandleBullish) {
      pullbackQuality = 5;
      reasons.push(`Bullish continuation candle`);
    } else {
      // No bullish candle = no entry confirmation
      return noTrade('No bullish entry confirmation on 5m — waiting for buyers to return', rejections);
    }

    // ─── Component 5: Volume Confirmation (max 15) ────────────────────────────
    let volumeConfirmation = 0;
    // Entry candle volume should be rising vs pullback candle
    const entryVolumeRising = snap5m.lastCandle.volume > snap5m.prevCandle.volume;
    const volumeAboveAvg = snap5m.volumeRatio >= 1.0;

    if (entryVolumeRising && snap5m.volumeRatio >= 1.3) {
      volumeConfirmation = 15;
      reasons.push(`Volume surge on entry candle (${snap5m.volumeRatio.toFixed(2)}x avg)`);
    } else if (entryVolumeRising && volumeAboveAvg) {
      volumeConfirmation = 10;
      reasons.push(`Volume rising on entry candle`);
    } else if (volumeAboveAvg) {
      volumeConfirmation = 5;
    } else {
      rejections.push(`Low volume on entry (${snap5m.volumeRatio.toFixed(2)}x avg) — weak buyer interest`);
      return noTrade('Volume not confirming entry — buyers not participating', rejections);
    }

    // ─── Component 6: Resistance Distance (max 10) ────────────────────────────
    let resistanceDistance = 0;
    // Resistance = highest high in last 24 × 5m candles (2 hours)
    const nearestResistance = Math.max(...snap5m.recentHighs.slice(-24));
    const distanceToResistance = (nearestResistance - price) / price;
    const distanceToTp = this.TP_PCT; // 0.5%

    if (distanceToResistance < distanceToTp * 0.8) {
      return noTrade(
        `Not enough room to TP — resistance at ${nearestResistance.toFixed(4)} only ${(distanceToResistance * 100).toFixed(2)}% away (need ${(distanceToTp * 100).toFixed(1)}%)`,
        rejections
      );
    }

    if (distanceToResistance >= distanceToTp * 2) {
      resistanceDistance = 10;
      reasons.push(`Clear path to TP — resistance ${(distanceToResistance * 100).toFixed(2)}% away`);
    } else if (distanceToResistance >= distanceToTp) {
      resistanceDistance = 7;
      reasons.push(`Adequate room to TP`);
    } else {
      resistanceDistance = 4;
    }

    // ─── Component 7: Momentum / ADX (max 5) ──────────────────────────────────
    let momentumAdx = 0;
    const adx5m = snap5m.adx;
    const macdMomentum = snap5m.macdHist > 0 && snap5m.macdHist > snap5m.macdHistPrev;

    if (adx5m < 25) {
      rejections.push(`ADX too low on 5m (${adx5m.toFixed(1)}) — trend not strong enough`);
      return noTrade(`5m ADX ${adx5m.toFixed(1)} below minimum 25 — no strong trend to continue`, rejections);
    }

    if (macdMomentum && adx5m >= 30) {
      momentumAdx = 5;
      reasons.push(`MACD rising, ADX ${adx5m.toFixed(1)} — strong momentum`);
    } else if (macdMomentum || adx5m >= 28) {
      momentumAdx = 3;
      reasons.push(`Adequate momentum (ADX ${adx5m.toFixed(1)})`);
    } else {
      momentumAdx = 2;
    }

    // ─── Final score ───────────────────────────────────────────────────────────
    const scoreBreakdown: ScoreBreakdown = {
      bitcoinHealth,
      trendQuality,
      emaAlignment,
      pullbackQuality,
      volumeConfirmation,
      resistanceDistance,
      momentumAdx,
      total: bitcoinHealth + trendQuality + emaAlignment + pullbackQuality + volumeConfirmation + resistanceDistance + momentumAdx,
    };

    const score = scoreBreakdown.total;
    const entryPrice = price;
    const takeProfit = entryPrice * (1 + this.TP_PCT);
    const stopLoss   = entryPrice * (1 - this.SL_PCT);
    const shouldTrade = score >= this.MIN_SCORE;

    if (!shouldTrade) {
      return {
        symbol,
        shouldTrade: false,
        score,
        scoreBreakdown,
        entryPrice,
        takeProfit,
        stopLoss,
        riskReward: `${this.TP_PCT * 100}% / ${this.SL_PCT * 100}%`,
        trend: 'Bullish',
        bitcoinStatus: btc.reason,
        reasons,
        rejections: [...rejections, `Score ${score}/100 below minimum ${this.MIN_SCORE}`],
        summary: `NO TRADE — Score ${score}/100 (need ${this.MIN_SCORE}). Good setup but not enough confirmations.`,
      };
    }

    const confidence = score >= 98 ? 'Very High' : score >= 95 ? 'High' : 'Medium';

    return {
      symbol,
      shouldTrade: true,
      score,
      scoreBreakdown,
      entryPrice,
      takeProfit,
      stopLoss,
      riskReward: `+${this.TP_PCT * 100}% / -${this.SL_PCT * 100}%`,
      trend: 'Bullish continuation after pullback',
      bitcoinStatus: btc.reason,
      reasons,
      rejections,
      summary: `✅ TRADE — ${symbol} LONG | Score ${score}/100 [${confidence}] | Entry ${entryPrice.toFixed(4)} | TP ${takeProfit.toFixed(4)} | SL ${stopLoss.toFixed(4)}`,
    };
  }

  // ── Rank and pick best coin ─────────────────────────────────────────────────

  findBestOpportunity(
    coins: { symbol: string; tf: MultiTimeframeCandles }[],
    btcCandles1h: Candle[],
    btcCandles15m: Candle[]
  ): { btc: BitcoinAnalysis; best: TradeOpportunity | null; all: TradeOpportunity[] } {
    const btc = this.analyzeBitcoin(btcCandles1h, btcCandles15m);

    if (!btc.healthy) {
      logger.info(`NO TRADE — Bitcoin: ${btc.reason}`);
      return { btc, best: null, all: [] };
    }

    const results: TradeOpportunity[] = [];

    for (const coin of coins) {
      try {
        const opp = this.analyzeCoin(coin.symbol, coin.tf, btc);
        results.push(opp);
      } catch (err) {
        logger.warn(`Analysis failed for ${coin.symbol}`, { error: String(err) });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const best = results.find((r) => r.shouldTrade) ?? null;

    if (best) {
      logger.info(best.summary, {
        scoreBreakdown: best.scoreBreakdown,
        reasons: best.reasons,
      });
    } else {
      const top = results[0];
      if (top) {
        logger.info(`NO TRADE — Best candidate: ${top.symbol} scored ${top.score}/100`, {
          rejection: top.rejections[0] ?? 'Score too low',
        });
      } else {
        logger.info('NO TRADE — No coins passed initial filters');
      }
    }

    return { btc, best, all: results };
  }

  // ── Legacy adapter so engine compiles without changes ───────────────────────

  analyze(candles: Candle[]): TradeSignal {
    return { signal: 'none', price: candles[candles.length - 1]?.close ?? 0, reason: 'Use findBestOpportunity()', strength: 0 };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildSnapshot(candles: Candle[]): TfSnapshot | null {
    if (candles.length < 210) return null;

    const closes  = candles.map((c) => c.close);
    const highs   = candles.map((c) => c.high);
    const lows    = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const ema20r = EMA.calculate({ period: 20,  values: closes });
    const ema50r = EMA.calculate({ period: 50,  values: closes });
    const ema200r = EMA.calculate({ period: 200, values: closes });
    const rsir   = RSI.calculate({ period: 14,   values: closes });
    const atrr   = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const adxr   = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const macdr  = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });

    if (!ema20r.length || !ema50r.length || !ema200r.length || !rsir.length || !atrr.length || !adxr.length || macdr.length < 2) return null;

    const price  = closes[closes.length - 1];
    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

    // HH/HL over last 20 candles
    const lookback = 20;
    const rHigh = highs.slice(-lookback);
    const rLow  = lows.slice(-lookback);
    const mid   = Math.floor(lookback / 2);
    const higherHighs = Math.max(...rHigh.slice(mid)) > Math.max(...rHigh.slice(0, mid));
    const higherLows  = Math.min(...rLow.slice(mid))  > Math.min(...rLow.slice(0, mid));

    const rawAdx = adxr[adxr.length - 1];
    const adxVal = typeof rawAdx === 'number' ? rawAdx : (rawAdx as { adx: number }).adx;

    return {
      price,
      ema20:  ema20r[ema20r.length - 1],
      ema50:  ema50r[ema50r.length - 1],
      ema200: ema200r[ema200r.length - 1],
      rsi:    rsir[rsir.length - 1],
      adx:    adxVal,
      atrPct: atrr[atrr.length - 1] / price,
      macdHist:     macdr[macdr.length - 1].histogram ?? 0,
      macdHistPrev: macdr[macdr.length - 2].histogram ?? 0,
      higherHighs,
      higherLows,
      volumeRatio: avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1,
      lastCandle: candles[candles.length - 1],
      prevCandle: candles[candles.length - 2],
      recentHighs: highs,
      recentLows: lows,
    };
  }
}

// ─── Logging helper ───────────────────────────────────────────────────────────

export function logSignal(signal: TradeSignal, symbol?: string): void {
  const pair = symbol ?? signal.symbol ?? '';
  if (signal.signal === 'none') {
    logger.debug(`${pair} ${signal.reason}`);
  } else {
    logger.info(`${pair} LONG signal`, { price: signal.price, reason: signal.reason });
  }
}
