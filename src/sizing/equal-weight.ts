import type { SizingResult } from '../types.js';

/**
 * Equal Weight sizing: fixed contract count for both legs
 */
export function equalWeight(
  priceA: number,
  priceB: number,
  contractCount: number,
  lotSizeA: number = 1,
  lotSizeB: number = 1,
): SizingResult {
  // Round to lot size
  const legASize = Math.floor(contractCount / lotSizeA) * lotSizeA;
  const legBSize = Math.floor(contractCount / lotSizeB) * lotSizeB;

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
