# Scalping Trading Bot

A TypeScript Node.js scalping bot for Binance with strict risk management.

## Strategy Overview

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Risk per trade | **0.2%** | Max dollar loss if stop-loss hits |
| Take profit | **1.0% – 1.5%** | Target gain per winning trade |
| Stop loss | **0.2%** | Tight stop aligned with risk |
| Reward:Risk | **~5:1 to 7.5:1** | Needs ~15–20% win rate to break even |

### How position sizing works

The bot does **not** bet your entire wallet on one trade. It uses your full wallet balance to **calculate** position size so that if the stop-loss hits, you lose exactly **0.2%** of total equity. Available free USDT caps the maximum notional.

### Entry signals (scalping)

- **EMA 9/21 crossover** on 1-minute candles
- **RSI(14)** filter to avoid overbought/oversold extremes
- **Volume spike** (1.2× 20-bar average) for momentum confirmation
- **ATR** minimum volatility filter

### Exit rules

- Take profit at 1.0–1.5% (midpoint used: 1.25%)
- Stop loss at 0.2%
- Time exit after 15 minutes if neither TP nor SL hit
- Daily loss cap: 2% of wallet (bot pauses)

---

## My opinion on your parameters

**0.2% risk is excellent** — conservative, lets you survive losing streaks, and is how professional traders size positions.

**1–1.5% profit target is aggressive for pure scalping.** Classic scalping aims for 0.1–0.3% gains with equally tight stops. Your setup is closer to **micro-swing / momentum scalping**:

- **Pros:** 5:1+ reward-to-risk means you only need ~15–20% win rate to break even before fees
- **Cons:** 1% moves on 1m BTC don't happen often — fewer trades, longer holds, more exposure to reversals
- **Fees matter:** Binance spot is ~0.1% per side (0.2% round trip). A 1% target nets ~0.8%; a 0.2% stop becomes ~0.4% real loss. Still favorable, but factor it in.

**Recommendation:** Start on **testnet**, run for 1–2 weeks, then consider tightening take-profit to **0.5–0.8%** if you want higher trade frequency, or keep 1–1.5% if you prefer fewer, higher-conviction momentum trades.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your Binance API keys. **Always start with `USE_TESTNET=true`.**

Get testnet keys: [testnet.binance.vision](https://testnet.binance.vision/)

### 3. Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build && npm start
```

---

## Project Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Environment config
├── bot/engine.ts         # Main trading loop
├── exchange/client.ts    # Binance via CCXT
├── risk/manager.ts       # Position sizing & daily limits
├── strategy/scalping.ts  # EMA + RSI + volume signals
├── types/index.ts        # Shared types
└── utils/logger.ts       # Winston logger
```

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_TESTNET` | `true` | Sandbox mode |
| `TRADING_MODE` | `spot` | `spot` (long only) or `futures` (long + short) |
| `SYMBOL` | `BTC/USDT` | Trading pair |
| `MAX_RISK_PER_TRADE` | `0.002` | 0.2% risk per trade |
| `TAKE_PROFIT_MIN` | `0.01` | 1% min take profit |
| `TAKE_PROFIT_MAX` | `0.015` | 1.5% max take profit |
| `STOP_LOSS_PERCENT` | `0.002` | 0.2% stop loss |
| `MAX_DAILY_LOSS_PERCENT` | `0.02` | 2% daily loss cap |
| `SCAN_INTERVAL_MS` | `15000` | Scan every 15 seconds |

---

## Disclaimer

This software is for educational purposes. Cryptocurrency trading carries significant risk. Past performance does not guarantee future results. Never trade with money you cannot afford to lose. The authors are not responsible for any financial losses.
