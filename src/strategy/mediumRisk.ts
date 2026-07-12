/**
 * Strategy: Trend Continuation After Pullback (Active Trading Profile)
 *
 * Still trend-following only (longs), but filters are deliberately loose
 * so the bot actually takes trades instead of sitting idle for days.
 *
 * Hard rejects only:
 *   • Clear BTC crash / strong bearish
 *   • Coin clearly below EMA50 on 5m (broken structure)
 *   • Score below minScore
 */

import { EMA, RSI, ATR, MACD, ADX } from 'technicalindicators';
import { config } from '../config';
import { Candle, TradeSignal } from '../types';
import { logger } from '../utils/logger';

export interface MultiTimeframeCandles {
  candles1h: Candle[];
  candles15m: Candle[];
  candles5m: Candle[];
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

interface MrSnapshot {
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
}

export class MediumRiskStrategy {
  private readonly TP_PCT = 0.005;
  private readonly SL_PCT = 0.006;
  private readonly MIN_SCORE = config.position.minScore;

  /**
   * BTC gate — ONLY hard-block on clear bearish.
   * Sideways / weak / 15m disagreement still allows coin scanning (lower score).
   */
  analyzeBitcoin(candles1h: Candle[], candles15m: Candle[]): BitcoinAnalysis {
    const s1h = this.snap(candles1h);
    const s15m = this.snap(candles15m);

    if (!s1h) {
      // Don't freeze the whole bot if BTC data is thin — allow with weak score
      return {
        bias: 'sideways',
        trendStrength: 'weak',
        volatility: 'normal',
        healthy: true,
        reason: 'BTC data limited — allowing scans with weak BTC score',
      };
    }

    const bull1h = s1h.price > s1h.ema20 && s1h.ema20 > s1h.ema50;
    const bear1h = s1h.price < s1h.ema20 && s1h.ema20 < s1h.ema50;
    const bull15 = s15m
      ? s15m.price > s15m.ema20
      : true;

    // ONLY hard reject: clear bearish stack
    if (bear1h && s1h.adx >= 20) {
      return {
        bias: 'bearish',
        trendStrength: 'strong',
        volatility: 'normal',
        healthy: false,
        reason: `BTC clearly bearish (EMA20 < EMA50, ADX ${s1h.adx.toFixed(1)})`,
      };
    }

    if (bull1h && bull15) {
      const strength: BitcoinAnalysis['trendStrength'] =
        s1h.adx >= 25 ? 'strong' : s1h.adx >= 15 ? 'moderate' : 'weak';
      return {
        bias: 'bullish',
        trendStrength: strength,
        volatility: s1h.atrPct > 0.012 ? 'high' : 'normal',
        healthy: true,
        reason: `BTC supportive — ADX ${s1h.adx.toFixed(1)}, RSI ${s1h.rsi.toFixed(1)}`,
      };
    }

    // Sideways / mixed — still ALLOW trading (was the main "do nothing" killer)
    return {
      bias: 'sideways',
      trendStrength: 'weak',
      volatility: 'normal',
      healthy: true,
      reason: `BTC mixed/sideways — ADX ${s1h.adx.toFixed(1)} — scanning alts anyway`,
    };
  }

  analyzeCoin(symbol: string, tf: MultiTimeframeCandles, btc: BitcoinAnalysis): TradeOpportunity {
    const lastClose = tf.candles5m[tf.candles5m.length - 1]?.close ?? 0;

    const noTrade = (reason: string): TradeOpportunity => ({
      symbol,
      shouldTrade: false,
      score: 0,
      scoreBreakdown: {
        bitcoinHealth: 0, trendQuality: 0, emaAlignment: 0, pullbackQuality: 0,
        volumeConfirmation: 0, resistanceDistance: 0, momentumAdx: 0, total: 0,
      },
      entryPrice: lastClose,
      takeProfit: 0,
      stopLoss: 0,
      riskReward: `+${this.TP_PCT * 100}% / -${this.SL_PCT * 100}%`,
      trend: 'Unknown',
      bitcoinStatus: btc.reason,
      reasons: [],
      rejections: [reason],
      summary: `NO TRADE [${symbol}] — ${reason}`,
    });

    // Prefer 5m; 1h/15m optional for scoring
    const s5m = this.snap(tf.candles5m);
    if (!s5m) return noTrade('Insufficient 5m candle data');

    const s1h = this.snap(tf.candles1h);
    const s15m = this.snap(tf.candles15m);
    const price = s5m.price;
    const reasons: string[] = [];
    const rejections: string[] = [];

    // ── 1. Bitcoin (max 20) — soft scoring, hard block already done upstream ──
    let bitcoinHealth = 8;
    if (btc.bias === 'bullish' && btc.trendStrength === 'strong') bitcoinHealth = 20;
    else if (btc.bias === 'bullish') bitcoinHealth = 15;
    else if (btc.bias === 'sideways') bitcoinHealth = 10;
    reasons.push(btc.reason);

    // ── 2. Trend quality (max 20) — soft, not all-or-nothing ─────────────────
    let trendQuality = 0;
    if (s1h) {
      const softBull1h = s1h.price > s1h.ema50; // only need above EMA50
      const emaStack1h = s1h.ema20 > s1h.ema50;
      if (softBull1h) trendQuality += 8;
      if (emaStack1h) trendQuality += 4;
      if (s1h.higherHighs || s1h.higherLows) trendQuality += 4;
    } else {
      trendQuality += 6; // don't punish missing 1h on testnet
    }
    if (s15m && s15m.price > s15m.ema50) trendQuality += 4;
    else trendQuality += 2;
    reasons.push(`Trend score ${trendQuality}/20`);

    // Hard reject only if clearly broken on 5m
    if (s5m.price < s5m.ema50 * 0.995) {
      return noTrade(`5m price well below EMA50 — structure broken`);
    }

    // ── 3. EMA alignment 5m (max 15) ──────────────────────────────────────────
    let emaAlignment = 0;
    if (s5m.price > s5m.ema20) emaAlignment += 7;
    if (s5m.ema20 > s5m.ema50) emaAlignment += 5;
    if (s5m.price > s5m.ema50) emaAlignment += 3;
    // Need at least price above EMA50
    if (emaAlignment < 3) {
      return noTrade(`5m not bullish enough — price ${price.toFixed(4)} vs EMA50 ${s5m.ema50.toFixed(4)}`);
    }
    reasons.push(`5m EMA score ${emaAlignment}/15`);

    // ── 4. Pullback / entry (max 15) — very flexible ─────────────────────────
    const bodyPct = Math.abs(s5m.lastCandle.close - s5m.lastCandle.open) / s5m.lastCandle.open;
    // Only reject extreme chase candles (> 1.5%)
    if (bodyPct > 0.015) {
      return noTrade(`Candle too extended (${(bodyPct * 100).toFixed(2)}%) — wait for calm`);
    }

    const lastBull = s5m.lastCandle.close >= s5m.lastCandle.open;
    const prevBear = s5m.prevCandle.close < s5m.prevCandle.open;
    const macdRising = s5m.macdHist > s5m.macdHistPrev;
    const rsiRising = s5m.rsi > s5m.prevRsi;
    const rsiOk = s5m.rsi >= 30 && s5m.rsi <= 72;

    let pullbackQuality: number;
    if (lastBull && prevBear) {
      pullbackQuality = 15;
      reasons.push('Candle flip after pullback');
    } else if (lastBull && rsiOk) {
      pullbackQuality = 12;
      reasons.push(`Bullish candle, RSI ${s5m.rsi.toFixed(1)}`);
    } else if (macdRising || rsiRising) {
      pullbackQuality = 10;
      reasons.push('Momentum turning up');
    } else if (s5m.price > s5m.ema20) {
      pullbackQuality = 8;
      reasons.push('Holding above EMA20');
    } else {
      pullbackQuality = 5;
      reasons.push('Soft entry — above EMA50');
    }

    // ── 5. Volume (max 15) — almost never hard-reject ────────────────────────
    let volumeConfirmation: number;
    if (s5m.volumeRatio >= 1.2) {
      volumeConfirmation = 15;
      reasons.push(`Volume ${s5m.volumeRatio.toFixed(2)}x`);
    } else if (s5m.volumeRatio >= 0.8) {
      volumeConfirmation = 12;
      reasons.push(`Volume ${s5m.volumeRatio.toFixed(2)}x`);
    } else if (s5m.volumeRatio >= 0.4) {
      volumeConfirmation = 8;
      reasons.push(`Light volume ${s5m.volumeRatio.toFixed(2)}x`);
    } else {
      volumeConfirmation = 5; // still allow
      rejections.push(`Very low volume ${s5m.volumeRatio.toFixed(2)}x`);
    }

    // ── 6. Resistance (max 10) — soft ─────────────────────────────────────────
    const resistance = Math.max(...s5m.recentHighs.slice(-24));
    const distToRes = (resistance - price) / price;
    let resistanceDistance: number;
    if (distToRes < 0.001) {
      // basically at the high — small penalty, still tradeable
      resistanceDistance = 4;
      reasons.push('Near local high');
    } else if (distToRes >= this.TP_PCT) {
      resistanceDistance = 10;
      reasons.push(`Room ${(distToRes * 100).toFixed(2)}%`);
    } else {
      resistanceDistance = 7;
      reasons.push(`Tight room ${(distToRes * 100).toFixed(2)}%`);
    }

    // ── 7. ADX / momentum (max 5) — soft ──────────────────────────────────────
    let momentumAdx: number;
    if (s5m.adx >= 20 && macdRising) {
      momentumAdx = 5;
    } else if (s5m.adx >= 12 || macdRising) {
      momentumAdx = 3;
    } else {
      momentumAdx = 2; // no hard ADX floor
    }
    reasons.push(`ADX ${s5m.adx.toFixed(1)}`);

    const scoreBreakdown: ScoreBreakdown = {
      bitcoinHealth,
      trendQuality,
      emaAlignment,
      pullbackQuality,
      volumeConfirmation,
      resistanceDistance,
      momentumAdx,
      total:
        bitcoinHealth + trendQuality + emaAlignment + pullbackQuality +
        volumeConfirmation + resistanceDistance + momentumAdx,
    };

    const score = scoreBreakdown.total;
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
        riskReward: `+${this.TP_PCT * 100}% / -${this.SL_PCT * 100}%`,
        trend: 'Bullish bias',
        bitcoinStatus: btc.reason,
        reasons,
        rejections: [...rejections, `Score ${score}/100 < ${this.MIN_SCORE}`],
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
      riskReward: `+${this.TP_PCT * 100}% / -${this.SL_PCT * 100}%`,
      trend: 'Trend continuation',
      bitcoinStatus: btc.reason,
      reasons,
      rejections,
      summary: `✅ TRADE [${symbol}] — Score ${score}/100 | Entry ${entry.toFixed(4)} | TP ${takeProfit.toFixed(4)} | SL ${stopLoss.toFixed(4)}`,
    };
  }

  findBestOpportunity(
    coins: { symbol: string; tf: MultiTimeframeCandles }[],
    btcCandles1h: Candle[],
    btcCandles15m: Candle[]
  ): { btc: BitcoinAnalysis; best: TradeOpportunity | null; all: TradeOpportunity[] } {
    const btc = this.analyzeBitcoin(btcCandles1h, btcCandles15m);

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
        if (opp.shouldTrade) {
          logger.info(opp.summary);
        } else {
          logger.info(`${opp.summary}`); // info so you can see why on free hosts
        }
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
    logger.info(`Scan top: ${ranked || 'no coins analyzed'}`);

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

  private snap(candles: Candle[]): MrSnapshot | null {
    // EMA200 needs ~210 bars; allow shorter history with EMA50-only fallback
    if (candles.length < 60) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const e20 = EMA.calculate({ period: 20, values: closes });
    const e50 = EMA.calculate({ period: 50, values: closes });
    const e200 =
      closes.length >= 210
        ? EMA.calculate({ period: 200, values: closes })
        : [];
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

    if (!e20.length || !e50.length || !rsiArr.length || !atrArr.length || !adxArr.length || macd.length < 2) {
      return null;
    }

    const price = closes[closes.length - 1];
    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, volumes.length - 1));

    const LB = Math.min(20, highs.length);
    const rH = highs.slice(-LB);
    const rL = lows.slice(-LB);
    const mid = Math.floor(LB / 2);
    const higherHighs = mid > 0 && Math.max(...rH.slice(mid)) > Math.max(...rH.slice(0, mid));
    const higherLows = mid > 0 && Math.min(...rL.slice(mid)) > Math.min(...rL.slice(0, mid));

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
      lastCandle: candles[candles.length - 1],
      prevCandle: candles[candles.length - 2],
      recentHighs: highs,
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
