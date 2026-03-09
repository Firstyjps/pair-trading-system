import { createChildLogger } from '../logger.js';

const log = createChildLogger('rollback');

export interface ExchangeAdapter {
  closePosition(symbol: string, side: 'buy' | 'sell', size: number): Promise<{ success: boolean; orderId?: string; avgPrice?: number; error?: string }>;
  getPosition(symbol: string): Promise<{ size: number; side: string } | null>;
}

export async function rollbackLegA(
  exchange: ExchangeAdapter,
  symbol: string,
  side: 'buy' | 'sell',
  size: number,
  maxRetries: number = 3
): Promise<{ success: boolean; error?: string }> {
  const oppositeSide = side === 'buy' ? 'sell' : 'buy';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log.warn({ symbol, side: oppositeSide, size, attempt }, 'Rolling back Leg A');

    try {
      const result = await exchange.closePosition(symbol, oppositeSide, size);

      if (result.success) {
        // Verify the position is actually closed
        const verified = await verifyPositionClosed(exchange, symbol);
        if (verified) {
          log.info({ symbol, attempt }, 'Rollback successful and verified');
          return { success: true };
        }
        log.warn({ symbol, attempt }, 'Rollback order succeeded but position still exists');
      } else {
        log.error({ symbol, attempt, error: result.error }, 'Rollback order failed');
      }
    } catch (err) {
      log.error({ symbol, attempt, error: err }, 'Rollback threw exception');
    }

    // Wait before retry with exponential backoff
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  log.error({ symbol, maxRetries }, 'CRITICAL: Rollback failed after all retries — ORPHAN POSITION');
  return { success: false, error: `Rollback failed after ${maxRetries} attempts` };
}

export async function verifyPositionClosed(
  exchange: ExchangeAdapter,
  symbol: string,
  maxRetries: number = 3
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const position = await exchange.getPosition(symbol);
      if (!position || position.size === 0) {
        return true;
      }
      log.warn({ symbol, position, attempt }, 'Position still exists after close');
    } catch (err) {
      log.error({ symbol, attempt, error: err }, 'Error verifying position closed');
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return false;
}
