import { v4 as uuid } from 'uuid';
import type { TradingQueries } from '../db/queries.js';
import type { PairPosition, Direction, OrderParams } from '../types.js';
import { validatePairTrade, isInSafeEntryZone } from './validators.js';
import { rollbackLegA, verifyPositionClosed, type ExchangeAdapter } from './rollback.js';
import { getTradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('order-executor');

export interface OrderResult {
  success: boolean;
  positionId?: string;
  error?: string;
}

export interface ExchangeOrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  error?: string;
}

export interface FullExchangeAdapter extends ExchangeAdapter {
  createOrder(params: OrderParams): Promise<ExchangeOrderResult>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  getPosition(symbol: string): Promise<{ size: number; side: string } | null>;
  closePosition(symbol: string, side: 'buy' | 'sell', size: number): Promise<{ success: boolean; orderId?: string; avgPrice?: number; error?: string }>;
  getContractSize(symbol: string): Promise<number>;
}

export async function executePairTrade(
  exchange: FullExchangeAdapter,
  queries: TradingQueries,
  legA: OrderParams,
  legB: OrderParams,
  direction: Direction,
  zScore: number,
  spread: number,
  signalId: string,
  groupId: string,
): Promise<OrderResult> {
  const config = getTradingConfig();
  const positionId = uuid();

  // Step 1: Validate both legs before sending anything
  const validation = validatePairTrade(legA, legB);
  if (!validation.valid) {
    log.error({ failures: validation.failures }, 'Pair trade validation failed');
    return { success: false, error: `Validation failed: ${validation.failures.join('; ')}` };
  }

  // Step 2: Safe entry zone check
  if (!isInSafeEntryZone(zScore, config.entryZScore, config.stopLossZScore, config.safeZoneBuffer)) {
    log.warn({ zScore, entryZ: config.entryZScore, slZ: config.stopLossZScore }, 'Not in safe entry zone');
    return { success: false, error: 'Not in safe entry zone — too close to stop loss' };
  }

  // Step 3: Create position in DB as PENDING
  const pair = `${legA.instrument.replace('-USDT-SWAP', '')}/${legB.instrument.replace('-USDT-SWAP', '')}`;
  const position: PairPosition = {
    id: positionId,
    pair,
    direction,
    state: 'PENDING',
    leg_a_symbol: legA.instrument,
    leg_a_side: legA.side,
    leg_a_size: legA.size,
    leg_a_entry_price: null,
    leg_a_order_id: null,
    leg_b_symbol: legB.instrument,
    leg_b_side: legB.side,
    leg_b_size: legB.size,
    leg_b_entry_price: null,
    leg_b_order_id: null,
    entry_z_score: zScore,
    entry_spread: spread,
    current_z_score: zScore,
    stop_loss_z: config.stopLossZScore,
    take_profit_z: config.exitZScore,
    leverage: legA.leverage,
    margin_per_leg: config.maxCapitalPerPair,
    pnl: null,
    signal_id: signalId,
    group_id: groupId,
    opened_at: new Date().toISOString(),
    closed_at: null,
    close_reason: null,
    metadata: null,
  };

  queries.insertPosition(position);
  log.info({ positionId, pair, direction }, 'Position created as PENDING');

  try {
    // Step 4: Set leverage for both instruments
    await exchange.setLeverage(legA.instrument, legA.leverage);
    await exchange.setLeverage(legB.instrument, legB.leverage);

    // Step 5: Execute Leg A
    log.info({ instrument: legA.instrument, side: legA.side, size: legA.size }, 'Executing Leg A');
    const resultA = await exchange.createOrder(legA);

    if (!resultA.success) {
      queries.updatePositionState(positionId, 'ERROR', {
        metadata: JSON.stringify({ error: `Leg A failed: ${resultA.error}` }),
      });
      log.error({ error: resultA.error }, 'Leg A execution failed');
      return { success: false, error: `Leg A failed: ${resultA.error}` };
    }

    // Step 6: Update DB — state = LEG_A_OPEN
    queries.updatePositionState(positionId, 'LEG_A_OPEN', {
      leg_a_order_id: resultA.orderId,
      leg_a_entry_price: resultA.avgPrice,
    });
    log.info({ orderId: resultA.orderId }, 'Leg A opened, state = LEG_A_OPEN');

    // Step 7: Execute Leg B
    log.info({ instrument: legB.instrument, side: legB.side, size: legB.size }, 'Executing Leg B');
    const resultB = await exchange.createOrder(legB);

    if (!resultB.success) {
      log.error({ error: resultB.error }, 'Leg B failed — initiating rollback of Leg A');

      // Step 8: ROLLBACK — Close Leg A immediately
      const oppositeSide = legA.side === 'buy' ? 'sell' : 'buy';
      const rollbackResult = await rollbackLegA(exchange, legA.instrument, legA.side, legA.size);

      if (rollbackResult.success) {
        queries.updatePositionState(positionId, 'ERROR', {
          metadata: JSON.stringify({
            error: `Leg B failed: ${resultB.error}`,
            rollback: 'success',
          }),
        });
      } else {
        // CRITICAL: Orphan position on exchange
        queries.updatePositionState(positionId, 'ERROR', {
          metadata: JSON.stringify({
            error: `Leg B failed: ${resultB.error}`,
            rollback: 'FAILED — ORPHAN POSITION',
            orphanSymbol: legA.instrument,
            orphanSide: legA.side,
            orphanSize: legA.size,
          }),
        });
        log.error({ symbol: legA.instrument }, 'CRITICAL: Rollback failed — orphan position on exchange');
      }

      return { success: false, error: `Leg B failed: ${resultB.error}` };
    }

    // Step 9: Both legs open — update DB
    queries.updatePositionState(positionId, 'BOTH_LEGS_OPEN', {
      leg_b_order_id: resultB.orderId,
      leg_b_entry_price: resultB.avgPrice,
    });
    log.info({ positionId, pair }, 'Both legs open — pair trade executed successfully');

    return { success: true, positionId };
  } catch (err) {
    log.error({ positionId, error: err }, 'Unexpected error during pair trade execution');
    queries.updatePositionState(positionId, 'ERROR', {
      metadata: JSON.stringify({ error: String(err) }),
    });
    return { success: false, error: String(err) };
  }
}

export async function closePairPosition(
  exchange: FullExchangeAdapter,
  queries: TradingQueries,
  position: PairPosition,
  reason: 'TP' | 'SL' | 'MANUAL' | 'ORPHAN' | 'ERROR',
): Promise<OrderResult> {
  const positionId = position.id;

  // Update state to CLOSING
  queries.updatePositionState(positionId, 'CLOSING');
  log.info({ positionId, pair: position.pair, reason }, 'Closing pair position');

  let legAClosed = false;
  let legBClosed = false;
  let totalPnl = 0;
  let exitPriceA = 0;
  let exitPriceB = 0;

  try {
    // Close Leg A
    const oppositeSideA = position.leg_a_side === 'buy' ? 'sell' : 'buy';
    const resultA = await exchange.closePosition(
      position.leg_a_symbol,
      oppositeSideA as 'buy' | 'sell',
      position.leg_a_size
    );
    if (resultA.success) {
      legAClosed = await verifyPositionClosed(exchange, position.leg_a_symbol);
      exitPriceA = resultA.avgPrice ?? 0;
    }

    // Close Leg B
    const oppositeSideB = position.leg_b_side === 'buy' ? 'sell' : 'buy';
    const resultB = await exchange.closePosition(
      position.leg_b_symbol,
      oppositeSideB as 'buy' | 'sell',
      position.leg_b_size
    );
    if (resultB.success) {
      legBClosed = await verifyPositionClosed(exchange, position.leg_b_symbol);
      exitPriceB = resultB.avgPrice ?? 0;
    }

    // Calculate P&L from entry/exit prices, accounting for contract size (ctVal)
    // OKX contracts: ETH-USDT-SWAP = 0.1 ETH/ct, BTC = 0.01 BTC/ct, etc.
    const entryA = position.leg_a_entry_price ?? 0;
    const entryB = position.leg_b_entry_price ?? 0;
    const sizeA = position.leg_a_size;
    const sizeB = position.leg_b_size;
    const ctValA = await exchange.getContractSize(position.leg_a_symbol);
    const ctValB = await exchange.getContractSize(position.leg_b_symbol);

    if (entryA > 0 && exitPriceA > 0) {
      // PnL = (exit - entry) * numContracts * ctVal * direction
      const multiplierA = position.leg_a_side === 'buy' ? 1 : -1;
      totalPnl += (exitPriceA - entryA) * sizeA * ctValA * multiplierA;
    }
    if (entryB > 0 && exitPriceB > 0) {
      const multiplierB = position.leg_b_side === 'buy' ? 1 : -1;
      totalPnl += (exitPriceB - entryB) * sizeB * ctValB * multiplierB;
    }

    // Deduct estimated fees (taker 0.06% per trade, 4 trades total: open + close for each leg)
    const notionalA = (exitPriceA > 0 ? exitPriceA : entryA) * sizeA * ctValA;
    const notionalB = (exitPriceB > 0 ? exitPriceB : entryB) * sizeB * ctValB;
    const feeRate = 0.0006;
    totalPnl -= (notionalA + notionalB) * feeRate * 2; // open + close

    log.info({
      positionId,
      entryA, exitPriceA, sizeA, ctValA, sideA: position.leg_a_side,
      entryB, exitPriceB, sizeB, ctValB, sideB: position.leg_b_side,
      totalPnl,
    }, 'P&L calculated');

    if (legAClosed && legBClosed) {
      queries.updatePositionState(positionId, 'CLOSED', {
        pnl: totalPnl,
        closed_at: new Date().toISOString(),
        close_reason: reason,
      });
      log.info({ positionId, reason, pnl: totalPnl }, 'Position closed successfully');
      return { success: true, positionId };
    } else {
      const error = `Close incomplete: legA=${legAClosed}, legB=${legBClosed}`;
      queries.updatePositionState(positionId, 'ERROR', {
        metadata: JSON.stringify({ error, legAClosed, legBClosed }),
      });
      log.error({ positionId, legAClosed, legBClosed }, error);
      return { success: false, positionId, error };
    }
  } catch (err) {
    log.error({ positionId, error: err }, 'Error closing pair position');
    queries.updatePositionState(positionId, 'ERROR', {
      metadata: JSON.stringify({ error: String(err) }),
    });
    return { success: false, positionId, error: String(err) };
  }
}
