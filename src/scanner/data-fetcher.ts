import type { TradingQueries } from '../db/queries.js';
import type { OHLCVCandle } from '../types.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('data-fetcher');

export interface MarketInfo {
  id: string;       // e.g. "BTC-USDT-SWAP"
  symbol: string;   // e.g. "BTC/USDT:USDT"
  base: string;
  quote: string;
  active: boolean;
  contractSize: number;
  minSize: number;
}

export interface DataFetcherExchange {
  fetchMarkets(): Promise<MarketInfo[]>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<number[][]>;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class DataFetcher {
  private marketsCache: MarketInfo[] | null = null;
  private marketsCacheTime = 0;

  constructor(
    private exchange: DataFetcherExchange,
    private queries: TradingQueries,
  ) {}

  async getSwapMarkets(): Promise<MarketInfo[]> {
    if (this.marketsCache && Date.now() - this.marketsCacheTime < CACHE_TTL_MS) {
      return this.marketsCache;
    }

    log.info('Fetching markets from exchange');
    const allMarkets = await this.exchange.fetchMarkets();
    this.marketsCache = allMarkets.filter(m =>
      m.active && m.id.endsWith('-USDT-SWAP')
    );
    this.marketsCacheTime = Date.now();
    log.info({ count: this.marketsCache.length }, 'USDT-SWAP markets loaded');
    return this.marketsCache;
  }

  async fetchOHLCV(
    symbol: string,
    timeframe: string = '1h',
    lookbackBars: number = 168,
  ): Promise<OHLCVCandle[]> {
    const timeframeMs: Record<string, number> = {
      '1h': 3600000,
      '4h': 14400000,
    };
    const tfMs = timeframeMs[timeframe] ?? 3600000;
    const since = Date.now() - lookbackBars * tfMs;

    // Check DB cache first
    const cached = this.queries.getOHLCV(symbol, timeframe, since);
    const expectedBars = lookbackBars * 0.9; // Allow 10% gap

    if (cached.length >= expectedBars) {
      log.debug({ symbol, timeframe, cachedBars: cached.length }, 'Using cached OHLCV');
      return cached;
    }

    // Fetch from exchange with pagination
    log.info({ symbol, timeframe, lookbackBars }, 'Fetching OHLCV from exchange');
    const allCandles: OHLCVCandle[] = [];
    let fetchSince = since;
    const maxPerRequest = 100;

    for (let i = 0; i < Math.ceil(lookbackBars / maxPerRequest); i++) {
      try {
        const raw = await this.exchange.fetchOHLCV(symbol, timeframe, fetchSince, maxPerRequest);
        if (!raw || raw.length === 0) break;

        const candles: OHLCVCandle[] = raw.map(c => ({
          timestamp: c[0],
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5],
        }));

        allCandles.push(...candles);
        fetchSince = candles[candles.length - 1].timestamp + 1;

        if (allCandles.length >= lookbackBars) break;

        // Rate limit pause
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        log.error({ symbol, timeframe, attempt: i, error: err }, 'Error fetching OHLCV batch');
        // Retry with backoff
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }

    // Cache to DB
    if (allCandles.length > 0) {
      this.queries.upsertOHLCV(symbol, timeframe, allCandles);
    }

    log.info({ symbol, timeframe, bars: allCandles.length }, 'OHLCV fetched and cached');
    return allCandles;
  }

  async fetchMultipleOHLCV(
    symbols: string[],
    timeframe: string = '1h',
    lookbackBars: number = 168,
  ): Promise<Map<string, OHLCVCandle[]>> {
    const result = new Map<string, OHLCVCandle[]>();

    // Fetch sequentially to respect rate limits
    for (const symbol of symbols) {
      try {
        const candles = await this.fetchOHLCV(symbol, timeframe, lookbackBars);
        result.set(symbol, candles);
      } catch (err) {
        log.error({ symbol, error: err }, 'Failed to fetch OHLCV, skipping');
      }
    }

    return result;
  }

  clearMarketCache(): void {
    this.marketsCache = null;
    this.marketsCacheTime = 0;
  }
}
