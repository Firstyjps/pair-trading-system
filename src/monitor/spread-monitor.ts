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
  action: 'HOLD' | 'EXIT_TP' | 'EXIT_SL';
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

      if (shouldTriggerTakeProfit(zScore, config.exitZScore)) {
        action = 'EXIT_TP';
        log.info({ pair: pos.pair, zScore, exitZ: config.exitZScore }, 'Take profit triggered');
      } else if (shouldTriggerStopLoss(pos.opened_at, zScore, config.stopLossZScore, config.gracePeriodMs)) {
        action = 'EXIT_SL';
        log.warn({ pair: pos.pair, zScore, slZ: config.stopLossZScore }, 'Stop loss triggered');
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
