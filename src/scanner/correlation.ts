import { createChildLogger } from '../logger.js';

const log = createChildLogger('correlation');

export interface PairCorrelation {
  symbolA: string;
  symbolB: string;
  correlation: number;
  sectorA?: string;
  sectorB?: string;
}

/**
 * Calculate log returns from close prices
 */
export function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] <= 0 || prices[i - 1] <= 0) continue;
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  return returns;
}

/**
 * Pearson correlation coefficient
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;

  const r = numerator / denominator;
  return Math.max(-1, Math.min(1, r)); // Clamp to [-1, 1]
}

/**
 * Rolling Pearson correlation
 */
export function rollingCorrelation(x: number[], y: number[], window: number): number[] {
  const result: number[] = [];
  const n = Math.min(x.length, y.length);

  for (let i = window - 1; i < n; i++) {
    const xSlice = x.slice(i - window + 1, i + 1);
    const ySlice = y.slice(i - window + 1, i + 1);
    result.push(pearsonCorrelation(xSlice, ySlice));
  }

  return result;
}

/**
 * Build correlation matrix for all pairs above threshold
 */
export function buildCorrelationMatrix(
  priceData: Map<string, number[]>,
  threshold: number = 0.75,
): PairCorrelation[] {
  const symbols = Array.from(priceData.keys());
  const logReturnData = new Map<string, number[]>();

  // Pre-compute log returns
  for (const [symbol, prices] of priceData) {
    const returns = logReturns(prices);
    if (returns.length < 10) {
      log.debug({ symbol, returns: returns.length }, 'Skipping — too few returns');
      continue;
    }
    logReturnData.set(symbol, returns);
  }

  const validSymbols = Array.from(logReturnData.keys());
  const pairs: PairCorrelation[] = [];

  for (let i = 0; i < validSymbols.length; i++) {
    for (let j = i + 1; j < validSymbols.length; j++) {
      const a = logReturnData.get(validSymbols[i])!;
      const b = logReturnData.get(validSymbols[j])!;

      // Align lengths
      const minLen = Math.min(a.length, b.length);
      const corr = pearsonCorrelation(a.slice(-minLen), b.slice(-minLen));

      if (corr >= threshold) {
        pairs.push({
          symbolA: validSymbols[i],
          symbolB: validSymbols[j],
          correlation: corr,
        });
      }
    }
  }

  pairs.sort((a, b) => b.correlation - a.correlation);
  log.info({ totalSymbols: validSymbols.length, pairsAboveThreshold: pairs.length, threshold }, 'Correlation matrix built');

  return pairs;
}

// Sector tagging for filtering
const SECTOR_MAP: Record<string, string> = {
  'DOGE': 'meme', 'SHIB': 'meme', 'PEPE': 'meme', 'FLOKI': 'meme', 'BONK': 'meme',
  'WIF': 'meme', 'HMSTR': 'meme', 'BABY': 'meme', 'MEME': 'meme', 'NEIRO': 'meme',
  'BTC': 'l1', 'ETH': 'l1', 'SOL': 'l1', 'AVAX': 'l1', 'NEAR': 'l1', 'SUI': 'l1',
  'APT': 'l1', 'SEI': 'l1', 'TIA': 'l1', 'INJ': 'l1',
  'ARB': 'l2', 'OP': 'l2', 'MATIC': 'l2', 'POL': 'l2', 'STRK': 'l2', 'MANTA': 'l2',
  'AAVE': 'defi', 'UNI': 'defi', 'LINK': 'defi', 'MKR': 'defi', 'SNX': 'defi',
  'CRV': 'defi', 'COMP': 'defi', 'SUSHI': 'defi', 'DYDX': 'defi',
  'AXS': 'gaming', 'SAND': 'gaming', 'MANA': 'gaming', 'GALA': 'gaming',
  'IMX': 'gaming', 'ILV': 'gaming', 'PIXEL': 'gaming',
};

export function getSector(symbol: string): string {
  const base = symbol.replace('-USDT-SWAP', '').replace('/USDT:USDT', '');
  return SECTOR_MAP[base] ?? 'other';
}

export function tagSectors(pairs: PairCorrelation[]): PairCorrelation[] {
  return pairs.map(p => ({
    ...p,
    sectorA: getSector(p.symbolA),
    sectorB: getSector(p.symbolB),
  }));
}
