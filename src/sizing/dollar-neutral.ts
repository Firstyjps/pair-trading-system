import type { SizingResult } from '../types.js';

/**
 * Dollar-Neutral sizing: equal USD exposure on both legs
 */
export function dollarNeutral(
  priceA: number,
  priceB: number,
  capitalPerLeg: number,
  leverage: number,
  lotSizeA: number = 1,
  lotSizeB: number = 1,
): SizingResult {
  const notional = capitalPerLeg * leverage;

  // Raw contract sizes
  const rawSizeA = notional / priceA;
  const rawSizeB = notional / priceB;

  // Round to lot size
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
