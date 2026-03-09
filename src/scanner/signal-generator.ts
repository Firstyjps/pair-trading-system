import { v4 as uuid } from 'uuid';
import type { TradingQueries } from '../db/queries.js';
import type { Signal, Direction } from '../types.js';
import type { CointegrationResult } from './cointegration.js';
import { getTradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('signal-generator');

export interface ZScoreData {
  zScore: number;
  spread: number;
  mean: number;
  std: number;
}

/**
 * Calculate Z-Score from spread
 * Spread = log(PriceA) - beta * log(PriceB)
 */
export function calculateZScore(
  pricesA: number[],
  pricesB: number[],
  beta: number,
  window?: number,
): ZScoreData {
  const n = Math.min(pricesA.length, pricesB.length);
  const effectiveWindow = window ?? n;
  const startIdx = Math.max(0, n - effectiveWindow);

  // Calculate spread for the window
  const spreads: number[] = [];
  for (let i = startIdx; i < n; i++) {
    spreads.push(Math.log(pricesA[i]) - beta * Math.log(pricesB[i]));
  }

  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const variance = spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length;
  const std = Math.sqrt(variance);

  const currentSpread = spreads[spreads.length - 1];
  const zScore = std > 0 ? (currentSpread - mean) / std : 0;

  return { zScore, spread: currentSpread, mean, std };
}

export interface SignalCandidate {
  symbolA: string;
  symbolB: string;
  direction: Direction;
  zScore: number;
  spread: number;
  correlation: number;
  cointegrationPValue: number;
  halfLife: number;
}

/**
 * Generate trading signals from Z-Score
 */
export function generateSignals(
  pairs: Array<{
    symbolA: string;
    symbolB: string;
    correlation: number;
    coint: CointegrationResult;
    pricesA: number[];
    pricesB: number[];
  }>,
): SignalCandidate[] {
  const config = getTradingConfig();
  const signals: SignalCandidate[] = [];

  for (const pair of pairs) {
    const { zScore, spread, std } = calculateZScore(
      pair.pricesA,
      pair.pricesB,
      pair.coint.beta,
    );

    const absZ = Math.abs(zScore);
    let direction: Direction | null = null;

    // SHORT_SPREAD: Z > +entryZ → sell A, buy B (spread too high, expect reversion)
    if (zScore > config.entryZScore) {
      direction = 'SHORT_SPREAD';
    }
    // LONG_SPREAD: Z < -entryZ → buy A, sell B (spread too low, expect reversion)
    else if (zScore < -config.entryZScore) {
      direction = 'LONG_SPREAD';
    }

    if (direction) {
      // Note: No safe zone block here — if Z exceeds entry threshold,
      // the signal is valid. Stop-loss only applies AFTER entering a position.

      // Min profit check: expected reversion must cover fees
      // Expected profit ≈ (|Z| - exitZ) * std; Fees ≈ 2 * feeRate * capital
      const feeRate = config.feeRate ?? 0.0006;
      const minProfitMult = config.minProfitMultiplier ?? 2.0;
      const expectedReversionZ = absZ - config.exitZScore;
      const feeCostZ = feeRate * 2 * minProfitMult * (1 / (std > 0 ? std : 1));
      if (expectedReversionZ > 0 && std > 0 && expectedReversionZ * std < feeRate * 2 * minProfitMult) {
        log.info({
          pair: `${pair.symbolA}/${pair.symbolB}`,
          zScore: zScore.toFixed(4),
          expectedReversionZ: expectedReversionZ.toFixed(4),
          std: std.toFixed(6),
        }, 'Signal rejected — expected profit too small to cover fees');
        continue;
      }

      signals.push({
        symbolA: pair.symbolA,
        symbolB: pair.symbolB,
        direction,
        zScore,
        spread,
        correlation: pair.correlation,
        cointegrationPValue: pair.coint.pValue,
        halfLife: pair.coint.halfLife,
      });

      log.info({
        pair: `${pair.symbolA}/${pair.symbolB}`,
        direction,
        zScore: zScore.toFixed(4),
        correlation: pair.correlation.toFixed(4),
      }, 'Signal generated');
    }
  }

  return signals;
}

/**
 * Persist signals to DB with dedup
 */
export function persistSignals(
  queries: TradingQueries,
  candidates: SignalCandidate[],
): Signal[] {
  const config = getTradingConfig();
  const persisted: Signal[] = [];

  for (const candidate of candidates) {
    const pair = `${candidate.symbolA}/${candidate.symbolB}`;

    // Dedup: check if recent signal exists for same pair+direction
    if (config.signalDedup) {
      const recentSignals = queries.getRecentSignals(pair, config.notificationTTL);
      const duplicate = recentSignals.find(s =>
        s.direction === candidate.direction &&
        Math.abs(s.z_score - candidate.zScore) < 0.1
      );

      if (duplicate) {
        log.debug({ pair, direction: candidate.direction }, 'Duplicate signal skipped');
        continue;
      }
    }

    const signal: Signal = {
      id: uuid(),
      pair,
      direction: candidate.direction,
      z_score: candidate.zScore,
      spread: candidate.spread,
      correlation: candidate.correlation,
      cointegration_pvalue: candidate.cointegrationPValue,
      half_life: candidate.halfLife,
      created_at: new Date().toISOString(),
      acted_on: false,
    };

    queries.insertSignal(signal);
    persisted.push(signal);
  }

  log.info({ generated: candidates.length, persisted: persisted.length }, 'Signals processed');
  return persisted;
}
