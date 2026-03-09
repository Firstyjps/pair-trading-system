import { describe, it, expect, beforeEach } from 'vitest';
import { validateOrder, validatePairTrade, isInSafeEntryZone, shouldTriggerStopLoss, shouldTriggerTakeProfit } from '../../src/trader/validators.js';
import { resetConfigForTesting, loadTradingConfig } from '../../src/config.js';
import type { OrderParams } from '../../src/types.js';

beforeEach(() => {
  resetConfigForTesting();
  loadTradingConfig(); // Load defaults
});

describe('validateOrder', () => {
  const validOrder: OrderParams = {
    instrument: 'BTC-USDT-SWAP',
    side: 'buy',
    size: 10,
    price: 50000,
    leverage: 5,
  };

  it('should pass valid order', () => {
    expect(validateOrder(validOrder).valid).toBe(true);
  });

  it('should reject undefined instrument', () => {
    const result = validateOrder({ ...validOrder, instrument: undefined as any });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('instrument'))).toBe(true);
  });

  it('should reject non-SWAP instrument', () => {
    const result = validateOrder({ ...validOrder, instrument: 'BTC-USDT' });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('USDT-SWAP'))).toBe(true);
  });

  it('should reject Infinity size', () => {
    const result = validateOrder({ ...validOrder, size: Infinity });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('not finite'))).toBe(true);
  });

  it('should reject NaN size', () => {
    const result = validateOrder({ ...validOrder, size: NaN });
    expect(result.valid).toBe(false);
  });

  it('should reject negative size', () => {
    const result = validateOrder({ ...validOrder, size: -10 });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('positive'))).toBe(true);
  });

  it('should reject zero size', () => {
    const result = validateOrder({ ...validOrder, size: 0 });
    expect(result.valid).toBe(false);
  });

  it('should reject size exceeding max', () => {
    const result = validateOrder({ ...validOrder, size: 2_000_000 });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('exceeds max'))).toBe(true);
  });

  it('should reject negative price', () => {
    const result = validateOrder({ ...validOrder, price: -100 });
    expect(result.valid).toBe(false);
  });

  it('should reject zero price', () => {
    const result = validateOrder({ ...validOrder, price: 0 });
    expect(result.valid).toBe(false);
  });

  it('should reject Infinity price', () => {
    const result = validateOrder({ ...validOrder, price: Infinity });
    expect(result.valid).toBe(false);
  });

  it('should reject NaN price', () => {
    const result = validateOrder({ ...validOrder, price: NaN });
    expect(result.valid).toBe(false);
  });

  it('should allow undefined price (market order)', () => {
    const result = validateOrder({ ...validOrder, price: undefined });
    expect(result.valid).toBe(true);
  });

  it('should reject leverage below 1', () => {
    const result = validateOrder({ ...validOrder, leverage: 0 });
    expect(result.valid).toBe(false);
  });

  it('should reject leverage above 10', () => {
    const result = validateOrder({ ...validOrder, leverage: 11 });
    expect(result.valid).toBe(false);
  });

  it('should reject invalid side', () => {
    const result = validateOrder({ ...validOrder, side: 'hold' as any });
    expect(result.valid).toBe(false);
  });

  it('should collect multiple failures', () => {
    const result = validateOrder({
      instrument: 'INVALID',
      side: 'buy',
      size: -1,
      price: NaN,
      leverage: 100,
    });
    expect(result.valid).toBe(false);
    expect(result.failures.length).toBeGreaterThan(2);
  });
});

describe('validatePairTrade', () => {
  const legA: OrderParams = {
    instrument: 'BTC-USDT-SWAP',
    side: 'buy',
    size: 10,
    leverage: 5,
  };
  const legB: OrderParams = {
    instrument: 'ETH-USDT-SWAP',
    side: 'sell',
    size: 100,
    leverage: 5,
  };

  it('should pass valid pair trade', () => {
    expect(validatePairTrade(legA, legB).valid).toBe(true);
  });

  it('should reject same instrument on both legs', () => {
    const result = validatePairTrade(legA, { ...legB, instrument: 'BTC-USDT-SWAP' });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('same instrument'))).toBe(true);
  });

  it('should reject same side on both legs', () => {
    const result = validatePairTrade(legA, { ...legB, side: 'buy' });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('same side'))).toBe(true);
  });

  it('should reject leverage > 5x hard cap', () => {
    const result = validatePairTrade(
      { ...legA, leverage: 6 },
      { ...legB, leverage: 6 },
    );
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('hard cap'))).toBe(true);
  });
});

describe('isInSafeEntryZone', () => {
  const entryZ = 2.0;
  const stopLossZ = 3.5;
  const buffer = 0.5;

  it('should allow entry at Z=2.5 (well within safe zone)', () => {
    expect(isInSafeEntryZone(2.5, entryZ, stopLossZ, buffer)).toBe(true);
  });

  it('should reject entry at Z=3.1 (too close to SL at 3.5, buffer=0.5)', () => {
    expect(isInSafeEntryZone(3.1, entryZ, stopLossZ, buffer)).toBe(false);
  });

  it('should reject entry at Z=3.607 (the actual bug case)', () => {
    expect(isInSafeEntryZone(3.607, 2.0, 3.5, 0.5)).toBe(false);
  });

  it('should allow negative Z for LONG_SPREAD', () => {
    expect(isInSafeEntryZone(-2.5, entryZ, stopLossZ, buffer)).toBe(true);
  });

  it('should reject negative Z too close to SL', () => {
    expect(isInSafeEntryZone(-3.1, entryZ, stopLossZ, buffer)).toBe(false);
  });

  it('should reject Z below entry threshold', () => {
    expect(isInSafeEntryZone(1.5, entryZ, stopLossZ, buffer)).toBe(false);
  });

  it('should handle exact boundary: entryZ', () => {
    expect(isInSafeEntryZone(2.0, entryZ, stopLossZ, buffer)).toBe(false);
  });

  it('should handle exact boundary: SL - buffer', () => {
    expect(isInSafeEntryZone(3.0, entryZ, stopLossZ, buffer)).toBe(false);
  });

  it('should allow Z just above entry', () => {
    expect(isInSafeEntryZone(2.01, entryZ, stopLossZ, buffer)).toBe(true);
  });

  it('should allow Z just below SL - buffer', () => {
    expect(isInSafeEntryZone(2.99, entryZ, stopLossZ, buffer)).toBe(true);
  });
});

describe('shouldTriggerStopLoss', () => {
  it('should not trigger during grace period', () => {
    const openedAt = new Date().toISOString(); // just opened
    expect(shouldTriggerStopLoss(openedAt, 4.0, 3.5, 300000)).toBe(false);
  });

  it('should trigger after grace period if Z > SL', () => {
    const openedAt = new Date(Date.now() - 600000).toISOString(); // 10 min ago
    expect(shouldTriggerStopLoss(openedAt, 4.0, 3.5, 300000)).toBe(true);
  });

  it('should not trigger after grace period if Z < SL', () => {
    const openedAt = new Date(Date.now() - 600000).toISOString();
    expect(shouldTriggerStopLoss(openedAt, 2.0, 3.5, 300000)).toBe(false);
  });

  it('should handle negative Z-Scores', () => {
    const openedAt = new Date(Date.now() - 600000).toISOString();
    expect(shouldTriggerStopLoss(openedAt, -4.0, 3.5, 300000)).toBe(true);
  });
});

describe('shouldTriggerTakeProfit', () => {
  it('should trigger when Z crosses below exit threshold', () => {
    expect(shouldTriggerTakeProfit(0.3, 0.5)).toBe(true);
  });

  it('should trigger at exact exit Z', () => {
    expect(shouldTriggerTakeProfit(0.5, 0.5)).toBe(true);
  });

  it('should not trigger when Z is above exit', () => {
    expect(shouldTriggerTakeProfit(1.5, 0.5)).toBe(false);
  });

  it('should handle negative Z near zero', () => {
    expect(shouldTriggerTakeProfit(-0.2, 0.5)).toBe(true);
  });
});
