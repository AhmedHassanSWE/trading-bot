/**
 * Strategy: Trend Continuation — Lower Risk
 *
 * Fewer trades, higher quality. Prefer sitting idle over forced entries.
 *
 * Targets:
 *  • Gross TP 0.8% ≈ ~0.6% net after fees
 *  • Gross SL 0.35% ≈ ~0.55% net after fees  → slight edge if WR > ~48%
 *  • Capital capped at tradingCapital
 *
 * Hard rejects:
 *  • BTC clearly bearish
 *  • 1h not holding above EMA50
 *  • 5m below EMA50
 *  • Weak volume, no pullback confirmation, RSI chase
 *  • Not enough room to recent high for full TP
 *  • Score below minScore
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
  private readonly TP_PCT = config.risk.takeProfitPercent;
  private readonly SL_PCT = config.risk.stopLossPercent;
  private readonly MIN_SCORE = config.position.minScore;

  analyzeBitcoin(candles1h: Candle[], candles15m: Candle[]): BitcoinAnalysis {
    const s1h = this.snap(candles1h, false);
    const s15m = this.snap(candles15m, false);

    if (!s1h) {
      return {
        bias: 'sideways',
        trendStrength: 'weak',
        volatility: 'normal',
        healthy: true,
        reason: 'BTC data limited — scanning alts carefully',
      };
    }

    const bull1h = s1h.price > s1h.ema20 && s1h.ema20 > s1h.ema50;
    const bear1h = s1h.price < s1h.ema20 && s1h.ema20 < s1h.ema50;
    const bear15 = s15m
      ? s15m.price < s15m.ema20 && s15m.ema20 < s15m.ema50
      : false;

    // Hard block: clear bearish structure
    if (bear1h && (s1h.adx >= 16 || bear15)) {
      return {
        bias: 'bearish',
        trendStrength: s1h.adx >= 20 ? 'strong' : 'moderate',
        volatility: 'normal',
        healthy: false,
        reason: `BTC bearish — ADX ${s1h.adx.toFixed(1)}`,
      };
    }

    if (bull1h) {
      const strength: BitcoinAnalysis['trendStrength'] =
        s1h.adx >= 22 ? 'strong' : s1h.adx >= 16 ? 'moderate' : 'weak';
      return {
        bias: 'bullish',
        trendStrength: strength,
        volatility: s1h.atrPct > 0.012 ? 'high' : 'normal',
        healthy: true,
        reason: `BTC bullish — ADX ${s1h.adx.toFixed(1)}, RSI ${s1h.rsi.toFixed(1)}`,
      };
    }

    // Sideways: allow only if not dumping on 15m
    if (bear15 && s1h.price < s1h.ema50) {
      return {
        bias: 'bearish',
        trendStrength: 'moderate',
        volatility: 'normal',
        healthy: false,
        reason: 'BTC soft dump on 15m — pause longs',
      };
    }

    return {
      bias: 'sideways',
      trendStrength: 'weak',
      volatility: 'normal',
      healthy: true,
      reason: `BTC mixed — ADX ${s1h.adx.toFixed(1)} — selective longs only`,
    };
  }

  analyzeCoin(symbol: string, tf: MultiTimeframeCandles, btc: BitcoinAnalysis): TradeOpportunity {
    const lastClose =
      tf.candles5m[tf.candles5m.length - 2]?.close ??
      tf.candles5m[tf.candles5m.length - 1]?.close ??
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

    const s5m = this.snap(tf.candles5m, true);
    if (!s5m) return noTrade('Insufficient 5m data');

    const s1h = this.snap(tf.candles1h, false);
    const s15m = this.snap(tf.candles15m, false);
    const price = s5m.price;
    const reasons: string[] = [];

    // Dead markets: ATR too small to reach TP cleanly
    if (s5m.atrPct < this.TP_PCT * 0.3) {
      return noTrade(`ATR too low (${(s5m.atrPct * 100).toFixed(2)}%)`);
    }

    // ── 1. Bitcoin (max 20) ───────────────────────────────────────────────────
    const bitcoinHealth =
      btc.trendStrength === 'strong' ? 20 : btc.trendStrength === 'moderate' ? 15 : 8;
    if (btc.bias === 'sideways') {
      // Lower risk: sideways BTC gets less credit
      reasons.push(`${btc.reason} (sideways discount)`);
    } else {
      reasons.push(btc.reason);
    }

    // ── 2. Trend (max 20) ─────────────────────────────────────────────────────
    if (!s1h || s1h.price < s1h.ema50) {
      return noTrade('1h below EMA50 — no long bias');
    }

    let trendQuality = 6;
    if (s1h.price > s1h.ema50) trendQuality += 6;
    if (s1h.ema20 >= s1h.ema50) trendQuality += 4;
    if (s1h.higherHighs && s1h.higherLows) trendQuality += 3;
    else if (s1h.higherHighs || s1h.higherLows) trendQuality += 1;
    if (s15m && s15m.price > s15m.ema50) trendQuality += 1;
    else if (s15m && s15m.price < s15m.ema50 * 0.99) {
      return noTrade('15m broken below EMA50');
    }
    trendQuality = Math.min(20, trendQuality);
    reasons.push(`Trend ${trendQuality}/20`);

    // ── 3. EMA 5m (max 15) ────────────────────────────────────────────────────
    if (s5m.price < s5m.ema50) {
      return noTrade('5m below EMA50');
    }

    let emaAlignment = 0;
    if (s5m.price > s5m.ema20 && s5m.ema20 > s5m.ema50) {
      emaAlignment = 15;
      reasons.push('Full 5m EMA stack');
    } else if (s5m.price > s5m.ema20) {
      emaAlignment = 11;
      reasons.push('Price above EMA20');
    } else {
      // Between EMA20 and EMA50 — only if tight to EMA20 (real pullback)
      if (s5m.price < s5m.ema20 * 0.997) {
        return noTrade('5m pullback too deep under EMA20');
      }
      emaAlignment = 8;
      reasons.push('Pullback into EMA20–50');
    }

    // ── 4. Entry / pullback (max 15) ──────────────────────────────────────────
    if (s5m.rsi > 68) {
      return noTrade(`RSI too hot (${s5m.rsi.toFixed(1)})`);
    }
    if (s5m.rsi < 35) {
      return noTrade(`RSI too weak (${s5m.rsi.toFixed(1)})`);
    }

    const bodyPct =
      Math.abs(s5m.lastCandle.close - s5m.lastCandle.open) / s5m.lastCandle.open;
    if (bodyPct > 0.012) {
      return noTrade(`Candle too extended (${(bodyPct * 100).toFixed(2)}%)`);
    }

    const lastBull = s5m.lastCandle.close >= s5m.lastCandle.open;
    const prevBear = s5m.prevCandle.close < s5m.prevCandle.open;
    const macdRising = s5m.macdHist > s5m.macdHistPrev;
    const rsiRising = s5m.rsi > s5m.prevRsi;
    const nearEma =
      s5m.price <= s5m.ema20 * 1.004 || s5m.price <= s5m.ema50 * 1.006;

    let pullbackQuality: number;
    if (lastBull && prevBear && nearEma) {
      pullbackQuality = 15;
      reasons.push('Pullback flip at EMA');
    } else if (lastBull && prevBear) {
      pullbackQuality = 12;
      reasons.push('Candle flip entry');
    } else if (lastBull && nearEma && (macdRising || rsiRising)) {
      pullbackQuality = 11;
      reasons.push(`EMA bounce — RSI ${s5m.rsi.toFixed(1)}`);
    } else if (lastBull && macdRising && rsiRising && s5m.rsi <= 60) {
      pullbackQuality = 9;
      reasons.push('Controlled continuation');
    } else {
      return noTrade('No clean pullback confirmation');
    }

    // ── 5. Volume (max 15) ────────────────────────────────────────────────────
    if (s5m.volumeRatio < 0.65) {
      return noTrade(`Volume too thin (${s5m.volumeRatio.toFixed(2)}x)`);
    }

    let volumeConfirmation: number;
    if (s5m.volumeRatio >= 1.2) {
      volumeConfirmation = 15;
      reasons.push(`Volume ${s5m.volumeRatio.toFixed(2)}x`);
    } else if (s5m.volumeRatio >= 0.9) {
      volumeConfirmation = 12;
      reasons.push(`Volume ${s5m.volumeRatio.toFixed(2)}x`);
    } else {
      volumeConfirmation = 8;
      reasons.push(`Volume ${s5m.volumeRatio.toFixed(2)}x`);
    }

    // ── 6. Resistance (max 10) — need full TP room ────────────────────────────
    const resistance = Math.max(...s5m.recentHighs.slice(-24));
    const distToRes = (resistance - price) / price;

    if (distToRes < this.TP_PCT) {
      return noTrade(`Not enough room to high (${(distToRes * 100).toFixed(2)}% < TP)`);
    }

    const resistanceDistance = distToRes >= this.TP_PCT * 1.4 ? 10 : 7;
    reasons.push(`Room ${(distToRes * 100).toFixed(2)}%`);

    // ── 7. ADX / momentum (max 5) ─────────────────────────────────────────────
    let momentumAdx = 1;
    if (s5m.adx >= 18 && macdRising) {
      momentumAdx = 5;
      reasons.push(`ADX ${s5m.adx.toFixed(1)} + MACD↑`);
    } else if (s5m.adx >= 14) {
      momentumAdx = 3;
      reasons.push(`ADX ${s5m.adx.toFixed(1)}`);
    } else if (s5m.adx < 12 && !macdRising) {
      return noTrade(`No momentum (ADX ${s5m.adx.toFixed(1)})`);
    } else {
      reasons.push(`ADX ${s5m.adx.toFixed(1)}`);
    }

    // Sideways BTC: require stronger coin setup
    const sidewaysPenalty = btc.bias === 'sideways' ? 4 : 0;
    const rawTotal =
      bitcoinHealth +
      trendQuality +
      emaAlignment +
      pullbackQuality +
      volumeConfirmation +
      resistanceDistance +
      momentumAdx -
      sidewaysPenalty;

    const scoreBreakdown: ScoreBreakdown = {
      bitcoinHealth,
      trendQuality,
      emaAlignment,
      pullbackQuality,
      volumeConfirmation,
      resistanceDistance,
      momentumAdx,
      total: Math.max(0, rawTotal),
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
        riskReward: `+${(this.TP_PCT * 100).toFixed(2)}% / -${(this.SL_PCT * 100).toFixed(2)}%`,
        trend: 'Bullish bias',
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
      riskReward: `+${(this.TP_PCT * 100).toFixed(2)}% gross (~${((this.TP_PCT - 0.002) * 100).toFixed(2)}% net) / -${(this.SL_PCT * 100).toFixed(2)}%`,
      trend: 'Lower-risk trend continuation',
      bitcoinStatus: btc.reason,
      reasons,
      rejections: [],
      summary: `✅ TRADE [${symbol}] — Score ${score}/100 | Entry ${entry.toFixed(6)} | TP ${takeProfit.toFixed(6)} | SL ${stopLoss.toFixed(6)}`,
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

  private snap(candles: Candle[], excludeForming: boolean): MrSnapshot | null {
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
