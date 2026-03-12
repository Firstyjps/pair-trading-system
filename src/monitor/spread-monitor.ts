import type { TradingQueries } from '../db/queries.js';
import type { PairPosition } from '../types.js';
import { calculateZScore } from '../scanner/signal-generator.js';
import { shouldTriggerStopLoss, shouldTriggerTakeProfit } from '../trader/validators.js';
import { getTradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('spread-monitor');

export interface SpreadMonitorExchange {
  fetchTicker(symbol: string): Promise<{ last: number }>;
  getContractSize(symbol: string): Promise<number>;
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

      // Track how long Z has been in TP zone (consecutive minutes)
      const meta = pos.metadata ? JSON.parse(pos.metadata) : {};
      const tpZoneTimeout = 3; // bars (hours) in TP zone before allowing loss exit
      const maxHoldBars = 24;  // absolute max hold time in bars (hours)
      const holdBars = positionAge / barMs;

      if (shouldTriggerTakeProfit(zScore, config.exitZScore)) {
        // Count consecutive bars in TP zone
        const barsInTPZone = (meta.barsInTPZone ?? 0) + 1;
        metadata = JSON.stringify({ ...meta, barsInTPZone });

        if (positionAge >= minHoldMs) {
          // Estimate PnL before closing
          const entryA = pos.leg_a_entry_price ?? 0;
          const entryB = pos.leg_b_entry_price ?? 0;
          if (entryA > 0 && entryB > 0) {
            const ctValA = await exchange.getContractSize(pos.leg_a_symbol);
            const ctValB = await exchange.getContractSize(pos.leg_b_symbol);
            const mulA = pos.leg_a_side === 'buy' ? 1 : -1;
            const mulB = pos.leg_b_side === 'buy' ? 1 : -1;
            const pnlA = (tickerA.last - entryA) * pos.leg_a_size * ctValA * mulA;
            const pnlB = (tickerB.last - entryB) * pos.leg_b_size * ctValB * mulB;
            const grossPnl = pnlA + pnlB;
            const notionalA = tickerA.last * pos.leg_a_size * ctValA;
            const notionalB = tickerB.last * pos.leg_b_size * ctValB;
            const estFees = (notionalA + notionalB) * (config.takerFeeRate ?? config.feeRate ?? 0.0006) * 2;
            const netPnl = grossPnl - estFees;

            if (netPnl > 0) {
              action = 'EXIT_TP';
              log.info({ pair: pos.pair, zScore, netPnl: netPnl.toFixed(4), exitZ: config.exitZScore }, 'Take profit triggered (profitable after fees)');
            } else if (barsInTPZone >= tpZoneTimeout * 60) {
              // Z in TP zone for 3+ hours — exit even at loss
              action = 'EXIT_TP';
              log.info({ pair: pos.pair, zScore, netPnl: netPnl.toFixed(4), barsInTPZone, tpZoneTimeout }, 'TP zone timeout — exiting at loss');
            } else {
              log.info({
                pair: pos.pair, zScore, grossPnl: grossPnl.toFixed(4), estFees: estFees.toFixed(4), netPnl: netPnl.toFixed(4),
                barsInTPZone, tpZoneTimeoutMin: tpZoneTimeout * 60,
              }, 'TP conditions met but PnL negative — waiting for TP zone timeout');
            }
          } else {
            action = 'EXIT_TP';
            log.info({ pair: pos.pair, zScore, exitZ: config.exitZScore }, 'Take profit triggered (no entry price to estimate)');
          }
        } else {
          log.info({
            pair: pos.pair, zScore,
            holdMin: Math.floor(positionAge / 60000),
            requiredMin: Math.floor(minHoldMs / 60000),
          }, 'TP conditions met but minimum hold time not reached — holding');
        }
      } else {
        // Z left TP zone — reset counter
        if (meta.barsInTPZone) {
          metadata = JSON.stringify({ ...meta, barsInTPZone: 0 });
        }

        if (holdBars >= maxHoldBars) {
          // Max hold time exceeded — force exit
          action = 'EXIT_TP';
          log.warn({ pair: pos.pair, zScore, holdBars: holdBars.toFixed(1), maxHoldBars }, 'Max hold time exceeded — force exit');
        } else if (shouldTriggerStopLoss(pos.opened_at, zScore, config.stopLossZScore, config.gracePeriodMs)) {
          action = 'EXIT_SL';
          log.warn({ pair: pos.pair, zScore, slZ: config.stopLossZScore }, 'Stop loss triggered');
        } else if (config.trailingStopEnabled && config.trailingStopZ > 0) {
          const absZ = Math.abs(zScore);
          const entryAbsZ = Math.abs(pos.entry_z_score);
          let bestZ: number;
          try {
            bestZ = Math.min(meta.trailingBestZ ?? entryAbsZ, absZ);
          } catch { bestZ = Math.min(entryAbsZ, absZ); }
          if (absZ >= bestZ + config.trailingStopZ) {
            action = 'EXIT_TRAILING';
            log.info({ pair: pos.pair, zScore, bestZ, trailZ: config.trailingStopZ }, 'Trailing stop triggered');
          }
          metadata = JSON.stringify({ ...meta, trailingBestZ: bestZ });
        }
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
