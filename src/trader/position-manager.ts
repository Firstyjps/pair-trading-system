import type { TradingQueries } from '../db/queries.js';
import type { PairPosition } from '../types.js';
import { createChildLogger } from '../logger.js';
import { getTradingConfig } from '../config.js';

const log = createChildLogger('position-manager');

export class PositionManager {
  constructor(private queries: TradingQueries) {}

  /**
   * Restore state from DB on boot — RULE 1: DB-First
   * Returns all positions that need monitoring
   */
  restoreOnBoot(): PairPosition[] {
    const openPositions = this.queries.getOpenPositions();
    log.info({ count: openPositions.length }, 'Restored open positions from DB on boot');

    for (const pos of openPositions) {
      log.info({
        id: pos.id,
        pair: pos.pair,
        state: pos.state,
        entryZ: pos.entry_z_score,
      }, 'Restored position');
    }

    return openPositions;
  }

  getActivePositions(): PairPosition[] {
    return this.queries.getOpenPositions();
  }

  getPosition(id: string): PairPosition | undefined {
    return this.queries.getPosition(id);
  }

  /**
   * 5-layer dedup check — RULE 3
   */
  async canOpenPair(
    pair: string,
    groupId: string,
    exchangeHasOpenPosition: (pair: string) => Promise<boolean>,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const config = getTradingConfig();

    // Layer 1: DB check (authoritative after restart)
    if (this.queries.hasOpenPosition(pair)) {
      return { allowed: false, reason: 'DB: open position exists' };
    }

    // Layer 2: Exchange check (source of truth)
    try {
      if (await exchangeHasOpenPosition(pair)) {
        return { allowed: false, reason: 'Exchange: open position exists' };
      }
    } catch (err) {
      log.warn({ pair, error: err }, 'Exchange check failed — blocking for safety');
      return { allowed: false, reason: 'Exchange check failed' };
    }

    // Layer 3: Cooldown check (prevent rapid re-entry after close)
    const lastClosed = this.queries.getLastClosedTime(pair);
    if (lastClosed && Date.now() - lastClosed < config.cooldownMs) {
      const remaining = config.cooldownMs - (Date.now() - lastClosed);
      return { allowed: false, reason: `Cooldown: ${Math.round(remaining / 1000)}s remaining` };
    }

    // Layer 4: Group ID check (prevent re-opening same signal batch)
    if (this.queries.isGroupIdUsed(groupId)) {
      return { allowed: false, reason: 'Group ID already used' };
    }

    // Layer 5: Position limit check
    const openCount = this.queries.getOpenPositionCount();
    if (openCount >= config.maxOpenPairs) {
      return { allowed: false, reason: `Max open pairs reached: ${openCount}/${config.maxOpenPairs}` };
    }

    return { allowed: true };
  }

  getPnlSummary() {
    return this.queries.getRealizedPnl();
  }
}
