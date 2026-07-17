/**
 * Strategy: 4H Trend Pullback Swing
 *
 * NOT a scalp. Holds hours–days. Aims for fewer, higher-quality longs.
 *
 * Edge logic:
 *  • Trade only with the 4h trend (EMA stack + ADX)
 *  • Enter on a 1h pullback reclaim (buy the dip in an uptrend)
 *  • Wide TP/SL so noise + fees don't dominate (≈2:1 R:R)
 *
 * Targets (gross): TP ~3.5% · SL ~1.5%
 * After 0.2% fees → ~3.3% net / ~1.7% net loss → breakeven WR ≈ 34%
 */

import { EMA, RSI, ATR, MACD, ADX } from 'technicalindicators';
import { config } from '../config';
import { Candle, TradeSignal } from '../types';
import { logger } from '../utils/logger';

export interface MultiTimeframeCandles {
  /** Trend filter */
  candles4h: Candle[];
  /** Entry timing */
  candles1h: Candle[];
}

export interface ScoreBreakdown {
  bitcoinHealth: number;
  trendQuality: number;
  emaAlignment: number;
  pullbackQuality: number;
  volumeConfirmation: number;
  resistanceDistance: number;
  momentumAdx: number;
  total: number;
}

export interface BitcoinAnalysis {
  bias: 'bullish' | 'bearish' | 'sideways';
  trendStrength: 'strong' | 'moderate' | 'weak';
  volatility: 'high' | 'normal' | 'low';
  healthy: boolean;
  reason: string;
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

interface Snap {
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  prevRsi: number;
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

export class MediumRiskStrategy {
  private readonly TP_PCT = config.risk.takeProfitPercent;
  private readonly SL_PCT = config.risk.stopLossPercent;
  private readonly MIN_SCORE = config.position.minScore;

  analyzeBitcoin(candles4h: Candle[], _unused?: Candle[]): BitcoinAnalysis {
    const s = this.snap(candles4h, true);
    if (!s) {
      return {
        bias: 'sideways',
        trendStrength: 'weak',
        volatility: 'normal',
        healthy: true,
        reason: 'BTC 4h data limited — scanning carefully',
      };
    }

    const bull = s.price > s.ema50 && s.ema20 >= s.ema50;
    const bear = s.price < s.ema50 && s.ema20 <= s.ema50;

    // Hard block only clear 4h dumps — don't freeze on mild soft days
    if (bear && s.adx >= 22 && s.price < s.ema50 * 0.98) {
      return {
        bias: 'bearish',
        trendStrength: 'strong',
        volatility: 'normal',
        healthy: false,
        reason: `BTC 4h dump — ADX ${s.adx.toFixed(1)}`,
      };
    }

    if (bull) {
      const strength: BitcoinAnalysis['trendStrength'] =
        s.adx >= 25 ? 'strong' : s.adx >= 18 ? 'moderate' : 'weak';
      return {
        bias: 'bullish',
        trendStrength: strength,
        volatility: s.atrPct > 0.025 ? 'high' : 'normal',
        healthy: true,
        reason: `BTC 4h bullish — ADX ${s.adx.toFixed(1)}, RSI ${s.rsi.toFixed(1)}`,
      };
    }

    if (bear) {
      return {
        bias: 'bearish',
        trendStrength: s.adx >= 20 ? 'moderate' : 'weak',
        volatility: 'normal',
        healthy: true,
        reason: `BTC 4h soft — ADX ${s.adx.toFixed(1)} — need strong alt trend`,
      };
    }

    return {
      bias: 'sideways',
      trendStrength: 'weak',
      volatility: 'normal',
      healthy: true,
      reason: `BTC 4h mixed — ADX ${s.adx.toFixed(1)}`,
    };
  }

  analyzeCoin(symbol: string, tf: MultiTimeframeCandles, btc: BitcoinAnalysis): TradeOpportunity {
    const lastClose =
      tf.candles1h[tf.candles1h.length - 2]?.close ??
      tf.candles1h[tf.candles1h.length - 1]?.close ??
      0;

    const noTrade = (reason: string): TradeOpportunity => ({
      symbol,
      shouldTrade: false,
      score: 0,
      scoreBreakdown: {
        bitcoinHealth: 0,
        trendQuality: 0,
        emaAlignment: 0,
        pullbackQuality: 0,
        volumeConfirmation: 0,
        resistanceDistance: 0,
        momentumAdx: 0,
        total: 0,
      },
      entryPrice: lastClose,
      takeProfit: 0,
      stopLoss: 0,
      riskReward: `+${(this.TP_PCT * 100).toFixed(2)}% / -${(this.SL_PCT * 100).toFixed(2)}%`,
      trend: 'Unknown',
      bitcoinStatus: btc.reason,
      reasons: [],
      rejections: [reason],
      summary: `NO TRADE [${symbol}] — ${reason}`,
    });

    if (!btc.healthy) return noTrade(`BTC block — ${btc.reason}`);

    const s4 = this.snap(tf.candles4h, true);
    const s1 = this.snap(tf.candles1h, true);
    if (!s4) return noTrade('Insufficient 4h data');
    if (!s1) return noTrade('Insufficient 1h data');

    const price = s1.price;
    const reasons: string[] = [];

    // ── 1. Bitcoin (max 20) ───────────────────────────────────────────────────
    let bitcoinHealth =
      btc.trendStrength === 'strong' ? 20 : btc.trendStrength === 'moderate' ? 15 : 10;
    if (btc.bias === 'bearish') bitcoinHealth = Math.min(bitcoinHealth, 8);
    if (btc.bias === 'sideways') bitcoinHealth = Math.min(bitcoinHealth, 12);
    reasons.push(btc.reason);

    // ── 2. 4h trend (max 25) ──────────────────────────────────────────────────
    if (s4.price < s4.ema50) {
      return noTrade('4h below EMA50 — no swing long');
    }
    if (s4.ema20 < s4.ema50 * 0.998) {
      return noTrade('4h EMA20 not above EMA50');
    }
    if (s4.adx < 16) {
      return noTrade(`4h trend too weak (ADX ${s4.adx.toFixed(1)})`);
    }
    if (s4.rsi > 72) {
      return noTrade(`4h RSI overbought (${s4.rsi.toFixed(1)})`);
    }
    if (s4.rsi < 38) {
      return noTrade(`4h RSI too weak (${s4.rsi.toFixed(1)})`);
    }

    let trendQuality = 10;
    if (s4.price > s4.ema50) trendQuality += 5;
    if (s4.ema20 > s4.ema50) trendQuality += 4;
    if (s4.higherHighs && s4.higherLows) trendQuality += 4;
    else if (s4.higherHighs || s4.higherLows) trendQuality += 2;
    if (s4.price > s4.ema200) trendQuality += 2;
    trendQuality = Math.min(25, trendQuality);
    reasons.push(`4h trend ${trendQuality}/25 · ADX ${s4.adx.toFixed(1)}`);

    // ── 3. 1h structure / EMA (max 15) ────────────────────────────────────────
    if (s1.price < s1.ema50 * 0.985) {
      return noTrade('1h too deep below EMA50');
    }

    let emaAlignment = 0;
    if (s1.price > s1.ema20 && s1.ema20 > s1.ema50) {
      emaAlignment = 15;
      reasons.push('1h full EMA stack');
    } else if (s1.price > s1.ema20) {
      emaAlignment = 12;
      reasons.push('1h above EMA20');
    } else if (s1.price >= s1.ema50 * 0.995) {
      emaAlignment = 9;
      reasons.push('1h reclaiming EMA50 zone');
    } else {
      return noTrade('1h not reclaiming EMAs');
    }

    // ── 4. Pullback entry on 1h (max 20) ──────────────────────────────────────
    // Want: dipped toward EMA then closed bullish (not chasing a vertical candle)
    const bodyPct =
      Math.abs(s1.lastCandle.close - s1.lastCandle.open) / s1.lastCandle.open;
    if (bodyPct > 0.025) {
      return noTrade(`1h candle too extended (${(bodyPct * 100).toFixed(2)}%)`);
    }
    if (s1.rsi > 68) {
      return noTrade(`1h RSI chase (${s1.rsi.toFixed(1)})`);
    }
    if (s1.rsi < 35) {
      return noTrade(`1h RSI too weak (${s1.rsi.toFixed(1)})`);
    }

    const lastBull = s1.lastCandle.close >= s1.lastCandle.open;
    const prevBear = s1.prevCandle.close < s1.prevCandle.open;
    const macdRising = s1.macdHist > s1.macdHistPrev;
    const rsiRising = s1.rsi > s1.prevRsi;

    // Pullback depth: recent low touched near EMA20 or EMA50
    const pullbackLow = Math.min(
      ...s1.recentLows.slice(-6),
      s1.prevCandle.low,
      s1.lastCandle.low
    );
    const touchedEma =
      pullbackLow <= s1.ema20 * 1.008 || pullbackLow <= s1.ema50 * 1.01;
    const notFarAbove =
      s1.price <= s1.ema20 * 1.02 || s1.price <= s1.ema50 * 1.025;

    let pullbackQuality = 0;
    if (lastBull && prevBear && touchedEma) {
      pullbackQuality = 20;
      reasons.push('1h pullback flip at EMA');
    } else if (lastBull && touchedEma && (macdRising || rsiRising)) {
      pullbackQuality = 16;
      reasons.push(`1h EMA bounce · RSI ${s1.rsi.toFixed(1)}`);
    } else if (lastBull && notFarAbove && macdRising && rsiRising) {
      pullbackQuality = 13;
      reasons.push('1h controlled continuation after dip');
    } else if (lastBull && touchedEma) {
      pullbackQuality = 11;
      reasons.push('1h bullish reclaim');
    } else {
      return noTrade('No 1h pullback reclaim setup');
    }

    // ── 5. Volume (max 10) ────────────────────────────────────────────────────
    if (s1.volumeRatio < 0.5) {
      return noTrade(`1h volume too thin (${s1.volumeRatio.toFixed(2)}x)`);
    }
    let volumeConfirmation = 6;
    if (s1.volumeRatio >= 1.1) {
      volumeConfirmation = 10;
      reasons.push(`1h vol ${s1.volumeRatio.toFixed(2)}x`);
    } else if (s1.volumeRatio >= 0.75) {
      volumeConfirmation = 8;
      reasons.push(`1h vol ${s1.volumeRatio.toFixed(2)}x`);
    } else {
      reasons.push(`1h vol ${s1.volumeRatio.toFixed(2)}x`);
    }

    // ── 6. Room to recent 4h high (max 5) ─────────────────────────────────────
    const resistance = Math.max(...s4.recentHighs.slice(-20));
    const distToRes = (resistance - price) / price;
    // Prefer room for at least ~half the TP; soft otherwise
    let resistanceDistance = 3;
    if (distToRes < this.TP_PCT * 0.35) {
      return noTrade(`Pinned under 4h high (${(distToRes * 100).toFixed(2)}%)`);
    }
    if (distToRes >= this.TP_PCT) {
      resistanceDistance = 5;
      reasons.push(`Room ${(distToRes * 100).toFixed(2)}%`);
    } else {
      reasons.push(`Tight room ${(distToRes * 100).toFixed(2)}%`);
    }

    // ── 7. Momentum (max 5) ───────────────────────────────────────────────────
    let momentumAdx = 2;
    if (s4.adx >= 22 && macdRising) {
      momentumAdx = 5;
      reasons.push(`Strong 4h ADX ${s4.adx.toFixed(1)} + MACD↑`);
    } else if (s4.adx >= 18) {
      momentumAdx = 4;
      reasons.push(`4h ADX ${s4.adx.toFixed(1)}`);
    } else {
      reasons.push(`4h ADX ${s4.adx.toFixed(1)}`);
    }

    const marketPenalty =
      btc.bias === 'bearish' ? 6 : btc.bias === 'sideways' ? 2 : 0;

    // Map trendQuality (max 25) into scoreBreakdown.trendQuality for type compat
    const scoreBreakdown: ScoreBreakdown = {
      bitcoinHealth,
      trendQuality: Math.min(20, Math.round((trendQuality / 25) * 20)),
      emaAlignment,
      pullbackQuality: Math.min(15, Math.round((pullbackQuality / 20) * 15)),
      volumeConfirmation: Math.min(15, Math.round((volumeConfirmation / 10) * 15)),
      resistanceDistance: Math.min(10, resistanceDistance * 2),
      momentumAdx,
      total: 0,
    };

    const rawTotal =
      bitcoinHealth +
      trendQuality +
      emaAlignment +
      pullbackQuality +
      volumeConfirmation +
      resistanceDistance +
      momentumAdx -
      marketPenalty;

    // Normalize to ~100 scale (max theoretical ≈ 20+25+15+20+10+5+5 = 100)
    const score = Math.max(0, Math.min(100, rawTotal));
    scoreBreakdown.total = score;

    const entry = price;
    const takeProfit = entry * (1 + this.TP_PCT);
    const stopLoss = entry * (1 - this.SL_PCT);
    const shouldTrade = score >= this.MIN_SCORE;

    if (!shouldTrade) {
      return {
        symbol,
        shouldTrade: false,
        score,
        scoreBreakdown,
        entryPrice: entry,
        takeProfit,
        stopLoss,
        riskReward: `+${(this.TP_PCT * 100).toFixed(2)}% / -${(this.SL_PCT * 100).toFixed(2)}%`,
        trend: '4h uptrend',
        bitcoinStatus: btc.reason,
        reasons,
        rejections: [`Score ${score}/100 < ${this.MIN_SCORE}`],
        summary: `NO TRADE [${symbol}] — Score ${score}/100 (need ${this.MIN_SCORE})`,
      };
    }

    return {
      symbol,
      shouldTrade: true,
      score,
      scoreBreakdown,
      entryPrice: entry,
      takeProfit,
      stopLoss,
      riskReward: `+${(this.TP_PCT * 100).toFixed(1)}% / -${(this.SL_PCT * 100).toFixed(1)}% (~${(
        this.TP_PCT / this.SL_PCT
      ).toFixed(1)}R)`,
      trend: '4H trend pullback swing',
      bitcoinStatus: btc.reason,
      reasons,
      rejections: [],
      summary: `✅ TRADE [${symbol}] — Score ${score}/100 | Entry ${entry.toFixed(6)} | TP ${takeProfit.toFixed(6)} | SL ${stopLoss.toFixed(6)}`,
    };
  }

  findBestOpportunity(
    coins: { symbol: string; tf: MultiTimeframeCandles }[],
    btcCandles4h: Candle[],
    btcCandles1h: Candle[] = []
  ): { btc: BitcoinAnalysis; best: TradeOpportunity | null; all: TradeOpportunity[] } {
    const btc = this.analyzeBitcoin(btcCandles4h, btcCandles1h);

    if (!btc.healthy) {
      logger.info(`NO TRADE — BTC hard block: ${btc.reason}`);
      return { btc, best: null, all: [] };
    }

    logger.info(`BTC ok — ${btc.reason}`);

    const results: TradeOpportunity[] = [];
    for (const coin of coins) {
      try {
        const opp = this.analyzeCoin(coin.symbol, coin.tf, btc);
        results.push(opp);
        logger.info(opp.summary);
      } catch (err) {
        logger.warn(`Analysis error ${coin.symbol}`, { error: String(err) });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const best = results.find((r) => r.shouldTrade) ?? null;

    const ranked = results
      .slice(0, 8)
      .map((r) => `${r.symbol.replace('/USDT', '')} ${r.score}${r.shouldTrade ? '✅' : ''}`)
      .join(' | ');
    logger.info(`Scan top: ${ranked || 'no coins'}`);

    return { btc, best, all: results };
  }

  analyze(candles: Candle[]): TradeSignal {
    return {
      signal: 'none',
      price: candles[candles.length - 1]?.close ?? 0,
      reason: 'Use findBestOpportunity()',
      strength: 0,
    };
  }

  private snap(candles: Candle[], excludeForming: boolean): Snap | null {
    const data = excludeForming && candles.length > 1 ? candles.slice(0, -1) : candles;
    if (data.length < 60) return null;

    const closes = data.map((c) => c.close);
    const highs = data.map((c) => c.high);
    const lows = data.map((c) => c.low);
    const volumes = data.map((c) => c.volume);

    const e20 = EMA.calculate({ period: 20, values: closes });
    const e50 = EMA.calculate({ period: 50, values: closes });
    const e200 =
      closes.length >= 210 ? EMA.calculate({ period: 200, values: closes }) : [];
    const rsiArr = RSI.calculate({ period: 14, values: closes });
    const atrArr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const adxArr = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const macd = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    if (
      !e20.length ||
      !e50.length ||
      !rsiArr.length ||
      !atrArr.length ||
      !adxArr.length ||
      macd.length < 2
    ) {
      return null;
    }

    const price = closes[closes.length - 1];
    const avgVol =
      volumes.slice(-21, -1).reduce((a, b) => a + b, 0) /
      Math.max(1, Math.min(20, volumes.length - 1));

    const LB = Math.min(20, highs.length);
    const rH = highs.slice(-LB);
    const rL = lows.slice(-LB);
    const mid = Math.floor(LB / 2);
    const higherHighs =
      mid > 0 && Math.max(...rH.slice(mid)) > Math.max(...rH.slice(0, mid));
    const higherLows =
      mid > 0 && Math.min(...rL.slice(mid)) > Math.min(...rL.slice(0, mid));

    const rawAdx = adxArr[adxArr.length - 1];
    const adxVal = typeof rawAdx === 'number' ? rawAdx : (rawAdx as { adx: number }).adx;

    return {
      price,
      ema20: e20[e20.length - 1],
      ema50: e50[e50.length - 1],
      ema200: e200.length ? e200[e200.length - 1] : e50[e50.length - 1],
      rsi: rsiArr[rsiArr.length - 1],
      prevRsi: rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : rsiArr[rsiArr.length - 1],
      adx: adxVal,
      atrPct: atrArr[atrArr.length - 1] / price,
      macdHist: macd[macd.length - 1].histogram ?? 0,
      macdHistPrev: macd[macd.length - 2].histogram ?? 0,
      higherHighs,
      higherLows,
      volumeRatio: avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1,
      lastCandle: data[data.length - 1],
      prevCandle: data[data.length - 2],
      recentHighs: highs,
      recentLows: lows,
    };
  }
}

export function logSignal(signal: TradeSignal, symbol?: string): void {
  const pair = symbol ?? signal.symbol ?? '';
  if (signal.signal === 'none') {
    logger.debug(`${pair} ${signal.reason}`);
  } else {
    logger.info(`${pair} LONG signal`, { price: signal.price, reason: signal.reason });
  }
}
