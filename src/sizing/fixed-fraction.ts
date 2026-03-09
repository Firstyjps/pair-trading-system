import type { SizingResult } from '../types.js';

/**
 * Fixed Fraction sizing: x% of total capital per trade
 */
export function fixedFraction(
  priceA: number,
  priceB: number,
  totalCapital: number,
  fractionPercent: number,
  leverage: number,
  lotSizeA: number = 1,
  lotSizeB: number = 1,
): SizingResult {
  const fraction = Math.max(0.01, Math.min(1, fractionPercent));
  const capitalPerLeg = (totalCapital * fraction) / 2; // Split between two legs
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
