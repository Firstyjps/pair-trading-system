import type { OHLCVCandle, Direction } from '../types.js';
import { calculateZScore, type ZScoreData } from '../scanner/signal-generator.js';
import { ols, calculateHalfLife } from '../scanner/cointegration.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('backtest');

export interface BacktestConfig {
  entryZ: number;
  exitZ: number;
  stopLossZ: number;
  halfLifeFilter: number;
  correlationFilter: number;
  safeZoneBuffer: number;
  gracePeriodBars: number;     // In bars, not ms
  cooldownBars: number;        // In bars, not ms
  capitalPerLeg: number;
  leverage: number;
  feeRate: number;             // e.g., 0.0006 for 0.06%
  minHoldBarsTP?: number;      // Min bars to hold before TP (default: 2)
  trailingStopEnabled?: boolean;
  trailingStopZ?: number;      // Z drift from best to trigger trailing exit
}

export interface BacktestTrade {
  entryBar: number;
  exitBar: number;
  direction: Direction;
  entryZ: number;
  exitZ: number;
  entrySpread: number;
  exitSpread: number;
  pnl: number;
  pnlPercent: number;
  closeReason: 'TP' | 'SL' | 'TRAILING';
  barsHeld: number;
}

export interface BacktestReport {
  config: BacktestConfig;
  pair: string;
  trades: BacktestTrade[];
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  avgBarsHeld: number;
}

export function runBacktest(
  pricesA: number[],
  pricesB: number[],
  pair: string,
  config: BacktestConfig,
): BacktestReport {
  const n = Math.min(pricesA.length, pricesB.length);
  if (n < 50) {
    return emptyReport(config, pair);
  }

  // Calculate hedge ratio from first half (in-sample)
  const halfN = Math.floor(n / 2);
  const logA = pricesA.map(Math.log);
  const logB = pricesB.map(Math.log);
  const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));

  // Calculate full spread
  const spread: number[] = [];
  for (let i = 0; i < n; i++) {
    spread.push(logA[i] - beta * logB[i]);
  }

  const trades: BacktestTrade[] = [];
  let inPosition = false;
  let direction: Direction = 'SHORT_SPREAD';
  let entryBar = 0;
  let entryZ = 0;
  let entrySpread = 0;
  let cooldownUntil = 0;
  let gracePeriodEnd = 0;
  let trailingBestZ = 0;       // Track best (lowest) |Z| for trailing stop

  const minHoldBars = config.minHoldBarsTP ?? 2;
  const trailingEnabled = config.trailingStopEnabled ?? false;
  const trailingStopZ = config.trailingStopZ ?? 1.5;

  // Rolling Z-Score calculation — use halfLifeFilter as window (aligned with live lookbackPeriods)
  const window = Math.min(config.halfLifeFilter || 120, Math.floor(n * 0.8));

  for (let i = window; i < n; i++) {
    // Calculate Z-Score using rolling window
    const windowSpread = spread.slice(i - window, i + 1);
    const mean = windowSpread.reduce((a, b) => a + b, 0) / windowSpread.length;
    const variance = windowSpread.reduce((a, b) => a + (b - mean) ** 2, 0) / windowSpread.length;
    const std = Math.sqrt(variance);
    const z = std > 0 ? (spread[i] - mean) / std : 0;

    if (!inPosition) {
      // Check cooldown
      if (i < cooldownUntil) continue;

      // Entry signals
      if (z > config.entryZ && z < config.stopLossZ - config.safeZoneBuffer) {
        inPosition = true;
        direction = 'SHORT_SPREAD';
        entryBar = i;
        entryZ = z;
        entrySpread = spread[i];
        gracePeriodEnd = i + config.gracePeriodBars;
        trailingBestZ = Math.abs(z);
      } else if (z < -config.entryZ && Math.abs(z) < config.stopLossZ - config.safeZoneBuffer) {
        inPosition = true;
        direction = 'LONG_SPREAD';
        entryBar = i;
        entryZ = z;
        entrySpread = spread[i];
        gracePeriodEnd = i + config.gracePeriodBars;
        trailingBestZ = Math.abs(z);
      }
    } else {
      const barsHeld = i - entryBar;
      const absZ = Math.abs(z);

      // Update trailing best Z (lowest |Z| achieved = closest to mean)
      if (absZ < trailingBestZ) {
        trailingBestZ = absZ;
      }

      // Check exit conditions
      let closeReason: 'TP' | 'SL' | 'TRAILING' | null = null;

      // Take profit — must hold minHoldBars + check profitability (aligned with live)
      if (absZ <= config.exitZ) {
        if (barsHeld >= minHoldBars) {
          // Profitability check: estimate PnL before closing
          const spreadChange = spread[i] - entrySpread;
          const pnlDirection = direction === 'SHORT_SPREAD' ? -1 : 1;
          const rawPnl = pnlDirection * spreadChange * config.capitalPerLeg * config.leverage;
          const fees = config.capitalPerLeg * config.leverage * 2 * config.feeRate * 2;
          const netPnl = rawPnl - fees;

          if (netPnl > 0) {
            closeReason = 'TP';
          }
          // If netPnl <= 0, hold — don't close at a loss just because Z hit exit
        }
        // If barsHeld < minHoldBars, hold — too early
      }
      // Stop loss (respecting grace period)
      else if (i >= gracePeriodEnd && absZ > config.stopLossZ) {
        closeReason = 'SL';
      }
      // Trailing stop — Z was converging but now bouncing back
      else if (trailingEnabled && absZ >= trailingBestZ + trailingStopZ) {
        closeReason = 'TRAILING';
      }

      if (closeReason) {
        // Calculate PnL
        const spreadChange = spread[i] - entrySpread;
        const pnlDirection = direction === 'SHORT_SPREAD' ? -1 : 1;
        const rawPnl = pnlDirection * spreadChange * config.capitalPerLeg * config.leverage;

        // Subtract fees (entry + exit for both legs)
        const fees = config.capitalPerLeg * config.leverage * 2 * config.feeRate * 2;
        const pnl = rawPnl - fees;
        const pnlPercent = pnl / (config.capitalPerLeg * 2);

        trades.push({
          entryBar,
          exitBar: i,
          direction,
          entryZ,
          exitZ: z,
          entrySpread,
          exitSpread: spread[i],
          pnl,
          pnlPercent,
          closeReason,
          barsHeld,
        });

        inPosition = false;
        cooldownUntil = i + config.cooldownBars;
      }
    }
  }

  return generateReport(config, pair, trades);
}

function generateReport(config: BacktestConfig, pair: string, trades: BacktestTrade[]): BacktestReport {
  if (trades.length === 0) return emptyReport(config, pair);

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const avgPnl = totalPnl / trades.length;

  // Sharpe Ratio (annualized, assuming 1h bars)
  const pnls = trades.map(t => t.pnlPercent);
  const pnlMean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const pnlStd = Math.sqrt(
    pnls.reduce((a, b) => a + (b - pnlMean) ** 2, 0) / pnls.length
  );
  const sharpeRatio = pnlStd > 0 ? (pnlMean / pnlStd) * Math.sqrt(8760 / (trades.length || 1)) : 0;

  // Max Drawdown
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgBarsHeld = trades.reduce((sum, t) => sum + t.barsHeld, 0) / trades.length;

  return {
    config,
    pair,
    trades,
    totalTrades: trades.length,
    winRate: wins.length / trades.length,
    totalPnl,
    avgPnl,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownPercent: peak > 0 ? maxDrawdown / peak : 0,
    profitFactor,
    avgBarsHeld,
  };
}

function emptyReport(config: BacktestConfig, pair: string): BacktestReport {
  return {
    config,
    pair,
    trades: [],
    totalTrades: 0,
    winRate: 0,
    totalPnl: 0,
    avgPnl: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    profitFactor: 0,
    avgBarsHeld: 0,
  };
}
