import { createChildLogger } from '../logger.js';
import { pearsonCorrelation, logReturns } from '../scanner/correlation.js';

const log = createChildLogger('portfolio-risk');

export interface OpenPairInfo {
  pair: string;       // e.g. "PEPE/SHIB"
  symbolA: string;    // e.g. "PEPE"
  symbolB: string;    // e.g. "SHIB"
}

/**
 * Check if a new pair would create excessive correlation with existing positions.
 *
 * Rules:
 * 1. No shared symbols — if PEPE/SHIB is open, don't open PEPE/DOGE (shared PEPE exposure)
 * 2. Spread correlation — if two pairs' spreads are highly correlated, they're the same bet
 *
 * @returns { allowed: boolean, reason?: string }
 */
export function checkCrossPairRisk(
  newPair: string,
  openPairs: OpenPairInfo[],
  priceData: Map<string, number[]>,
  betaMap: Map<string, number>,
  maxSpreadCorrelation: number = 0.7,
): { allowed: boolean; reason?: string } {
  const [newSymA, newSymB] = newPair.split('/');

  if (openPairs.length === 0) {
    return { allowed: true };
  }

  // Rule 1: No shared symbols
  for (const existing of openPairs) {
    if (existing.symbolA === newSymA || existing.symbolA === newSymB ||
        existing.symbolB === newSymA || existing.symbolB === newSymB) {
      const reason = `Shared symbol with ${existing.pair} — overlapping exposure`;
      log.info({ newPair, existingPair: existing.pair, reason }, 'Cross-pair risk: blocked');
      return { allowed: false, reason };
    }
  }

  // Rule 2: Spread correlation check
  const newPricesA = priceData.get(newSymA);
  const newPricesB = priceData.get(newSymB);
  const newBeta = betaMap.get(newPair) ?? 1;

  if (!newPricesA || !newPricesB || newPricesA.length < 30) {
    // Can't check — allow by default
    return { allowed: true };
  }

  // Calculate new pair's spread
  const n = Math.min(newPricesA.length, newPricesB.length);
  const newSpread: number[] = [];
  for (let i = 0; i < n; i++) {
    newSpread.push(Math.log(newPricesA[i]) - newBeta * Math.log(newPricesB[i]));
  }

  for (const existing of openPairs) {
    const exPricesA = priceData.get(existing.symbolA);
    const exPricesB = priceData.get(existing.symbolB);
    const exBeta = betaMap.get(existing.pair) ?? 1;

    if (!exPricesA || !exPricesB || exPricesA.length < 30) continue;

    const m = Math.min(exPricesA.length, exPricesB.length);
    const exSpread: number[] = [];
    for (let i = 0; i < m; i++) {
      exSpread.push(Math.log(exPricesA[i]) - exBeta * Math.log(exPricesB[i]));
    }

    // Align lengths and compute correlation on returns
    const minLen = Math.min(newSpread.length, exSpread.length);
    const newSlice = newSpread.slice(-minLen);
    const exSlice = exSpread.slice(-minLen);

    const newReturns = logReturns(newSlice);
    const exReturns = logReturns(exSlice);

    if (newReturns.length < 20) continue;

    const corr = Math.abs(pearsonCorrelation(newReturns, exReturns));

    if (corr > maxSpreadCorrelation) {
      const reason = `Spread correlation ${corr.toFixed(2)} with ${existing.pair} exceeds ${maxSpreadCorrelation}`;
      log.info({ newPair, existingPair: existing.pair, correlation: corr.toFixed(4), reason }, 'Cross-pair risk: blocked');
      return { allowed: false, reason };
    }

    log.debug({ newPair, existingPair: existing.pair, correlation: corr.toFixed(4) }, 'Cross-pair spread correlation OK');
  }

  return { allowed: true };
}

/**
 * Get total portfolio exposure per symbol across all open pairs.
 * Useful for monitoring concentration risk.
 */
export function getSymbolExposure(
  openPairs: OpenPairInfo[],
): Map<string, number> {
  const exposure = new Map<string, number>();
  for (const p of openPairs) {
    exposure.set(p.symbolA, (exposure.get(p.symbolA) ?? 0) + 1);
    exposure.set(p.symbolB, (exposure.get(p.symbolB) ?? 0) + 1);
  }
  return exposure;
}
