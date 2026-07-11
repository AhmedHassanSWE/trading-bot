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
 * Score required: ≥90 / 100
 *
 * Score breakdown (max 100):
 *   Bitcoin Health ............ 20
 *   Trend Quality ............. 20
 *   EMA Alignment ............. 15
 *   Pullback Quality .......... 15
 *   Volume Confirmation ....... 15
 *   Resistance Distance ....... 10
 *   Momentum / ADX ............  5
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
  bitcoinHealth: number;      // max 20
  trendQuality: number;       // max 20
  emaAlignment: number;       // max 15
  pullbackQuality: number;    // max 15
  volumeConfirmation: number; // max 15
  resistanceDistance: number; // max 10
  momentumAdx: number;        // max  5
  total: number;              // max 100
}

export interface BitcoinAnalysis {
  bias: 'bullish' | 'bearish' | 'sideways';
  trendStrength: 'strong' | 'moderate' | 'weak';
  volatility: 'high' | 'normal' | 'low';
  healthy: boolean;
  reason: string;
}

// ─── Internal indicator snapshot ──────────────────────────────────────────────

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

// ─── Strategy ─────────────────────────────────────────────────────────────────

export class ScalpingStrategy {
  private readonly TP_PCT   = 0.005; // +0.5%
  private readonly SL_PCT   = 0.006; // −0.6%
  private readonly MIN_SCORE = 90;   // execute if score ≥ 90

  // ── Step 1: Bitcoin health gate ────────────────────────────────────────────

  analyzeBitcoin(candles1h: Candle[], candles15m: Candle[]): BitcoinAnalysis {
    const snap1h  = this.buildSnapshot(candles1h);
    const snap15m = this.buildSnapshot(candles15m);

    if (!snap1h || !snap15m) {
      return { bias: 'sideways', trendStrength: 'weak', volatility: 'normal', healthy: false, reason: 'Insufficient BTC candle data' };
    }

    // If BTC ATR on 1h exceeds 1.5% the market is too chaotic to trade alts
    if (snap1h.atrPct > 0.015) {
      return { bias: 'sideways', trendStrength: 'weak', volatility: 'high', healthy: false,
        reason: `BTC 1h too volatile — ATR ${(snap1h.atrPct * 100).toFixed(2)}% (max 1.5%)` };
    }

    const bullish1h  = snap1h.price > snap1h.ema20 && snap1h.ema20 > snap1h.ema50;
    const bearish1h  = snap1h.price < snap1h.ema20 && snap1h.ema20 < snap1h.ema50;
    const sideways1h = !bullish1h && !bearish1h;
    const bullish15m = snap15m.price > snap15m.ema20 && snap15m.ema20 > snap15m.ema50;

    if (bearish1h) {
      return { bias: 'bearish', trendStrength: 'strong', volatility: 'normal', healthy: false,
        reason: `BTC 1h bearish — price below EMA20 (${snap1h.ema20.toFixed(0)}) and EMA20 < EMA50` };
    }

    if (sideways1h || snap1h.adx < 18) {
      return { bias: 'sideways', trendStrength: 'weak', volatility: 'normal', healthy: false,
        reason: `BTC sideways — ADX ${snap1h.adx.toFixed(1)} (min 18), EMA alignment unclear` };
    }

    if (!bullish15m) {
      return { bias: 'bullish', trendStrength: 'moderate', volatility: 'normal', healthy: false,
        reason: `BTC 1h bullish but 15m pulling back — EMA20 (${snap15m.ema20.toFixed(0)}) > price (${snap15m.price.toFixed(0)}) on 15m` };
    }

    if (snap1h.rsi > 75) {
      return { bias: 'bullish', trendStrength: 'moderate', volatility: 'normal', healthy: false,
        reason: `BTC 1h RSI overbought at ${snap1h.rsi.toFixed(1)} — avoid chasing` };
    }

    const trendStrength: BitcoinAnalysis['trendStrength'] =
      snap1h.adx >= 30 ? 'strong' : snap1h.adx >= 22 ? 'moderate' : 'weak';

    return {
      bias: 'bullish',
      trendStrength,
      volatility: snap1h.atrPct > 0.008 ? 'high' : 'normal',
      healthy: true,
      reason: `BTC healthy — ADX ${snap1h.adx.toFixed(1)}, RSI ${snap1h.rsi.toFixed(1)}, 1h+15m aligned`,
    };
  }

  // ── Step 2–7: Per-coin analysis ────────────────────────────────────────────

  analyzeCoin(symbol: string, tf: MultiTimeframeCandles, btc: BitcoinAnalysis): TradeOpportunity {
    const lastPrice5m = tf.candles5m[tf.candles5m.length - 1]?.close ?? 0;

    const noTrade = (reason: string, collected: string[] = []): TradeOpportunity => ({
      symbol,
      shouldTrade: false,
      score: 0,
      scoreBreakdown: { bitcoinHealth: 0, trendQuality: 0, emaAlignment: 0, pullbackQuality: 0, volumeConfirmation: 0, resistanceDistance: 0, momentumAdx: 0, total: 0 },
      entryPrice: lastPrice5m,
      takeProfit: 0,
      stopLoss: 0,
      riskReward: `+${this.TP_PCT * 100}% / -${this.SL_PCT * 100}%`,
      trend: 'Unknown',
      bitcoinStatus: btc.reason,
      reasons: [],
      rejections: [reason, ...collected],
      summary: `NO TRADE [${symbol}] — ${reason}`,
    });

    const snap1h  = this.buildSnapshot(tf.candles1h);
    const snap15m = this.buildSnapshot(tf.candles15m);
    const snap5m  = this.buildSnapshot(tf.candles5m);

    if (!snap1h || !snap15m || !snap5m) {
      return noTrade('Insufficient candle data on one or more timeframes');
    }

    const price = snap5m.price;
    const reasons: string[]    = [];
    const rejections: string[] = [];

    // ── Component 1: Bitcoin Health (max 20) ──────────────────────────────────
    if (!btc.healthy) return noTrade(`BTC not healthy — ${btc.reason}`);

    const bitcoinHealth = btc.trendStrength === 'strong' ? 20
      : btc.trendStrength === 'moderate' ? 15 : 10;
    reasons.push(`BTC ${btc.trendStrength} uptrend (${btc.reason})`);

    // ── Component 2: Trend Quality (max 20) ───────────────────────────────────
    const bullish1h  = snap1h.price > snap1h.ema20 && snap1h.ema20 > snap1h.ema50 && snap1h.ema50 > snap1h.ema200;
    const bullish15m = snap15m.price > snap15m.ema20 && snap15m.ema20 > snap15m.ema50;
    const hh1h = snap1h.higherHighs;
    const hl1h = snap1h.higherLows;

    if (!bullish1h) {
      return noTrade(
        `1h EMA stack not bullish — price ${price.toFixed(4)} | EMA20 ${snap1h.ema20.toFixed(4)} | EMA50 ${snap1h.ema50.toFixed(4)} | EMA200 ${snap1h.ema200.toFixed(4)}`
      );
    }
    if (!hh1h || !hl1h) {
      return noTrade(
        `1h market structure broken — ${!hh1h ? 'no higher highs' : ''}${!hh1h && !hl1h ? ' and ' : ''}${!hl1h ? 'no higher lows' : ''}`
      );
    }
    if (!bullish15m) {
      return noTrade(
        `15m trend not aligned — price ${snap15m.price.toFixed(4)} below EMA20 ${snap15m.ema20.toFixed(4)} or EMA20 < EMA50`
      );
    }

    const trendQuality = 10 + (hh1h && hl1h ? 7 : 0) + (bullish15m ? 3 : 0);
    reasons.push(`1h+15m uptrend, HH/HL structure confirmed`);

    // ── Component 3: EMA Alignment on 5m (max 15) ─────────────────────────────
    if (!(snap5m.ema20 > 0 && snap5m.ema50 > 0 && snap5m.ema200 > 0)) {
      return noTrade('EMA200 not yet available on 5m — need more candle history');
    }

    const ema5mStack = snap5m.price > snap5m.ema20 && snap5m.ema20 > snap5m.ema50 && snap5m.ema50 > snap5m.ema200;

    if (!ema5mStack) {
      return noTrade(
        `5m EMA stack not bullish — price ${price.toFixed(4)} | EMA20 ${snap5m.ema20.toFixed(4)} | EMA50 ${snap5m.ema50.toFixed(4)} | EMA200 ${snap5m.ema200.toFixed(4)}`
      );
    }

    const emaAlignment = 15;
    reasons.push(`5m EMA20 > EMA50 > EMA200 bullish stack`);

    // ── Component 4: Pullback Quality (max 15) ────────────────────────────────
    // Hard reject: do not chase a large breakout candle
    const lastBody    = Math.abs(snap5m.lastCandle.close - snap5m.lastCandle.open);
    const lastBodyPct = lastBody / snap5m.lastCandle.open;

    if (lastBodyPct > this.TP_PCT * 1.5) {
      return noTrade(
        `Chasing breakout — last 5m candle body ${(lastBodyPct * 100).toFixed(2)}% (>${(this.TP_PCT * 1.5 * 100).toFixed(2)}%) — wait for pullback`
      );
    }

    // Hard reject: trend structure broken on 5m
    if (snap5m.price <= snap5m.ema50) {
      return noTrade(
        `5m price ${price.toFixed(4)} below EMA50 ${snap5m.ema50.toFixed(4)} — pullback too deep, trend at risk`
      );
    }

    const nearEma20 = snap5m.price <= snap5m.ema20 * 1.004 && snap5m.price >= snap5m.ema20 * 0.997;
    const nearEma50 = snap5m.price <= snap5m.ema50 * 1.005 && snap5m.price >= snap5m.ema50 * 0.997;
    const lastBullish  = snap5m.lastCandle.close > snap5m.lastCandle.open;
    const prevBearish  = snap5m.prevCandle.close < snap5m.prevCandle.open;
    const rsiHealthy   = snap5m.rsi >= 35 && snap5m.rsi <= 65;

    let pullbackQuality: number;

    if (lastBullish && prevBearish && (nearEma20 || nearEma50)) {
      // Perfect: price touched EMA, sold off, buyers returned — textbook pullback
      pullbackQuality = 15;
      reasons.push(`Textbook pullback to EMA${nearEma20 ? '20' : '50'} — bearish candle followed by bullish reversal`);
    } else if (lastBullish && prevBearish) {
      // Good: candle flip from red to green anywhere above EMAs
      pullbackQuality = 12;
      reasons.push(`Bearish-to-bullish candle flip — buyers returning after pullback`);
    } else if (lastBullish && rsiHealthy && !nearEma20) {
      // Acceptable: bullish continuation, RSI not overextended
      pullbackQuality = 8;
      reasons.push(`Bullish continuation — RSI ${snap5m.rsi.toFixed(1)}, trend intact`);
    } else if (lastBullish) {
      // Weak: bullish candle but RSI getting extended or other concern
      pullbackQuality = 5;
      rejections.push(`Weak pullback quality — RSI ${snap5m.rsi.toFixed(1)}, no candle flip`);
    } else {
      // No bullish candle — waiting for buyers
      return noTrade(
        `No bullish confirmation on 5m — last candle bearish (close ${snap5m.lastCandle.close.toFixed(4)} < open ${snap5m.lastCandle.open.toFixed(4)}) — waiting for buyers to return`
      );
    }

    // ── Component 5: Volume Confirmation (max 15) ─────────────────────────────
    const entryVolumeRising = snap5m.lastCandle.volume > snap5m.prevCandle.volume;
    const volumeAboveAvg    = snap5m.volumeRatio >= 1.0;

    let volumeConfirmation: number;

    if (entryVolumeRising && snap5m.volumeRatio >= 1.3) {
      volumeConfirmation = 15;
      reasons.push(`Strong volume surge — ${snap5m.volumeRatio.toFixed(2)}x average`);
    } else if (entryVolumeRising && volumeAboveAvg) {
      volumeConfirmation = 10;
      reasons.push(`Volume rising on entry candle — ${snap5m.volumeRatio.toFixed(2)}x average`);
    } else if (volumeAboveAvg) {
      volumeConfirmation = 5;
      reasons.push(`Volume at average — ${snap5m.volumeRatio.toFixed(2)}x`);
    } else {
      return noTrade(
        `Volume too low — ${snap5m.volumeRatio.toFixed(2)}x average (min 1.0x) — buyers not participating`
      );
    }

    // ── Component 6: Resistance Distance (max 10) ─────────────────────────────
    const nearestResistance    = Math.max(...snap5m.recentHighs.slice(-24));
    const distanceToResistance = (nearestResistance - price) / price;

    if (distanceToResistance < this.TP_PCT * 0.8) {
      return noTrade(
        `Resistance too close — ${(distanceToResistance * 100).toFixed(2)}% to resistance at ${nearestResistance.toFixed(4)} — need at least ${(this.TP_PCT * 0.8 * 100).toFixed(2)}% room`
      );
    }

    let resistanceDistance: number;
    if (distanceToResistance >= this.TP_PCT * 2) {
      resistanceDistance = 10;
      reasons.push(`Clear path — resistance ${(distanceToResistance * 100).toFixed(2)}% away`);
    } else if (distanceToResistance >= this.TP_PCT) {
      resistanceDistance = 7;
      reasons.push(`Adequate room — resistance ${(distanceToResistance * 100).toFixed(2)}% away`);
    } else {
      resistanceDistance = 4;
      reasons.push(`Tight path — resistance ${(distanceToResistance * 100).toFixed(2)}% away`);
    }

    // ── Component 7: Momentum / ADX (max 5) ───────────────────────────────────
    const adx5m       = snap5m.adx;
    const macdRising  = snap5m.macdHist > snap5m.macdHistPrev;
    const macdPositive = snap5m.macdHist > 0;

    if (adx5m < 20) {
      return noTrade(
        `5m ADX too low — ${adx5m.toFixed(1)} (min 20) — no clear trend to continue`
      );
    }

    let momentumAdx: number;
    if (macdPositive && macdRising && adx5m >= 28) {
      momentumAdx = 5;
      reasons.push(`Strong momentum — ADX ${adx5m.toFixed(1)}, MACD positive and rising`);
    } else if (macdRising && adx5m >= 23) {
      momentumAdx = 3;
      reasons.push(`Moderate momentum — ADX ${adx5m.toFixed(1)}, MACD accelerating`);
    } else {
      momentumAdx = 2;
      reasons.push(`Acceptable momentum — ADX ${adx5m.toFixed(1)}`);
    }

    // ── Final score ────────────────────────────────────────────────────────────
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

    const score       = scoreBreakdown.total;
    const entryPrice  = price;
    const takeProfit  = entryPrice * (1 + this.TP_PCT);
    const stopLoss    = entryPrice * (1 - this.SL_PCT);
    const shouldTrade = score >= this.MIN_SCORE;

    if (!shouldTrade) {
      rejections.push(`Score ${score}/100 below minimum ${this.MIN_SCORE}`);
      return {
        symbol,
        shouldTrade: false,
        score,
        scoreBreakdown,
        entryPrice,
        takeProfit,
        stopLoss,
        riskReward: `+${this.TP_PCT * 100}% / -${this.SL_PCT * 100}%`,
        trend: 'Bullish',
        bitcoinStatus: btc.reason,
        reasons,
        rejections,
        summary: `NO TRADE [${symbol}] — Score ${score}/100 (need ${this.MIN_SCORE}) | Weakest: ${this.weakestComponent(scoreBreakdown)}`,
      };
    }

    const confidence = score >= 97 ? 'Very High' : score >= 93 ? 'High' : 'Good';

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
      summary: `✅ TRADE [${symbol}] — Score ${score}/100 [${confidence}] | Entry ${entryPrice.toFixed(4)} | TP ${takeProfit.toFixed(4)} | SL ${stopLoss.toFixed(4)}`,
    };
  }

  // ── Find best opportunity across all coins ─────────────────────────────────

  findBestOpportunity(
    coins: { symbol: string; tf: MultiTimeframeCandles }[],
    btcCandles1h: Candle[],
    btcCandles15m: Candle[]
  ): { btc: BitcoinAnalysis; best: TradeOpportunity | null; all: TradeOpportunity[] } {
    const btc = this.analyzeBitcoin(btcCandles1h, btcCandles15m);

    if (!btc.healthy) {
      logger.info(`NO TRADE — Bitcoin gate: ${btc.reason}`);
      return { btc, best: null, all: [] };
    }

    logger.info(`Bitcoin OK — ${btc.reason}`);

    const results: TradeOpportunity[] = [];

    for (const coin of coins) {
      try {
        const opp = this.analyzeCoin(coin.symbol, coin.tf, btc);
        results.push(opp);

        // Log every coin's result for debugging
        if (opp.shouldTrade) {
          logger.info(opp.summary, { scoreBreakdown: opp.scoreBreakdown, reasons: opp.reasons });
        } else {
          logger.debug(`${opp.summary}`, {
            score: `${opp.score}/100`,
            scoreBreakdown: opp.scoreBreakdown,
            rejection: opp.rejections[0] ?? 'Score too low',
            allRejections: opp.rejections,
          });
        }
      } catch (err) {
        logger.warn(`Analysis error for ${coin.symbol}`, { error: String(err) });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const best = results.find((r) => r.shouldTrade) ?? null;

    // Always log the ranked summary so we know what's happening
    const ranked = results.map((r) =>
      `${r.symbol.replace('/USDT', '')} ${r.score}/100${r.shouldTrade ? ' ✅' : ''}`
    ).join(' | ');
    logger.info(`Scan complete: ${ranked || 'no results'}`);

    if (!best) {
      const top = results[0];
      if (top) {
        logger.info(`NO TRADE — Best: ${top.symbol} scored ${top.score}/100`, {
          topRejection: top.rejections[0] ?? 'Score below 90',
          scoreBreakdown: top.scoreBreakdown,
        });
      }
    }

    return { btc, best, all: results };
  }

  // ── Legacy adapter ─────────────────────────────────────────────────────────

  analyze(candles: Candle[]): TradeSignal {
    return {
      signal: 'none',
      price: candles[candles.length - 1]?.close ?? 0,
      reason: 'Use findBestOpportunity()',
      strength: 0,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private weakestComponent(s: ScoreBreakdown): string {
    const pcts = [
      { name: 'Bitcoin Health',   got: s.bitcoinHealth,      max: 20 },
      { name: 'Trend Quality',    got: s.trendQuality,        max: 20 },
      { name: 'EMA Alignment',    got: s.emaAlignment,        max: 15 },
      { name: 'Pullback Quality', got: s.pullbackQuality,     max: 15 },
      { name: 'Volume',           got: s.volumeConfirmation,  max: 15 },
      { name: 'Resistance',       got: s.resistanceDistance,  max: 10 },
      { name: 'Momentum/ADX',     got: s.momentumAdx,         max:  5 },
    ];
    const worst = pcts.reduce((a, b) => (a.got / a.max < b.got / b.max ? a : b));
    return `${worst.name} ${worst.got}/${worst.max}`;
  }

  private buildSnapshot(candles: Candle[]): TfSnapshot | null {
    if (candles.length < 210) return null;

    const closes  = candles.map((c) => c.close);
    const highs   = candles.map((c) => c.high);
    const lows    = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const ema20r  = EMA.calculate({ period: 20,  values: closes });
    const ema50r  = EMA.calculate({ period: 50,  values: closes });
    const ema200r = EMA.calculate({ period: 200, values: closes });
    const rsir    = RSI.calculate({ period: 14,  values: closes });
    const atrr    = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const adxr    = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const macdr   = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });

    if (!ema20r.length || !ema50r.length || !ema200r.length ||
        !rsir.length   || !atrr.length   || !adxr.length || macdr.length < 2) return null;

    const price  = closes[closes.length - 1];
    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

    // Higher highs / higher lows over last 20 candles (split into two halves)
    const LB  = 20;
    const rH  = highs.slice(-LB);
    const rL  = lows.slice(-LB);
    const mid = Math.floor(LB / 2);
    const higherHighs = Math.max(...rH.slice(mid)) > Math.max(...rH.slice(0, mid));
    const higherLows  = Math.min(...rL.slice(mid)) > Math.min(...rL.slice(0, mid));

    const rawAdx = adxr[adxr.length - 1];
    const adxVal = typeof rawAdx === 'number' ? rawAdx : (rawAdx as { adx: number }).adx;

    return {
      price,
      ema20:        ema20r[ema20r.length - 1],
      ema50:        ema50r[ema50r.length - 1],
      ema200:       ema200r[ema200r.length - 1],
      rsi:          rsir[rsir.length - 1],
      adx:          adxVal,
      atrPct:       atrr[atrr.length - 1] / price,
      macdHist:     macdr[macdr.length - 1].histogram ?? 0,
      macdHistPrev: macdr[macdr.length - 2].histogram ?? 0,
      higherHighs,
      higherLows,
      volumeRatio:  avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1,
      lastCandle:   candles[candles.length - 1],
      prevCandle:   candles[candles.length - 2],
      recentHighs:  highs,
      recentLows:   lows,
    };
  }
}

// ─── Logging helper (used by engine) ─────────────────────────────────────────

export function logSignal(signal: TradeSignal, symbol?: string): void {
  const pair = symbol ?? signal.symbol ?? '';
  if (signal.signal === 'none') {
    logger.debug(`${pair} ${signal.reason}`);
  } else {
    logger.info(`${pair} LONG signal`, { price: signal.price, reason: signal.reason });
  }
}
