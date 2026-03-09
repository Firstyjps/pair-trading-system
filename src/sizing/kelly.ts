import type { SizingResult } from '../types.js';

/**
 * Kelly Criterion sizing: f* = (p * b - q) / b
 * where p = win rate, b = avg win / avg loss, q = 1 - p
 */
export function kellyCriterion(
  priceA: number,
  priceB: number,
  totalCapital: number,
  leverage: number,
  winRate: number,
  avgWin: number,
  avgLoss: number,
  kellyFraction: number = 0.5, // Half-Kelly for safety
  lotSizeA: number = 1,
  lotSizeB: number = 1,
): SizingResult {
  const p = Math.max(0, Math.min(1, winRate));
  const q = 1 - p;
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;

  let kellyPercent = (p * b - q) / b;

  // Apply fraction (half-Kelly) and clamp
  kellyPercent = Math.max(0, Math.min(0.25, kellyPercent * kellyFraction));

  const capitalPerLeg = totalCapital * kellyPercent;
  const notional = capitalPerLeg * leverage;

  const rawSizeA = notional / priceA;
  const rawSizeB = notional / priceB;

  const legASize = Math.floor(rawSizeA / lotSizeA) * lotSizeA;
  const legBSize = Math.floor(rawSizeB / lotSizeB) * lotSizeB;

  const legANotional = legASize * priceA;
  const legBNotional = legBSize * priceB;

  return {
    legASize,
    legBSize,
    legANotional,
    legBNotional,
    totalExposure: legANotional + legBNotional,
  };
}
