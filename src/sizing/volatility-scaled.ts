import type { SizingResult } from '../types.js';

/**
 * Calculate Average True Range (simplified for crypto — no gaps)
 */
export function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }

  // Simple average of last `period` TRs
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/**
 * Volatility-Scaled sizing: adjust position size inversely proportional to ATR
 * Higher ATR → smaller position (more volatile asset gets less capital)
 */
export function volatilityScaled(
  priceA: number,
  priceB: number,
  atrA: number,
  atrB: number,
  capitalPerLeg: number,
  leverage: number,
  lotSizeA: number = 1,
  lotSizeB: number = 1,
): SizingResult {
  // ATR as % of price
  const atrPctA = priceA > 0 ? atrA / priceA : 0;
  const atrPctB = priceB > 0 ? atrB / priceB : 0;

  // Inverse volatility weighting
  const totalInvVol = (atrPctA > 0 ? 1 / atrPctA : 0) + (atrPctB > 0 ? 1 / atrPctB : 0);

  let capitalA: number;
  let capitalB: number;

  if (totalInvVol > 0) {
    const weightA = atrPctA > 0 ? (1 / atrPctA) / totalInvVol : 0.5;
    const weightB = atrPctB > 0 ? (1 / atrPctB) / totalInvVol : 0.5;
    capitalA = capitalPerLeg * 2 * weightA;
    capitalB = capitalPerLeg * 2 * weightB;
  } else {
    capitalA = capitalPerLeg;
    capitalB = capitalPerLeg;
  }

  const notionalA = capitalA * leverage;
  const notionalB = capitalB * leverage;

  const rawSizeA = notionalA / priceA;
  const rawSizeB = notionalB / priceB;

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
