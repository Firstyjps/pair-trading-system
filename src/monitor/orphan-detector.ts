import type { TradingQueries } from '../db/queries.js';
import type { ExchangePosition, ReconciliationExchange } from './reconciliation.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('orphan-detector');

export interface OrphanPosition {
  symbol: string;
  side: string;
  size: number;
  avgPrice: number;
  unrealizedPnl: number;
  reason: string;
}

/**
 * Find positions on exchange that have no matching DB record
 * RULE 8: ALERT ONLY — never auto-close
 */
export async function detectOrphans(
  queries: TradingQueries,
  exchange: ReconciliationExchange,
): Promise<OrphanPosition[]> {
  const orphans: OrphanPosition[] = [];

  const exchangePositions = await exchange.fetchPositions();
  const dbPositions = queries.getOpenPositions();

  // Build set of symbols tracked in DB
  const trackedSymbols = new Set<string>();
  for (const pos of dbPositions) {
    trackedSymbols.add(pos.leg_a_symbol);
    trackedSymbols.add(pos.leg_b_symbol);
  }

  // Also check recently closed — anti-re-adopt (RULE 10)
  const recentlyClosed = queries.getRecentlyClosedPairs(600000); // 10 minutes
  const recentlyClosedSymbols = new Set<string>();
  const closedPositions = queries.getClosedPositions(50);
  for (const pos of closedPositions) {
    const closedAt = pos.closed_at ? new Date(pos.closed_at).getTime() : 0;
    if (Date.now() - closedAt < 600000) {
      recentlyClosedSymbols.add(pos.leg_a_symbol);
      recentlyClosedSymbols.add(pos.leg_b_symbol);
    }
  }

  for (const exchPos of exchangePositions) {
    if (exchPos.size === 0) continue;

    if (!trackedSymbols.has(exchPos.symbol)) {
      // Check if this was recently closed — skip if so
      if (recentlyClosedSymbols.has(exchPos.symbol)) {
        log.debug({ symbol: exchPos.symbol }, 'Recently closed position found on exchange — skipping (anti-re-adopt)');
        continue;
      }

      orphans.push({
        symbol: exchPos.symbol,
        side: exchPos.side,
        size: exchPos.size,
        avgPrice: exchPos.avgPrice,
        unrealizedPnl: exchPos.unrealizedPnl,
        reason: 'No matching DB record',
      });
    }
  }

  if (orphans.length > 0) {
    log.warn({ count: orphans.length, orphans }, 'ORPHAN POSITIONS DETECTED — ALERT ONLY, NO AUTO-CLOSE');
  }

  return orphans;
}
