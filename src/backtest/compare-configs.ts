#!/usr/bin/env npx tsx
/**
 * Compare two configs across 10 random correlated pairs.
 * Usage: node -r dotenv/config node_modules/.bin/tsx src/backtest/compare-configs.ts
 */

import 'dotenv/config';
import { ols } from '../scanner/cointegration.js';
import { buildCorrelationMatrix, tagSectors } from '../scanner/correlation.js';
import { fetchHistoricalData, type HistoricalFetchConfig } from './historical-fetcher.js';
import {
  mulberry32,
  generateClassicParams,
  runClassicFast,
  computeQuickMetrics,
  type OptimizerConfig,
} from './zscore-optimizer.js';
import { loadEnvConfig } from '../config.js';

// ─── Two configs to compare ───

const CONFIG_A = {
  label: 'Current (entryZ=2.0, SL=3.5, win=168)',
  params: {
    entryZ: 2.0,
    exitZ: 0.5,
    stopLossZ: 3.5,
    window: 168,
    safeZoneBuffer: 0.3,
    gracePeriodBars: 5,
    cooldownBars: 24,
  },
};

const CONFIG_B = {
  label: 'Proposed (entryZ=2.5, SL=4.0, win=240)',
  params: {
    entryZ: 2.5,
    exitZ: 0.5,
    stopLossZ: 4.0,
    window: 240,
    safeZoneBuffer: 0.5,
    gracePeriodBars: 5,
    cooldownBars: 24,
  },
};

const LEVERAGE = 5;
const CAPITAL = 125;
const FEE = 0.0006;

// ─── Main ───

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     Config Comparison — Up to 1000 Pairs × 1 Year      ║
╚══════════════════════════════════════════════════════════╝
`);
  console.log(`  A: ${CONFIG_A.label}`);
  console.log(`  B: ${CONFIG_B.label}`);
  console.log(`  Leverage: ${LEVERAGE}x | Capital: $${CAPITAL}/leg | Fee: ${FEE}`);
  console.log();

  // Fetch top 10 correlated pairs
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

  const symbols = [
    'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'POL',
    'OP', 'ARB', 'APT', 'SUI', 'NEAR', 'INJ', 'SEI', 'TIA',
    'PEPE', 'SHIB', 'BONK', 'WIF', 'ADA', 'DOT', 'ATOM', 'FIL',
    'LTC', 'UNI', 'AAVE', 'MKR', 'SNX', 'COMP', 'FTM', 'MANA',
    'SAND', 'AXS', 'GALA', 'IMX', 'ALGO', 'EOS', 'XLM', 'HBAR',
    'VET', 'THETA', 'ONE', 'MASK', 'ENS',
  ];

  console.log(`📡 Fetching price data for ${symbols.length} symbols...`);
  const priceData = new Map<string, number[]>();
  for (const sym of symbols) {
    try {
      const candles = await exchange.fetchOHLCV(`${sym}/USDT:USDT`, '1h', undefined, 300);
      if (candles.length >= 50) priceData.set(sym, candles.map((c: number[]) => c[4]));
    } catch { /* skip */ }
  }
  console.log(`✅ Got ${priceData.size} symbols\n`);

  const correlated = buildCorrelationMatrix(priceData, 0.6);
  const tagged = tagSectors(correlated);
  const top10 = tagged.slice(0, 1000);

  console.log(`📊 Found ${tagged.length} correlated pairs (threshold 0.6), testing top ${top10.length}`);
  console.log();

  // Fetch 1 year data for each pair
  const histConfig: Partial<HistoricalFetchConfig> = { years: 1, timeframe: '1h', batchSize: 300, delayMs: 200 };
  const optimizerConfig: OptimizerConfig = {
    rounds: 1,
    strategyType: 'classic',
    capitalPerLeg: CAPITAL,
    leverage: LEVERAGE,
    feeRate: FEE,
    inSampleRatio: 1.0,
    topN: 1,
  };

  const resultsA: { pair: string; trades: number; winRate: number; pnl: number; sharpe: number; maxDD: number }[] = [];
  const resultsB: typeof resultsA = [];

  for (const pair of top10) {
    const { symbolA, symbolB } = pair;
    const pairName = `${symbolA}/${symbolB}`;

    try {
      process.stdout.write(`  🔬 ${pairName}...`);

      const pricesA = await fetchHistoricalData(symbolA, histConfig);
      const pricesB = await fetchHistoricalData(symbolB, histConfig);

      const n = Math.min(pricesA.length, pricesB.length);
      const pA = pricesA.slice(pricesA.length - n);
      const pB = pricesB.slice(pricesB.length - n);

      // Compute spread
      const { beta } = ols(pA, pB);
      const spread = pA.map((a, i) => a - beta * pB[i]);

      // Run config A
      const tradesA = runClassicFast(spread, CONFIG_A.params, optimizerConfig);
      const metricsA = computeQuickMetrics(tradesA);
      resultsA.push({
        pair: pairName,
        trades: metricsA.totalTrades,
        winRate: metricsA.winRate,
        pnl: metricsA.totalPnl,
        sharpe: metricsA.sharpeRatio,
        maxDD: metricsA.maxDrawdownPercent,
      });

      // Run config B
      const tradesB = runClassicFast(spread, CONFIG_B.params, optimizerConfig);
      const metricsB = computeQuickMetrics(tradesB);
      resultsB.push({
        pair: pairName,
        trades: metricsB.totalTrades,
        winRate: metricsB.winRate,
        pnl: metricsB.totalPnl,
        sharpe: metricsB.sharpeRatio,
        maxDD: metricsB.maxDrawdownPercent,
      });

      if (resultsA.length % 50 === 0) {
        console.log(`  ✅ ${resultsA.length} pairs done...`);
      }
    } catch (err: any) {
      console.log(` ❌ ${err.message}`);
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📊 COMPARISON SUMMARY`);
  console.log(`${'═'.repeat(80)}\n`);

  const totalA = resultsA.reduce((s, r) => s + r.pnl, 0);
  const totalB = resultsB.reduce((s, r) => s + r.pnl, 0);
  const winsA = resultsA.filter(r => r.pnl > 0).length;
  const winsB = resultsB.filter(r => r.pnl > 0).length;
  const bWins = resultsB.filter((r, i) => r.pnl > resultsA[i].pnl).length;

  // Filter out BTC pairs (price scale makes PnL misleading)
  const nonBtc = resultsA.map((a, i) => ({ a, b: resultsB[i] })).filter(p => !p.a.pair.includes('BTC'));
  const totalA_nb = nonBtc.reduce((s, p) => s + p.a.pnl, 0);
  const totalB_nb = nonBtc.reduce((s, p) => s + p.b.pnl, 0);
  const winsA_nb = nonBtc.filter(p => p.a.pnl > 0).length;
  const winsB_nb = nonBtc.filter(p => p.b.pnl > 0).length;
  const bWins_nb = nonBtc.filter(p => p.b.pnl > p.a.pnl).length;
  const avgSharpeA_nb = nonBtc.reduce((s, p) => s + p.a.sharpe, 0) / nonBtc.length;
  const avgSharpeB_nb = nonBtc.reduce((s, p) => s + p.b.sharpe, 0) / nonBtc.length;

  // Top 10 pairs where B beats A the most
  const diffs = resultsA.map((a, i) => ({ pair: a.pair, diffPnl: resultsB[i].pnl - a.pnl, aPnl: a.pnl, bPnl: resultsB[i].pnl, aWR: a.winRate, bWR: resultsB[i].winRate, aT: a.trades, bT: resultsB[i].trades }));
  const topBwins = diffs.filter(d => !d.pair.includes('BTC')).sort((a, b) => b.diffPnl - a.diffPnl).slice(0, 10);
  const topAwins = diffs.filter(d => !d.pair.includes('BTC')).sort((a, b) => a.diffPnl - b.diffPnl).slice(0, 10);

  console.log(`  ═══ TOP 10 PAIRS WHERE CONFIG B WINS ═══`);
  console.log(`  ${'Pair'.padEnd(14)} | A PnL       | B PnL       | Diff`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const d of topBwins) {
    console.log(`  ${d.pair.padEnd(14)} | $${d.aPnl.toFixed(0).padStart(10)} | $${d.bPnl.toFixed(0).padStart(10)} | 🟢 +$${d.diffPnl.toFixed(0)}`);
  }

  console.log(`\n  ═══ TOP 10 PAIRS WHERE CONFIG A WINS ═══`);
  console.log(`  ${'Pair'.padEnd(14)} | A PnL       | B PnL       | Diff`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const d of topAwins) {
    console.log(`  ${d.pair.padEnd(14)} | $${d.aPnl.toFixed(0).padStart(10)} | $${d.bPnl.toFixed(0).padStart(10)} | 🔴 $${d.diffPnl.toFixed(0)}`);
  }

  const n = resultsA.length;
  const nb = nonBtc.length;
  console.log(`\n  ═══ OVERALL (All ${n} pairs) ═══`);
  console.log(`  📈 Config A: ${winsA}/${n} คู่กำไร`);
  console.log(`  📈 Config B: ${winsB}/${n} คู่กำไร`);
  console.log(`  🏆 Config B ดีกว่าใน ${bWins}/${n} คู่ (${(bWins/n*100).toFixed(0)}%)`);

  console.log(`\n  ═══ NON-BTC PAIRS (${nb} pairs) ═══`);
  console.log(`  📈 Config A: ${winsA_nb}/${nb} คู่กำไร | Total PnL: $${totalA_nb.toFixed(0)} | Avg Sharpe: ${avgSharpeA_nb.toFixed(2)}`);
  console.log(`  📈 Config B: ${winsB_nb}/${nb} คู่กำไร | Total PnL: $${totalB_nb.toFixed(0)} | Avg Sharpe: ${avgSharpeB_nb.toFixed(2)}`);
  console.log(`  🏆 Config B ดีกว่าใน ${bWins_nb}/${nb} คู่ (${(bWins_nb/nb*100).toFixed(0)}%)`);

  console.log(`\n✅ Comparison complete.`);
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
