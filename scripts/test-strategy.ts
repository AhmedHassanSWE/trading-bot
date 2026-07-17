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

  const btc4h = await fetchTf(ex, 'BTC/USDT', '4h', config.trading.candleLimit4h);
  const btc1h = await fetchTf(ex, 'BTC/USDT', '1h', config.trading.candleLimit1h);
  const btc = strategy.analyzeBitcoin(btc4h, btc1h);

  console.log('\n=== 4H TREND PULLBACK SWING (mainnet public data) ===\n');
  console.log('BTC:', btc.reason, '| healthy=', btc.healthy);
  console.log(
    'Config: TP gross',
    (config.risk.takeProfitPercent * 100).toFixed(2) + '%',
    '| SL',
    (config.risk.stopLossPercent * 100).toFixed(2) + '%',
    '| minScore',
    config.position.minScore
  );
  console.log(
    'Net TP after 0.2% fees ≈',
    ((config.risk.takeProfitPercent - 0.002) * 100).toFixed(2) + '%'
  );
  console.log(
    'Net SL after fees ≈',
    ((config.risk.stopLossPercent + 0.002) * 100).toFixed(2) + '%'
  );
  console.log(
    'Breakeven win rate needed ≈',
    (
      ((config.risk.stopLossPercent + 0.002) /
        (config.risk.takeProfitPercent -
          0.002 +
          config.risk.stopLossPercent +
          0.002)) *
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
      const [candles4h, candles1h] = await Promise.all([
        fetchTf(ex, symbol, '4h', config.trading.candleLimit4h),
        fetchTf(ex, symbol, '1h', config.trading.candleLimit1h),
      ]);
      coins.push({ symbol, tf: { candles4h, candles1h } });
    } catch (e) {
      console.log(symbol, 'fetch error', String(e));
    }
  }

  const { best, all } = strategy.findBestOpportunity(coins, btc4h, btc1h);

  console.log('--- Results (sorted by score) ---\n');
  for (const o of all) {
    const mark = o.shouldTrade ? 'TRADE' : 'SKIP ';
    console.log(
      `${mark} ${o.symbol.padEnd(12)} score=${String(o.score).padStart(3)} | ${o.summary}`
    );
    if (o.shouldTrade) {
      console.log('       reasons:', o.reasons.slice(0, 5).join(' · '));
    } else if (o.rejections[0]) {
      console.log('       reject:', o.rejections[0]);
    }
  }

  const tradeable = all.filter((o) => o.shouldTrade);
  console.log('\n=== SUMMARY ===');
  console.log('Scanned:', all.length);
  console.log('Would TRADE now:', tradeable.length);
  console.log(
    'Best:',
    best ? `${best.symbol} score ${best.score}` : 'none'
  );
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
