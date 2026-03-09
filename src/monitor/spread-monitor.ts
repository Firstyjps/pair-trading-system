import type { TradingQueries } from '../db/queries.js';
import type { PairPosition } from '../types.js';
import { calculateZScore } from '../scanner/signal-generator.js';
import { shouldTriggerStopLoss, shouldTriggerTakeProfit } from '../trader/validators.js';
import { getTradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('spread-monitor');

export interface SpreadMonitorExchange {
  fetchTicker(symbol: string): Promise<{ last: number }>;
}

export interface SpreadUpdate {
  positionId: string;
  pair: string;
  currentZ: number;
  spread: number;
  action: 'HOLD' | 'EXIT_TP' | 'EXIT_SL' | 'EXIT_TRAILING';
}

/**
 * Monitor Z-Score of all active pairs and trigger exits
 */
export async function checkSpreads(
  queries: TradingQueries,
  exchange: SpreadMonitorExchange,
  getBeta: (pair: string) => number,
  getHistoricalPrices: (symbol: string) => number[],
): Promise<SpreadUpdate[]> {
  const config = getTradingConfig();
  const openPositions = queries.getOpenPositions();
  const updates: SpreadUpdate[] = [];

  for (const pos of openPositions) {
    if (pos.state !== 'BOTH_LEGS_OPEN') continue;

    try {
      // Fetch current prices
      const [tickerA, tickerB] = await Promise.all([
        exchange.fetchTicker(pos.leg_a_symbol),
        exchange.fetchTicker(pos.leg_b_symbol),
      ]);

      // Get historical prices for Z-Score calculation
      const pricesA = [...getHistoricalPrices(pos.leg_a_symbol), tickerA.last];
      const pricesB = [...getHistoricalPrices(pos.leg_b_symbol), tickerB.last];

      const beta = getBeta(pos.pair);
      const { zScore, spread } = calculateZScore(pricesA, pricesB, beta);

      // Update current Z-Score in DB
      queries.updatePositionState(pos.id, pos.state, { current_z_score: zScore });

      // Log to z_score_history
      queries.insertZScoreRecord({
        pair: pos.pair,
        z_score: zScore,
        spread,
        price_a: tickerA.last,
        price_b: tickerB.last,
        timestamp: new Date().toISOString(),
      });

      // Determine action
      let action: SpreadUpdate['action'] = 'HOLD';
      let metadata = pos.metadata;

      // Minimum hold time: convert bars to ms (1 bar = 1h or 4h based on timeframe)
      const minHoldBars = config.minHoldBarsTP ?? 3;
      const barMs = config.primaryTimeframe === '4h' ? 4 * 3600_000 : 3600_000;
      const minHoldMs = minHoldBars * barMs;
      const positionAge = Date.now() - new Date(pos.opened_at).getTime();

      if (shouldTriggerTakeProfit(zScore, config.exitZScore)) {
        if (positionAge >= minHoldMs) {
          action = 'EXIT_TP';
          log.info({ pair: pos.pair, zScore, exitZ: config.exitZScore }, 'Take profit triggered');
        } else {
          log.info({
            pair: pos.pair, zScore,
            holdMin: Math.floor(positionAge / 60000),
            requiredMin: Math.floor(minHoldMs / 60000),
          }, 'TP conditions met but minimum hold time not reached — holding');
        }
      } else if (shouldTriggerStopLoss(pos.opened_at, zScore, config.stopLossZScore, config.gracePeriodMs)) {
        action = 'EXIT_SL';
        log.warn({ pair: pos.pair, zScore, slZ: config.stopLossZScore }, 'Stop loss triggered');
      } else if (config.trailingStopEnabled && config.trailingStopZ > 0) {
        const absZ = Math.abs(zScore);
        let bestZ = absZ;
        try {
          const meta = pos.metadata ? JSON.parse(pos.metadata) : {};
          bestZ = Math.min(meta.trailingBestZ ?? absZ, absZ);
        } catch { /* use absZ */ }
        if (absZ >= bestZ + config.trailingStopZ) {
          action = 'EXIT_TRAILING';
          log.info({ pair: pos.pair, zScore, bestZ, trailZ: config.trailingStopZ }, 'Trailing stop triggered');
        }
        const meta = pos.metadata ? JSON.parse(pos.metadata) : {};
        metadata = JSON.stringify({ ...meta, trailingBestZ: bestZ });
      }

      if (metadata && action === 'HOLD') {
        queries.updatePositionState(pos.id, pos.state, { metadata });
      }

      updates.push({
        positionId: pos.id,
        pair: pos.pair,
        currentZ: zScore,
        spread,
        action,
      });
    } catch (err) {
      log.error({ pair: pos.pair, error: err }, 'Error monitoring spread');
    }
  }

  return updates;
}
