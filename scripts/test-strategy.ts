/**
 * One-off strategy scan against LIVE Binance public data (read-only).
 * Does not place orders. Run: npx tsx scripts/test-strategy.ts
 */
import ccxt from 'ccxt';
import { MediumRiskStrategy, MultiTimeframeCandles } from '../src/strategy/mediumRisk';
import { config } from '../src/config';

async function fetchTf(ex: ccxt.Exchange, symbol: string, tf: string, limit: number) {
  const ohlcv = await ex.fetchOHLCV(symbol, tf, undefined, limit);
  return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp: timestamp ?? 0,
    open: open ?? 0,
    high: high ?? 0,
    low: low ?? 0,
    close: close ?? 0,
    volume: volume ?? 0,
  }));
}

async function main() {
  const ex = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'spot' } });
  await ex.loadMarkets();

  const strategy = new MediumRiskStrategy();
  const watchlist = [...config.trading.watchlist];

  const btc1h = await fetchTf(ex, 'BTC/USDT', '1h', 120);
  const btc15 = await fetchTf(ex, 'BTC/USDT', '15m', 120);
  const btc = strategy.analyzeBitcoin(btc1h, btc15);

  console.log('\n=== STRATEGY LIVE SCAN (mainnet public data) ===\n');
  console.log('BTC:', btc.reason, '| healthy=', btc.healthy);
  console.log('Config: TP gross', (config.risk.takeProfitPercent * 100).toFixed(2) + '%',
    '| SL', (config.risk.stopLossPercent * 100).toFixed(2) + '%',
    '| minScore', config.position.minScore);
  console.log('Net TP after 0.2% fees ≈', ((config.risk.takeProfitPercent - 0.002) * 100).toFixed(2) + '%');
  console.log('Net SL after fees ≈', ((config.risk.stopLossPercent + 0.002) * 100).toFixed(2) + '%');
  console.log('Breakeven win rate needed ≈',
    (
      ((config.risk.stopLossPercent + 0.002) /
        (config.risk.takeProfitPercent - 0.002 + config.risk.stopLossPercent + 0.002)) *
      100
    ).toFixed(1) + '%\n'
  );

  if (!btc.healthy) {
    console.log('BTC HARD BLOCK — no coins scanned for trade.');
    return;
  }

  const coins: { symbol: string; tf: MultiTimeframeCandles }[] = [];
  for (const symbol of watchlist) {
    try {
      if (!ex.markets[symbol]) {
        console.log(symbol, '— not listed, skip');
        continue;
      }
      const [candles1h, candles15m, candles5m] = await Promise.all([
        fetchTf(ex, symbol, '1h', 120),
        fetchTf(ex, symbol, '15m', 120),
        fetchTf(ex, symbol, '5m', 120),
      ]);
      coins.push({ symbol, tf: { candles1h, candles15m, candles5m } });
    } catch (e) {
      console.log(symbol, 'fetch error', String(e));
    }
  }

  const { best, all } = strategy.findBestOpportunity(coins, btc1h, btc15);

  console.log('--- Results (sorted by score) ---\n');
  for (const o of all) {
    const mark = o.shouldTrade ? 'TRADE' : 'SKIP ';
    console.log(
      `${mark} ${o.symbol.padEnd(12)} score=${String(o.score).padStart(3)} | ${o.summary}`
    );
    if (o.shouldTrade) {
      console.log('       reasons:', o.reasons.slice(0, 4).join(' · '));
    } else if (o.rejections[0]) {
      console.log('       reject:', o.rejections[0]);
    }
  }

  const tradeable = all.filter((o) => o.shouldTrade);
  console.log('\n=== SUMMARY ===');
  console.log('Scanned:', all.length);
  console.log('Would TRADE now:', tradeable.length);
  console.log('Best:', best ? `${best.symbol} score ${best.score}` : 'none');

  // Weakness heuristics on tradeable set
  let chase = 0;
  let nearHigh = 0;
  let softPullback = 0;
  for (const o of tradeable) {
    if (o.scoreBreakdown.pullbackQuality <= 8) softPullback++;
    if (o.scoreBreakdown.resistanceDistance <= 4) nearHigh++;
    if (o.reasons.some((r) => r.includes('Holding above EMA20') || r.includes('Soft entry'))) chase++;
  }
  console.log('\nAmong tradeable setups:');
  console.log('- Soft/no real pullback (≤8 pts):', softPullback);
  console.log('- Near local high (≤4 res pts):', nearHigh);
  console.log('- Chase-like reasons:', chase);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
