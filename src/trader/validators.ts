import type { OrderParams, ValidationResult } from '../types.js';
import { createChildLogger } from '../logger.js';
import { getTradingConfig } from '../config.js';

const log = createChildLogger('validators');

const MAX_ORDER_SIZE = 1_000_000; // Hard cap on contract size

export function validateOrder(order: OrderParams): ValidationResult {
  const failures: string[] = [];

  if (!order.instrument) {
    failures.push('instrument is undefined');
  } else if (!order.instrument.endsWith('-USDT-SWAP')) {
    failures.push(`instrument "${order.instrument}" must end with -USDT-SWAP`);
  }

  if (order.price !== undefined) {
    if (!Number.isFinite(order.price)) {
      failures.push(`price is not finite: ${order.price}`);
    } else if (order.price <= 0) {
      failures.push(`price must be positive: ${order.price}`);
    }
  }

  if (!Number.isFinite(order.size)) {
    failures.push(`size is not finite: ${order.size}`);
  } else if (order.size <= 0) {
    failures.push(`size must be positive: ${order.size}`);
  } else if (order.size > MAX_ORDER_SIZE) {
    failures.push(`size ${order.size} exceeds max ${MAX_ORDER_SIZE}`);
  }

  if (!Number.isFinite(order.leverage)) {
    failures.push(`leverage is not finite: ${order.leverage}`);
  } else if (order.leverage < 1 || order.leverage > 10) {
    failures.push(`leverage must be 1-10: ${order.leverage}`);
  }

  if (order.side !== 'buy' && order.side !== 'sell') {
    failures.push(`side must be 'buy' or 'sell': ${order.side}`);
  }

  if (failures.length > 0) {
    log.warn({ order, failures }, 'Order validation failed');
  }

  return { valid: failures.length === 0, failures };
}

export function validatePairTrade(
  legA: OrderParams,
  legB: OrderParams
): ValidationResult {
  const config = getTradingConfig();
  const failures: string[] = [];

  // Validate each leg
  const legAResult = validateOrder(legA);
  const legBResult = validateOrder(legB);

  failures.push(...legAResult.failures.map(f => `Leg A: ${f}`));
  failures.push(...legBResult.failures.map(f => `Leg B: ${f}`));

  // Pair-level checks
  if (legA.instrument === legB.instrument) {
    failures.push('Both legs have the same instrument');
  }

  // Legs should be on opposite sides
  if (legA.side === legB.side) {
    failures.push('Both legs have the same side — not a pair trade');
  }

  // Leverage hard cap (5x for pair trades)
  const leverageCap = 5;
  if (legA.leverage > leverageCap) {
    failures.push(`Leg A leverage ${legA.leverage} exceeds hard cap of ${leverageCap}x`);
  }
  if (legB.leverage > leverageCap) {
    failures.push(`Leg B leverage ${legB.leverage} exceeds hard cap of ${leverageCap}x`);
  }

  return { valid: failures.length === 0, failures };
}

export function isInSafeEntryZone(zScore: number, entryZ: number, stopLossZ: number, buffer: number): boolean {
  // Entry must be sufficiently far from stop loss
  if (Math.abs(zScore) <= entryZ) return false; // Not at entry level yet
  return Math.abs(zScore) < stopLossZ - buffer;
}

export function shouldTriggerStopLoss(
  openedAt: string,
  currentZ: number,
  stopLossZ: number,
  gracePeriodMs: number
): boolean {
  const age = Date.now() - new Date(openedAt).getTime();
  if (age < gracePeriodMs) return false;
  return Math.abs(currentZ) > stopLossZ;
}

export function shouldTriggerTakeProfit(currentZ: number, exitZ: number): boolean {
  return Math.abs(currentZ) <= exitZ;
}
