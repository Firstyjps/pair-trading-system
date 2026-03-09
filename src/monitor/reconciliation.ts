import type { TradingQueries } from '../db/queries.js';
import type { PairPosition } from '../types.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('reconciliation');

export interface ExchangePosition {
  symbol: string;
  side: string;
  size: number;
  avgPrice: number;
  unrealizedPnl: number;
}

export interface ReconciliationExchange {
  fetchPositions(): Promise<ExchangePosition[]>;
}

export interface Discrepancy {
  type: 'DB_ONLY' | 'EXCHANGE_ONLY' | 'SIZE_MISMATCH';
  pair?: string;
  symbol: string;
  dbState?: string;
  dbSize?: number;
  exchangeSize?: number;
  action: string;
}

/**
 * Reconcile DB positions with exchange positions
 * RULE: Auto-fix DB if exchange says no position
 * RULE: NEVER auto-close on exchange based on DB mismatch
 */
export async function reconcile(
  queries: TradingQueries,
  exchange: ReconciliationExchange,
): Promise<Discrepancy[]> {
  const discrepancies: Discrepancy[] = [];

  // Fetch both sources
  const dbPositions = queries.getOpenPositions();
  const exchangePositions = await exchange.fetchPositions();

  // Build exchange position map by symbol
  const exchangeMap = new Map<string, ExchangePosition>();
  for (const pos of exchangePositions) {
    exchangeMap.set(pos.symbol, pos);
  }

  // Check each DB position against exchange
  for (const dbPos of dbPositions) {
    if (dbPos.state === 'PENDING') continue; // Skip pending

    // Check Leg A
    if (dbPos.leg_a_order_id) {
      const exchA = exchangeMap.get(dbPos.leg_a_symbol);
      if (!exchA || exchA.size === 0) {
        discrepancies.push({
          type: 'DB_ONLY',
          pair: dbPos.pair,
          symbol: dbPos.leg_a_symbol,
          dbState: dbPos.state,
          dbSize: dbPos.leg_a_size,
          exchangeSize: 0,
          action: 'Will mark as CLOSED in DB (exchange has no position)',
        });
      }
    }

    // Check Leg B
    if (dbPos.leg_b_order_id) {
      const exchB = exchangeMap.get(dbPos.leg_b_symbol);
      if (!exchB || exchB.size === 0) {
        discrepancies.push({
          type: 'DB_ONLY',
          pair: dbPos.pair,
          symbol: dbPos.leg_b_symbol,
          dbState: dbPos.state,
          dbSize: dbPos.leg_b_size,
          exchangeSize: 0,
          action: 'Will mark as CLOSED in DB (exchange has no position)',
        });
      }
    }

    // If both legs are gone from exchange but DB says BOTH_LEGS_OPEN → close in DB
    const exchA = exchangeMap.get(dbPos.leg_a_symbol);
    const exchB = exchangeMap.get(dbPos.leg_b_symbol);
    const legAGone = !exchA || exchA.size === 0;
    const legBGone = !exchB || exchB.size === 0;

    if (legAGone && legBGone && dbPos.state === 'BOTH_LEGS_OPEN') {
      log.warn({ id: dbPos.id, pair: dbPos.pair }, 'Both legs missing from exchange — marking CLOSED in DB');
      queries.updatePositionState(dbPos.id, 'CLOSED', {
        closed_at: new Date().toISOString(),
        close_reason: 'ORPHAN',
        metadata: JSON.stringify({ reconciliation: 'both legs missing from exchange' }),
      });
    }

    // Mark used exchange positions
    if (exchA) exchangeMap.delete(dbPos.leg_a_symbol);
    if (exchB) exchangeMap.delete(dbPos.leg_b_symbol);
  }

  // Remaining exchange positions = orphans (no DB record)
  for (const [symbol, pos] of exchangeMap) {
    if (pos.size > 0) {
      discrepancies.push({
        type: 'EXCHANGE_ONLY',
        symbol,
        exchangeSize: pos.size,
        action: 'ALERT ONLY — orphan position on exchange (no DB record)',
      });
    }
  }

  if (discrepancies.length > 0) {
    log.warn({ count: discrepancies.length, discrepancies }, 'Reconciliation found discrepancies');
  } else {
    log.debug('Reconciliation clean — no discrepancies');
  }

  return discrepancies;
}
