import { runBacktest, type BacktestConfig, type BacktestReport } from './engine.js';
import type { TradingQueries } from '../db/queries.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('optimizer');

export interface GridSearchParams {
  entryZ: number[];
  exitZ: number[];
  stopLossZ: number[];
  halfLifeFilter: number[];
  correlationFilter: number[];
}

const DEFAULT_GRID: GridSearchParams = {
  entryZ: [1.0, 1.5, 2.0, 2.5],
  exitZ: [0.0, 0.25, 0.5],
  stopLossZ: [2.5, 3.0, 3.5, 4.0],
  halfLifeFilter: [12, 24, 48, 72],
  correlationFilter: [0.6, 0.7, 0.8],
};

export interface OptimizationResult {
  results: BacktestReport[];
  bestConfig: BacktestConfig;
  totalCombinations: number;
}

export function runGridSearch(
  pricesA: number[],
  pricesB: number[],
  pair: string,
  grid: GridSearchParams = DEFAULT_GRID,
  baseConfig?: Partial<BacktestConfig>,
): OptimizationResult {
  const allResults: BacktestReport[] = [];

  const base: Omit<BacktestConfig, 'entryZ' | 'exitZ' | 'stopLossZ' | 'halfLifeFilter' | 'correlationFilter'> = {
    safeZoneBuffer: 0.5,
    gracePeriodBars: 5,
    cooldownBars: 24,
    capitalPerLeg: 300,
    leverage: 5,
    feeRate: 0.0006,
    ...baseConfig,
  };

  let totalCombinations = 0;

  for (const entryZ of grid.entryZ) {
    for (const exitZ of grid.exitZ) {
      for (const stopLossZ of grid.stopLossZ) {
        // Skip invalid combinations
        if (entryZ + base.safeZoneBuffer >= stopLossZ) continue;
        if (exitZ >= entryZ) continue;

        for (const halfLifeFilter of grid.halfLifeFilter) {
          for (const correlationFilter of grid.correlationFilter) {
            totalCombinations++;

            const config: BacktestConfig = {
              ...base,
              entryZ,
              exitZ,
              stopLossZ,
              halfLifeFilter,
              correlationFilter,
            };

            const report = runBacktest(pricesA, pricesB, pair, config);
            allResults.push(report);
          }
        }
      }
    }
  }

  // Sort by Sharpe ratio
  allResults.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  // Assign ranks
  for (let i = 0; i < allResults.length; i++) {
    (allResults[i] as any).rank = i + 1;
  }

  const bestConfig = allResults[0]?.config ?? {
    ...base,
    entryZ: 2.0,
    exitZ: 0.5,
    stopLossZ: 3.0,
    halfLifeFilter: 24,
    correlationFilter: 0.75,
  };

  log.info({
    pair,
    totalCombinations,
    validResults: allResults.filter(r => r.totalTrades > 0).length,
    bestSharpe: allResults[0]?.sharpeRatio.toFixed(4),
    bestWinRate: allResults[0]?.winRate.toFixed(4),
  }, 'Grid search completed');

  return { results: allResults, bestConfig, totalCombinations };
}

export function saveTopResults(
  queries: TradingQueries,
  results: BacktestReport[],
  topN: number = 10,
): void {
  const top = results.slice(0, topN);

  for (let i = 0; i < top.length; i++) {
    queries.insertBacktestResult({
      config_json: JSON.stringify(top[i].config),
      pair: top[i].pair,
      total_trades: top[i].totalTrades,
      win_rate: top[i].winRate,
      sharpe_ratio: top[i].sharpeRatio,
      max_drawdown: top[i].maxDrawdown,
      total_pnl: top[i].totalPnl,
      rank: i + 1,
      tested_at: new Date().toISOString(),
    });
  }

  log.info({ topN, saved: top.length }, 'Top backtest results saved to DB');
}
