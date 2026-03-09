#!/usr/bin/env npx tsx
/**
 * Multi-Logic Backtest CLI Runner
 *
 * Usage:
 *   npx tsx src/backtest/run.ts                              # All strategies, default pairs
 *   npx tsx src/backtest/run.ts --pair ETH/SOL               # Specific pair
 *   npx tsx src/backtest/run.ts --strategy classic_zscore     # Specific strategy
 *   npx tsx src/backtest/run.ts --timeframe 4h               # 4h candles
 *   npx tsx src/backtest/run.ts --limit 500                  # More data
 *   npx tsx src/backtest/run.ts --years 3                    # 3 years of historical data
 *   npx tsx src/backtest/run.ts --leverage 10 --capital 25   # Custom risk params
 *   npx tsx src/backtest/run.ts --all-pairs                  # Scan all correlated pairs
 *   npx tsx src/backtest/run.ts --top 5                      # Show top 5 strategies only
 *   npx tsx src/backtest/run.ts --json                       # Output JSON for web UI
 */

import 'dotenv/config';
import { createAllStrategies, createStrategy, type StrategyName, ALL_STRATEGY_NAMES } from './strategies.js';
import { runMultiLogicBacktest, type MultiBacktestConfig, type MultiLogicResult } from './multi-logic-engine.js';
import { formatFullMultiLogicReport, formatMultiLogicComparison } from './report.js';
import { buildCorrelationMatrix, tagSectors } from '../scanner/correlation.js';
import { testCointegration } from '../scanner/cointegration.js';
import { fetchHistoricalData, fetchMultipleSymbols, getCacheInfo, type HistoricalFetchConfig } from './historical-fetcher.js';
import { createChildLogger } from '../logger.js';
import { loadEnvConfig } from '../config.js';

const log = createChildLogger('backtest-cli');

// ─── CLI Args Parser ───

interface CliArgs {
  pair?: string;
  strategies: StrategyName[];
  timeframe: string;
  limit: number;
  /** When set, uses historical fetcher to paginate years of data */
  years?: number;
  leverage: number;
  capital: number;
  feeRate: number;
  allPairs: boolean;
  top: number;
  json: boolean;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    strategies: [...ALL_STRATEGY_NAMES],
    timeframe: '1h',
    limit: 300,
    leverage: 10,
    capital: 25,
    feeRate: 0.0006,
    allPairs: false,
    top: 10,
    json: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pair':
      case '-p':
        opts.pair = args[++i];
        break;
      case '--strategy':
      case '-s':
        opts.strategies = [args[++i] as StrategyName];
        break;
      case '--strategies':
        opts.strategies = args[++i].split(',') as StrategyName[];
        break;
      case '--timeframe':
      case '-t':
        opts.timeframe = args[++i];
        break;
      case '--limit':
      case '-l':
        opts.limit = parseInt(args[++i]);
        break;
      case '--years':
      case '-y':
        opts.years = parseFloat(args[++i]);
        break;
      case '--leverage':
        opts.leverage = parseInt(args[++i]);
        break;
      case '--capital':
        opts.capital = parseFloat(args[++i]);
        break;
      case '--fee':
        opts.feeRate = parseFloat(args[++i]);
        break;
      case '--all-pairs':
        opts.allPairs = true;
        break;
      case '--top':
        opts.top = parseInt(args[++i]);
        break;
      case '--json':
        opts.json = true;
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════╗
║       Multi-Logic Backtest Runner                ║
╚══════════════════════════════════════════════════╝

Usage: npx tsx src/backtest/run.ts [options]

Options:
  --pair, -p <A/B>       Pair to backtest (e.g. ETH/SOL)
  --strategy, -s <name>  Single strategy to test
  --strategies <a,b,...>  Comma-separated strategy names
  --timeframe, -t <tf>   Timeframe: 1h (default), 4h, 1d
  --limit, -l <n>        Number of candles to fetch (default: 300)
  --years, -y <n>        Fetch N years of historical data (paginated + cached)
  --leverage <n>         Leverage multiplier (default: 10)
  --capital <n>          Capital per leg in USD (default: 25)
  --fee <n>              Fee rate (default: 0.0006)
  --all-pairs            Scan all correlated pairs from exchange
  --top <n>              Show top N strategies (default: 10)
  --json                 Output as JSON for web UI
  --verbose, -v          Show detailed output per strategy
  --help, -h             Show this help

Available Strategies:
${ALL_STRATEGY_NAMES.map(n => `  • ${n}`).join('\n')}

Examples:
  npx tsx src/backtest/run.ts --pair ETH/SOL
  npx tsx src/backtest/run.ts --pair ETH/SOL --years 3           # 3 years backtest
  npx tsx src/backtest/run.ts --pair BTC/ETH --years 2 -t 4h     # 2 years, 4h candles
  npx tsx src/backtest/run.ts --pair BTC/ETH --strategies classic_zscore,adaptive_zscore
  npx tsx src/backtest/run.ts --all-pairs --top 3
  npx tsx src/backtest/run.ts --all-pairs --years 1              # All pairs, 1 year
  npx tsx src/backtest/run.ts --pair ETH/SOL --leverage 5 --capital 50
  `);
}

// ─── Data Fetching ───

async function fetchPairData(
  symbolA: string,
  symbolB: string,
  timeframe: string,
  limit: number,
): Promise<{ pricesA: number[]; pricesB: number[] }> {
  const envConfig = loadEnvConfig();
  const ccxt = await import('ccxt');

  const exchange = new ccxt.okx({
    apiKey: envConfig.OKX_API_KEY,
    secret: envConfig.OKX_SECRET,
    password: envConfig.OKX_PASSPHRASE,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });

  if (envConfig.OKX_SANDBOX) {
    exchange.setSandboxMode(true);
  }

  await exchange.loadMarkets();

  const ccxtSymA = `${symbolA}/USDT:USDT`;
  const ccxtSymB = `${symbolB}/USDT:USDT`;

  console.log(`📡 Fetching ${limit} ${timeframe} candles for ${symbolA} and ${symbolB}...`);

  const [candlesA, candlesB] = await Promise.all([
    exchange.fetchOHLCV(ccxtSymA, timeframe, undefined, limit),
    exchange.fetchOHLCV(ccxtSymB, timeframe, undefined, limit),
  ]);

  const pricesA = candlesA.map((c: number[]) => c[4]); // close price
  const pricesB = candlesB.map((c: number[]) => c[4]);

  console.log(`✅ Got ${pricesA.length} candles for ${symbolA}, ${pricesB.length} for ${symbolB}`);

  return { pricesA, pricesB };
}

async function findCorrelatedPairs(
  timeframe: string,
  limit: number,
  threshold: number = 0.75,
): Promise<Array<{ symbolA: string; symbolB: string; correlation: number }>> {
  const envConfig = loadEnvConfig();
  const ccxt = await import('ccxt');

  const exchange = new ccxt.okx({
    apiKey: envConfig.OKX_API_KEY,
    secret: envConfig.OKX_SECRET,
    password: envConfig.OKX_PASSPHRASE,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });

  if (envConfig.OKX_SANDBOX) {
    exchange.setSandboxMode(true);
  }

  await exchange.loadMarkets();

  // Top liquid symbols to scan
  const symbols = [
    'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'POL',
    'OP', 'ARB', 'APT', 'SUI', 'NEAR', 'INJ', 'SEI', 'TIA',
    'PEPE', 'SHIB', 'BONK', 'WIF',
  ];

  console.log(`📡 Scanning ${symbols.length} symbols for correlated pairs...`);

  const priceData = new Map<string, number[]>();

  for (const symbol of symbols) {
    try {
      const ccxtSym = `${symbol}/USDT:USDT`;
      const candles = await exchange.fetchOHLCV(ccxtSym, timeframe, undefined, limit);
      if (candles.length >= 50) {
        priceData.set(symbol, candles.map((c: number[]) => c[4]));
      }
    } catch {
      // Skip symbols that don't exist
    }
  }

  console.log(`✅ Got data for ${priceData.size} symbols`);

  // Build correlation matrix
  const correlatedPairs = buildCorrelationMatrix(priceData, threshold);
  const tagged = tagSectors(correlatedPairs);

  console.log(`📊 Found ${tagged.length} pairs above correlation threshold ${threshold}`);

  return tagged.map(p => ({
    symbolA: p.symbolA,
    symbolB: p.symbolB,
    correlation: p.correlation,
  }));
}

// ─── Historical Data Fetching (multi-year) ───

async function fetchPairDataHistorical(
  symbolA: string,
  symbolB: string,
  years: number,
  timeframe: '1h' | '4h' | '1d',
): Promise<{ pricesA: number[]; pricesB: number[] }> {
  const histConfig: Partial<HistoricalFetchConfig> = {
    years,
    timeframe,
    batchSize: 300,
    delayMs: 200,
  };

  // Show cache info if available
  const cacheA = getCacheInfo(symbolA, timeframe);
  const cacheB = getCacheInfo(symbolB, timeframe);
  if (cacheA) {
    console.log(`  📦 Cache ${symbolA}: ${cacheA.total} candles (${cacheA.oldest} → ${cacheA.newest})`);
  }
  if (cacheB) {
    console.log(`  📦 Cache ${symbolB}: ${cacheB.total} candles (${cacheB.oldest} → ${cacheB.newest})`);
  }

  console.log(`\n📡 Fetching ${years} year(s) of ${timeframe} data for ${symbolA}...`);
  const pricesA = await fetchHistoricalData(symbolA, histConfig, (p) => {
    const bar = progressBar(p.percentComplete, 30);
    process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles}/${p.expectedCandles} candles | ${p.currentDate} | ${p.elapsed.toFixed(0)}s`);
  });
  console.log(`\n  ✅ ${symbolA}: ${pricesA.length} candles`);

  console.log(`📡 Fetching ${years} year(s) of ${timeframe} data for ${symbolB}...`);
  const pricesB = await fetchHistoricalData(symbolB, histConfig, (p) => {
    const bar = progressBar(p.percentComplete, 30);
    process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles}/${p.expectedCandles} candles | ${p.currentDate} | ${p.elapsed.toFixed(0)}s`);
  });
  console.log(`\n  ✅ ${symbolB}: ${pricesB.length} candles`);

  // Align lengths
  const minLen = Math.min(pricesA.length, pricesB.length);
  return {
    pricesA: pricesA.slice(pricesA.length - minLen),
    pricesB: pricesB.slice(pricesB.length - minLen),
  };
}

function progressBar(percent: number, width: number): string {
  const filled = Math.floor(percent / 100 * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

// ─── Main ───

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log(`
╔══════════════════════════════════════════════════╗
║       Multi-Logic Backtest Runner                ║
╚══════════════════════════════════════════════════╝
`);
  const dataDesc = opts.years
    ? `${opts.years} year(s) historical data`
    : `${opts.limit} candles`;
  console.log(`⚙️  Config: ${opts.leverage}x leverage, $${opts.capital}/leg, ${opts.timeframe} timeframe`);
  console.log(`📊 Data: ${dataDesc}`);
  console.log(`📋 Strategies: ${opts.strategies.join(', ')}`);
  console.log(``);

  const config: MultiBacktestConfig = {
    capitalPerLeg: opts.capital,
    leverage: opts.leverage,
    feeRate: opts.feeRate,
    inSampleRatio: 0.5,
  };

  // Create strategy instances
  const strategies = opts.strategies.map(name => createStrategy(name));

  const allResults: MultiLogicResult[] = [];

  if (opts.allPairs) {
    // Scan all correlated pairs
    const pairs = await findCorrelatedPairs(opts.timeframe, opts.limit);

    if (pairs.length === 0) {
      console.log('❌ No correlated pairs found. Try lowering the threshold or increasing data.');
      process.exit(1);
    }

    // Show top pairs
    console.log(`\n📊 Top correlated pairs:`);
    for (const p of pairs.slice(0, 10)) {
      console.log(`  ${p.symbolA}/${p.symbolB}: ${p.correlation.toFixed(4)}`);
    }
    console.log(``);

    // Backtest top 5 pairs
    const topPairs = pairs.slice(0, 5);

    for (const pair of topPairs) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`🔬 Backtesting ${pair.symbolA}/${pair.symbolB} (corr: ${pair.correlation.toFixed(4)})`);
      console.log(`${'═'.repeat(60)}`);

      try {
        const { pricesA, pricesB } = opts.years
          ? await fetchPairDataHistorical(pair.symbolA, pair.symbolB, opts.years, opts.timeframe as '1h' | '4h' | '1d')
          : await fetchPairData(pair.symbolA, pair.symbolB, opts.timeframe, opts.limit);

        // Reset strategies for each pair
        strategies.forEach(s => s.reset());

        const result = runMultiLogicBacktest(
          pricesA, pricesB,
          `${pair.symbolA}/${pair.symbolB}`,
          strategies,
          config,
        );

        allResults.push(result);

        if (opts.verbose) {
          console.log(formatFullMultiLogicReport(result));
        } else {
          console.log(formatMultiLogicComparison(result));
        }
      } catch (err: any) {
        console.error(`❌ Error backtesting ${pair.symbolA}/${pair.symbolB}: ${err.message}`);
      }
    }
  } else if (opts.pair) {
    // Single pair
    const [symbolA, symbolB] = opts.pair.split('/');
    if (!symbolA || !symbolB) {
      console.error('❌ Invalid pair format. Use: ETH/SOL');
      process.exit(1);
    }

    const { pricesA, pricesB } = opts.years
      ? await fetchPairDataHistorical(symbolA, symbolB, opts.years, opts.timeframe as '1h' | '4h' | '1d')
      : await fetchPairData(symbolA, symbolB, opts.timeframe, opts.limit);

    // Run cointegration test for info
    const cointResult = testCointegration(pricesA, pricesB, symbolA, symbolB);
    console.log(`\n📈 Cointegration: pValue=${cointResult.pValue.toFixed(4)}, halfLife=${cointResult.halfLife.toFixed(1)}, beta=${cointResult.beta.toFixed(6)}`);
    console.log(`   Cointegrated: ${cointResult.isCointegrated ? '✅ YES' : '❌ NO'}`);
    if (opts.years) {
      console.log(`   Data span: ${pricesA.length} candles (~${(pricesA.length / (opts.timeframe === '4h' ? 6 : opts.timeframe === '1d' ? 1 : 24) / 365.25).toFixed(1)} years)`);
    }

    const result = runMultiLogicBacktest(pricesA, pricesB, opts.pair, strategies, config);
    allResults.push(result);

    if (opts.verbose) {
      console.log(formatFullMultiLogicReport(result));
    } else {
      console.log(formatMultiLogicComparison(result));

      // Show top strategy details
      if (result.strategies.length > 0) {
        const best = result.strategies
          .filter(s => s.totalTrades > 0)
          .sort((a, b) => b.sharpeRatio - a.sharpeRatio)[0];
        if (best) {
          const { formatStrategyReport } = await import('./report.js');
          console.log(`\n🏆 Best Strategy Details:`);
          console.log(formatStrategyReport(best));
        }
      }
    }
  } else {
    // Default: ETH/XRP (the pair currently running live)
    console.log(`ℹ️  No pair specified. Using ETH/XRP (current live pair).`);
    console.log(`   Use --pair ETH/SOL or --all-pairs for other options.\n`);

    const { pricesA, pricesB } = opts.years
      ? await fetchPairDataHistorical('ETH', 'XRP', opts.years, opts.timeframe as '1h' | '4h' | '1d')
      : await fetchPairData('ETH', 'XRP', opts.timeframe, opts.limit);

    const result = runMultiLogicBacktest(pricesA, pricesB, 'ETH/XRP', strategies, config);
    allResults.push(result);

    if (opts.verbose) {
      console.log(formatFullMultiLogicReport(result));
    } else {
      console.log(formatMultiLogicComparison(result));
    }
  }

  // JSON output for web UI
  if (opts.json) {
    const jsonOutput = allResults.map(r => ({
      pair: r.pair,
      dataPoints: r.dataPoints,
      bestStrategy: r.bestStrategy,
      comparison: r.comparison,
      strategies: r.strategies.map(s => ({
        name: s.strategyName,
        description: s.strategyDescription,
        params: s.strategyParams,
        totalTrades: s.totalTrades,
        winRate: s.winRate,
        totalPnl: s.totalPnl,
        sharpeRatio: s.sharpeRatio,
        maxDrawdown: s.maxDrawdown,
        profitFactor: s.profitFactor,
        avgBarsHeld: s.avgBarsHeld,
        equityCurve: s.equityCurve,
        trades: s.trades,
      })),
    }));

    console.log('\n--- JSON OUTPUT ---');
    console.log(JSON.stringify(jsonOutput, null, 2));
  }

  // Overall summary
  if (allResults.length > 1) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📊 OVERALL SUMMARY (${allResults.length} pairs tested)`);
    console.log(`${'═'.repeat(60)}`);

    // Aggregate wins by strategy across all pairs
    const strategyWins = new Map<string, number>();
    for (const result of allResults) {
      if (result.bestStrategy !== 'N/A') {
        strategyWins.set(result.bestStrategy, (strategyWins.get(result.bestStrategy) ?? 0) + 1);
      }
    }

    const sortedWins = [...strategyWins.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n  Strategy Win Count (best Sharpe per pair):`);
    for (const [name, wins] of sortedWins) {
      console.log(`    ${name}: ${wins} wins`);
    }
  }

  console.log(`\n✅ Backtest complete.`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
