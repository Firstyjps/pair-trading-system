#!/usr/bin/env npx tsx
/**
 * Full Universe Backtest — 1,225 pairs × 3 years
 * Uses current live config settings with trailing stop + profitability check
 *
 * Usage: node -r dotenv/config node_modules/.bin/tsx src/backtest/full-universe-backtest.ts
 */

import 'dotenv/config';
import { ols } from '../scanner/cointegration.js';
import { loadEnvConfig } from '../config.js';
import * as fs from 'fs';

// ─── Current Live Config ───
const CONFIG = {
  entryZ: 2.25,
  exitZ: 0.3,
  stopLossZ: 4.0,
  window: 240,
  safeZoneBuffer: 0.5,
  gracePeriodBars: 5,
  cooldownBars: 24,
  minHoldBarsTP: 2,
  trailingStopEnabled: true,
  trailingStopZ: 1.5,
};

const LEVERAGE = 5;
const CAPITAL = 125;
const FEE = 0.0006;

// ─── All 50 symbols ───
const SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'POL',
  'OP', 'ARB', 'APT', 'SUI', 'NEAR', 'INJ', 'SEI', 'TIA',
  'PEPE', 'SHIB', 'BONK', 'WIF', 'ADA', 'DOT', 'ATOM', 'FIL',
  'LTC', 'UNI', 'AAVE', 'MKR', 'SNX', 'COMP', 'FTM', 'MANA',
  'SAND', 'AXS', 'GALA', 'IMX', 'ALGO', 'EOS', 'XLM', 'HBAR',
  'VET', 'THETA', 'ONE', 'MASK', 'ENS', 'APE', 'CRV', 'DYDX',
  'GMX', 'PENDLE',
];

// ─── Types ───
interface TradeResult {
  entryBar: number;
  exitBar: number;
  direction: 'SHORT_SPREAD' | 'LONG_SPREAD';
  entryZ: number;
  exitZ: number;
  pnl: number;
  pnlPercent: number;
  closeReason: 'TP' | 'SL' | 'TRAILING';
  barsHeld: number;
}

interface PairResult {
  pair: string;
  symbolA: string;
  symbolB: string;
  correlation: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpe: number;
  maxDD: number;
  maxDDPercent: number;
  profitFactor: number;
  avgBarsHeld: number;
  tpCount: number;
  slCount: number;
  trailingCount: number;
  bestTrade: number;
  worstTrade: number;
}

// ─── Fetch 3 years of 1h data ───
async function fetch3YearData(exchange: any, symbol: string): Promise<number[]> {
  const ccxtSymbol = `${symbol}/USDT:USDT`;
  const tfMs = 3600_000; // 1h
  const now = Date.now();
  const threeYearsAgo = now - 3 * 365.25 * 24 * 3600_000;

  let allPrices: number[] = [];
  let cursor = threeYearsAgo;
  let retries = 0;

  while (cursor < now) {
    try {
      const candles = await exchange.fetchOHLCV(ccxtSymbol, '1h', cursor, 500);
      if (!candles || candles.length === 0) break;

      for (const c of candles) {
        if (c[0] > cursor - tfMs) { // Avoid duplicates
          allPrices.push(c[4] as number); // Close price
        }
      }

      const lastTs = candles[candles.length - 1][0] as number;
      if (lastTs <= cursor) break; // No progress
      cursor = lastTs + tfMs;
      retries = 0;

      // Rate limit
      await new Promise(r => setTimeout(r, 150));
    } catch (err: any) {
      retries++;
      if (retries > 3) break;
      await new Promise(r => setTimeout(r, 1000 * retries));
    }
  }

  return allPrices;
}

// ─── Compute correlation ───
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 50) return 0;

  // Use returns for correlation
  const retA: number[] = [];
  const retB: number[] = [];
  for (let i = 1; i < n; i++) {
    retA.push(Math.log(a[i] / a[i - 1]));
    retB.push(Math.log(b[i] / b[i - 1]));
  }

  const meanA = retA.reduce((s, v) => s + v, 0) / retA.length;
  const meanB = retB.reduce((s, v) => s + v, 0) / retB.length;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < retA.length; i++) {
    const dA = retA[i] - meanA;
    const dB = retB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

// ─── Run backtest with full live logic ───
function runBacktestFull(spread: number[]): TradeResult[] {
  const trades: TradeResult[] = [];
  const n = spread.length;
  if (n < CONFIG.window + 50) return trades;

  let inPosition = false;
  let direction: 'SHORT_SPREAD' | 'LONG_SPREAD' = 'SHORT_SPREAD';
  let entryBar = 0;
  let entryZ = 0;
  let entrySpread = 0;
  let cooldownUntil = 0;
  let gracePeriodEnd = 0;
  let trailingBestZ = 0;

  for (let i = CONFIG.window; i < n; i++) {
    // Rolling Z-Score
    const windowSlice = spread.slice(i - CONFIG.window, i + 1);
    const mean = windowSlice.reduce((a, b) => a + b, 0) / windowSlice.length;
    const variance = windowSlice.reduce((a, b) => a + (b - mean) ** 2, 0) / windowSlice.length;
    const std = Math.sqrt(variance);
    const z = std > 0 ? (spread[i] - mean) / std : 0;

    if (!inPosition) {
      if (i < cooldownUntil) continue;

      if (z > CONFIG.entryZ && z < CONFIG.stopLossZ - CONFIG.safeZoneBuffer) {
        inPosition = true;
        direction = 'SHORT_SPREAD';
        entryBar = i;
        entryZ = z;
        entrySpread = spread[i];
        gracePeriodEnd = i + CONFIG.gracePeriodBars;
        trailingBestZ = Math.abs(z);
      } else if (z < -CONFIG.entryZ && Math.abs(z) < CONFIG.stopLossZ - CONFIG.safeZoneBuffer) {
        inPosition = true;
        direction = 'LONG_SPREAD';
        entryBar = i;
        entryZ = z;
        entrySpread = spread[i];
        gracePeriodEnd = i + CONFIG.gracePeriodBars;
        trailingBestZ = Math.abs(z);
      }
    } else {
      const barsHeld = i - entryBar;
      const absZ = Math.abs(z);

      // Update trailing best Z
      if (absZ < trailingBestZ) {
        trailingBestZ = absZ;
      }

      let closeReason: 'TP' | 'SL' | 'TRAILING' | null = null;

      // TP with minHoldBars + profitability check
      if (absZ <= CONFIG.exitZ) {
        if (barsHeld >= CONFIG.minHoldBarsTP) {
          const spreadChange = spread[i] - entrySpread;
          const pnlDir = direction === 'SHORT_SPREAD' ? -1 : 1;
          const rawPnl = pnlDir * spreadChange * CAPITAL * LEVERAGE;
          const fees = CAPITAL * LEVERAGE * 2 * FEE * 2;
          if (rawPnl - fees > 0) {
            closeReason = 'TP';
          }
        }
      }
      // SL
      else if (i >= gracePeriodEnd && absZ > CONFIG.stopLossZ) {
        closeReason = 'SL';
      }
      // Trailing stop
      else if (CONFIG.trailingStopEnabled && absZ >= trailingBestZ + CONFIG.trailingStopZ) {
        closeReason = 'TRAILING';
      }

      if (closeReason) {
        const spreadChange = spread[i] - entrySpread;
        const pnlDir = direction === 'SHORT_SPREAD' ? -1 : 1;
        const rawPnl = pnlDir * spreadChange * CAPITAL * LEVERAGE;
        const fees = CAPITAL * LEVERAGE * 2 * FEE * 2;
        const pnl = rawPnl - fees;

        trades.push({
          entryBar,
          exitBar: i,
          direction,
          entryZ,
          exitZ: z,
          pnl,
          pnlPercent: pnl / (CAPITAL * 2),
          closeReason,
          barsHeld,
        });

        inPosition = false;
        cooldownUntil = i + CONFIG.cooldownBars;
      }
    }
  }

  return trades;
}

// ─── Compute metrics ───
function computeMetrics(trades: TradeResult[]): Omit<PairResult, 'pair' | 'symbolA' | 'symbolB' | 'correlation'> {
  if (trades.length === 0) {
    return {
      trades: 0, wins: 0, winRate: 0, totalPnl: 0, avgPnl: 0,
      sharpe: 0, maxDD: 0, maxDDPercent: 0, profitFactor: 0,
      avgBarsHeld: 0, tpCount: 0, slCount: 0, trailingCount: 0,
      bestTrade: 0, worstTrade: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Sharpe
  const pnls = trades.map(t => t.pnlPercent);
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const std = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(trades.length) : 0;

  // Max Drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    trades: trades.length,
    wins: wins.length,
    winRate: wins.length / trades.length,
    totalPnl,
    avgPnl: totalPnl / trades.length,
    sharpe,
    maxDD,
    maxDDPercent: peak > 0 ? maxDD / peak : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgBarsHeld: trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length,
    tpCount: trades.filter(t => t.closeReason === 'TP').length,
    slCount: trades.filter(t => t.closeReason === 'SL').length,
    trailingCount: trades.filter(t => t.closeReason === 'TRAILING').length,
    bestTrade: Math.max(...trades.map(t => t.pnl)),
    worstTrade: Math.min(...trades.map(t => t.pnl)),
  };
}

// ─── Main ───
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   Full Universe Backtest — All Pairs × 3 Years              ║
║   Config: entryZ=${CONFIG.entryZ} exitZ=${CONFIG.exitZ} SL=${CONFIG.stopLossZ}            ║
║   Window=${CONFIG.window} TrailingStop=${CONFIG.trailingStopEnabled} (Z=${CONFIG.trailingStopZ})           ║
║   Leverage=${LEVERAGE}x Capital=$${CAPITAL}/leg Fee=${FEE}              ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Init exchange
  const envConfig = loadEnvConfig();
  const ccxt = await import('ccxt');
  const exchange = new ccxt.okx({
    apiKey: envConfig.OKX_API_KEY,
    secret: envConfig.OKX_SECRET,
    password: envConfig.OKX_PASSPHRASE,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });
  if (envConfig.OKX_SANDBOX) exchange.setSandboxMode(true);
  await exchange.loadMarkets();

  // Step 1: Fetch 3-year data for all symbols
  console.log(`📡 Fetching 3-year 1h data for ${SYMBOLS.length} symbols...`);
  console.log(`   (This will take ~10-15 minutes due to API rate limits)\n`);

  const priceData = new Map<string, number[]>();
  let fetched = 0;

  for (const sym of SYMBOLS) {
    try {
      process.stdout.write(`  [${++fetched}/${SYMBOLS.length}] ${sym}...`);
      const prices = await fetch3YearData(exchange, sym);
      if (prices.length >= 500) {
        priceData.set(sym, prices);
        console.log(` ✅ ${prices.length} bars (${(prices.length / 24 / 365).toFixed(1)} years)`);
      } else {
        console.log(` ⚠️ Only ${prices.length} bars — skipped`);
      }
    } catch (err: any) {
      console.log(` ❌ ${err.message}`);
    }
  }

  const validSymbols = [...priceData.keys()];
  const totalPairs = validSymbols.length * (validSymbols.length - 1) / 2;
  console.log(`\n✅ Got ${validSymbols.length} symbols → ${totalPairs} possible pairs\n`);

  // Step 2: Run backtest for every pair
  console.log(`🔬 Running backtests for all ${totalPairs} pairs...\n`);

  const results: PairResult[] = [];
  let processed = 0;
  let withTrades = 0;
  const startTime = Date.now();

  for (let i = 0; i < validSymbols.length; i++) {
    for (let j = i + 1; j < validSymbols.length; j++) {
      const symA = validSymbols[i];
      const symB = validSymbols[j];
      processed++;

      const pA = priceData.get(symA)!;
      const pB = priceData.get(symB)!;

      // Align lengths
      const n = Math.min(pA.length, pB.length);
      const pricesA = pA.slice(pA.length - n);
      const pricesB = pB.slice(pB.length - n);

      // Correlation
      const corr = correlation(pricesA, pricesB);

      // Compute spread using OLS
      const logA = pricesA.map(Math.log);
      const logB = pricesB.map(Math.log);
      const halfN = Math.floor(n / 2);
      const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));
      const spread = logA.map((a, k) => a - beta * logB[k]);

      // Run backtest
      const trades = runBacktestFull(spread);
      const metrics = computeMetrics(trades);

      results.push({
        pair: `${symA}/${symB}`,
        symbolA: symA,
        symbolB: symB,
        correlation: corr,
        ...metrics,
      });

      if (trades.length > 0) withTrades++;

      // Progress every 100 pairs
      if (processed % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const eta = (elapsed / processed) * (totalPairs - processed);
        console.log(`  📊 ${processed}/${totalPairs} pairs done (${withTrades} with trades) — ETA: ${Math.ceil(eta)}s`);
      }
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Step 3: Analysis & Report
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📊 FULL UNIVERSE BACKTEST RESULTS`);
  console.log(`${'═'.repeat(80)}\n`);

  console.log(`⏱️  Completed in ${totalElapsed}s`);
  console.log(`📋 Total pairs tested: ${results.length}`);
  console.log(`📈 Pairs with trades: ${withTrades}`);
  console.log(`📉 Pairs without trades: ${results.length - withTrades}\n`);

  // Filter pairs with trades
  const active = results.filter(r => r.trades > 0);
  const profitable = active.filter(r => r.totalPnl > 0);
  const losing = active.filter(r => r.totalPnl <= 0);

  console.log(`${'─'.repeat(80)}`);
  console.log(`  OVERALL STATISTICS`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Pairs with trades:     ${active.length}`);
  console.log(`  Profitable pairs:      ${profitable.length} (${(profitable.length / active.length * 100).toFixed(1)}%)`);
  console.log(`  Losing pairs:          ${losing.length} (${(losing.length / active.length * 100).toFixed(1)}%)`);
  console.log(`  Total trades:          ${active.reduce((s, r) => s + r.trades, 0)}`);
  console.log(`  Avg trades/pair:       ${(active.reduce((s, r) => s + r.trades, 0) / active.length).toFixed(1)}`);
  console.log(`  Avg win rate:          ${(active.reduce((s, r) => s + r.winRate, 0) / active.length * 100).toFixed(1)}%`);
  console.log(`  Avg Sharpe:            ${(active.reduce((s, r) => s + r.sharpe, 0) / active.length).toFixed(2)}`);

  // Close reason breakdown
  const totalTP = active.reduce((s, r) => s + r.tpCount, 0);
  const totalSL = active.reduce((s, r) => s + r.slCount, 0);
  const totalTrailing = active.reduce((s, r) => s + r.trailingCount, 0);
  const totalAll = totalTP + totalSL + totalTrailing;
  console.log(`\n  Close reasons:`);
  console.log(`    TP:       ${totalTP} (${(totalTP / totalAll * 100).toFixed(1)}%)`);
  console.log(`    SL:       ${totalSL} (${(totalSL / totalAll * 100).toFixed(1)}%)`);
  console.log(`    TRAILING: ${totalTrailing} (${(totalTrailing / totalAll * 100).toFixed(1)}%)`);

  // By correlation tier
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  BY CORRELATION TIER`);
  console.log(`${'─'.repeat(80)}`);

  const tiers = [
    { label: 'High (≥0.8)', min: 0.8, max: 1.1 },
    { label: 'Medium (0.6-0.8)', min: 0.6, max: 0.8 },
    { label: 'Low (0.4-0.6)', min: 0.4, max: 0.6 },
    { label: 'Very Low (<0.4)', min: -1, max: 0.4 },
  ];

  for (const tier of tiers) {
    const tierPairs = active.filter(r => Math.abs(r.correlation) >= tier.min && Math.abs(r.correlation) < tier.max);
    if (tierPairs.length === 0) {
      console.log(`\n  ${tier.label}: No pairs with trades`);
      continue;
    }
    const tierProfit = tierPairs.filter(r => r.totalPnl > 0);
    const avgWR = tierPairs.reduce((s, r) => s + r.winRate, 0) / tierPairs.length;
    const avgSharpe = tierPairs.reduce((s, r) => s + r.sharpe, 0) / tierPairs.length;
    console.log(`\n  ${tier.label}:`);
    console.log(`    Pairs: ${tierPairs.length} | Profitable: ${tierProfit.length} (${(tierProfit.length / tierPairs.length * 100).toFixed(0)}%)`);
    console.log(`    Avg Win Rate: ${(avgWR * 100).toFixed(1)}% | Avg Sharpe: ${avgSharpe.toFixed(2)}`);
  }

  // Top 20 best pairs (by Sharpe, min 5 trades)
  const qualified = active.filter(r => r.trades >= 5);
  const topBySharpe = [...qualified].sort((a, b) => b.sharpe - a.sharpe).slice(0, 20);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  TOP 20 PAIRS BY SHARPE (min 5 trades)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  ${'Pair'.padEnd(14)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'PnL'.padStart(10)} ${'Sharpe'.padStart(8)} ${'MaxDD%'.padStart(8)} ${'PF'.padStart(6)} ${'AvgHold'.padStart(8)} ${'Corr'.padStart(7)} ${'TP/SL/TR'.padStart(10)}`);
  console.log(`  ${'─'.repeat(96)}`);
  for (const r of topBySharpe) {
    console.log(`  ${r.pair.padEnd(14)} ${String(r.trades).padStart(7)} ${(r.winRate * 100).toFixed(1).padStart(7)}% ${('$' + r.totalPnl.toFixed(0)).padStart(10)} ${r.sharpe.toFixed(2).padStart(8)} ${(r.maxDDPercent * 100).toFixed(1).padStart(7)}% ${r.profitFactor.toFixed(1).padStart(6)} ${r.avgBarsHeld.toFixed(0).padStart(7)}h ${r.correlation.toFixed(2).padStart(7)} ${`${r.tpCount}/${r.slCount}/${r.trailingCount}`.padStart(10)}`);
  }

  // Top 20 worst pairs
  const worstBySharpe = [...qualified].sort((a, b) => a.sharpe - b.sharpe).slice(0, 20);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  WORST 20 PAIRS BY SHARPE (min 5 trades)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  ${'Pair'.padEnd(14)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'PnL'.padStart(10)} ${'Sharpe'.padStart(8)} ${'MaxDD%'.padStart(8)} ${'PF'.padStart(6)} ${'Corr'.padStart(7)}`);
  console.log(`  ${'─'.repeat(70)}`);
  for (const r of worstBySharpe) {
    console.log(`  ${r.pair.padEnd(14)} ${String(r.trades).padStart(7)} ${(r.winRate * 100).toFixed(1).padStart(7)}% ${('$' + r.totalPnl.toFixed(0)).padStart(10)} ${r.sharpe.toFixed(2).padStart(8)} ${(r.maxDDPercent * 100).toFixed(1).padStart(7)}% ${r.profitFactor.toFixed(1).padStart(6)} ${r.correlation.toFixed(2).padStart(7)}`);
  }

  // Top 20 by PnL (non-BTC)
  const nonBtc = qualified.filter(r => !r.pair.includes('BTC'));
  const topByPnl = [...nonBtc].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 20);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  TOP 20 PAIRS BY PNL (non-BTC, min 5 trades)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  ${'Pair'.padEnd(14)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'PnL'.padStart(10)} ${'Sharpe'.padStart(8)} ${'PF'.padStart(6)} ${'Best'.padStart(8)} ${'Worst'.padStart(8)} ${'Corr'.padStart(7)}`);
  console.log(`  ${'─'.repeat(78)}`);
  for (const r of topByPnl) {
    console.log(`  ${r.pair.padEnd(14)} ${String(r.trades).padStart(7)} ${(r.winRate * 100).toFixed(1).padStart(7)}% ${('$' + r.totalPnl.toFixed(0)).padStart(10)} ${r.sharpe.toFixed(2).padStart(8)} ${r.profitFactor.toFixed(1).padStart(6)} ${('$' + r.bestTrade.toFixed(0)).padStart(8)} ${('$' + r.worstTrade.toFixed(0)).padStart(8)} ${r.correlation.toFixed(2).padStart(7)}`);
  }

  // Pairs the system would actually trade (corr ≥ 0.7)
  const tradeable = active.filter(r => Math.abs(r.correlation) >= 0.7);
  const tradeableProfit = tradeable.filter(r => r.totalPnl > 0);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  SYSTEM-TRADEABLE PAIRS (correlation ≥ 0.7)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Total: ${tradeable.length} pairs`);
  console.log(`  Profitable: ${tradeableProfit.length} (${(tradeableProfit.length / (tradeable.length || 1) * 100).toFixed(1)}%)`);
  if (tradeable.length > 0) {
    console.log(`  Avg Win Rate: ${(tradeable.reduce((s, r) => s + r.winRate, 0) / tradeable.length * 100).toFixed(1)}%`);
    console.log(`  Avg Sharpe: ${(tradeable.reduce((s, r) => s + r.sharpe, 0) / tradeable.length).toFixed(2)}`);
    console.log(`  Total Trades: ${tradeable.reduce((s, r) => s + r.trades, 0)}`);
  }

  // Save full results to CSV
  const csvPath = './data/full-universe-backtest.csv';
  const csvHeader = 'Pair,SymbolA,SymbolB,Correlation,Trades,Wins,WinRate,TotalPnl,AvgPnl,Sharpe,MaxDD,MaxDDPct,ProfitFactor,AvgBarsHeld,TP,SL,Trailing,BestTrade,WorstTrade\n';
  const csvRows = results.map(r =>
    `${r.pair},${r.symbolA},${r.symbolB},${r.correlation.toFixed(4)},${r.trades},${r.wins},${(r.winRate * 100).toFixed(1)},${r.totalPnl.toFixed(2)},${r.avgPnl.toFixed(2)},${r.sharpe.toFixed(3)},${r.maxDD.toFixed(2)},${(r.maxDDPercent * 100).toFixed(1)},${r.profitFactor.toFixed(2)},${r.avgBarsHeld.toFixed(1)},${r.tpCount},${r.slCount},${r.trailingCount},${r.bestTrade.toFixed(2)},${r.worstTrade.toFixed(2)}`
  ).join('\n');

  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(csvPath, csvHeader + csvRows);
  console.log(`\n💾 Full results saved to: ${csvPath}`);

  console.log(`\n✅ Full universe backtest complete.`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
