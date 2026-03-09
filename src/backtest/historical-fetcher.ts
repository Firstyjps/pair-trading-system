/**
 * Historical Data Fetcher
 *
 * Fetches years of OHLCV data from OKX by paginating the API,
 * caches results in SQLite to avoid re-fetching.
 *
 * OKX API limits:
 *   - Live candles:    /api/v5/market/candles         → max 300 per request
 *   - History candles: /api/v5/market/history-candles  → max 100 per request
 *   - ccxt fetchOHLCV: paginates automatically if configured
 *   - Rate limit: ~20 requests per 2 seconds
 *
 * 3 years of data:
 *   - 1h candles: ~26,280 bars → ~88 requests (at 300/req)
 *   - 4h candles: ~6,570 bars  → ~22 requests
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { OHLCVCandle } from '../types.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('historical-fetcher');

// ─── Types ───

export interface FetchProgress {
  symbol: string;
  timeframe: string;
  totalCandles: number;
  expectedCandles: number;
  percentComplete: number;
  currentDate: string;
  elapsed: number;
}

export type ProgressCallback = (progress: FetchProgress) => void;

export interface HistoricalFetchConfig {
  /** How many years back to fetch */
  years: number;
  /** Candle timeframe */
  timeframe: '1h' | '4h' | '1d';
  /** Max candles per request (OKX: 300 for live, 100 for history) */
  batchSize: number;
  /** Delay between requests in ms (rate limiting) */
  delayMs: number;
  /** SQLite database path for cache */
  dbPath: string;
}

const DEFAULT_CONFIG: HistoricalFetchConfig = {
  years: 3,
  timeframe: '1h',
  batchSize: 300,
  delayMs: 200,
  dbPath: './data/backtest-cache.db',
};

// ─── Timeframe Helpers ───

const TIMEFRAME_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function yearsToMs(years: number): number {
  return years * 365.25 * 24 * 60 * 60 * 1000;
}

function expectedCandles(years: number, timeframe: string): number {
  const ms = yearsToMs(years);
  const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS['1h'];
  return Math.ceil(ms / tfMs);
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// ─── Cache Database ───

function initCacheDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ohlcv_history (
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (symbol, timeframe, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_ohlcv_history_lookup
      ON ohlcv_history(symbol, timeframe, timestamp);

    CREATE TABLE IF NOT EXISTS fetch_metadata (
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      oldest_timestamp INTEGER,
      newest_timestamp INTEGER,
      total_candles INTEGER,
      last_fetch TEXT NOT NULL,
      PRIMARY KEY (symbol, timeframe)
    );
  `);

  return db;
}

// ─── Cache Operations ───

function getCachedCandles(
  db: Database.Database,
  symbol: string,
  timeframe: string,
  sinceMs?: number,
): OHLCVCandle[] {
  let sql = 'SELECT timestamp, open, high, low, close, volume FROM ohlcv_history WHERE symbol = ? AND timeframe = ?';
  const params: (string | number)[] = [symbol, timeframe];

  if (sinceMs) {
    sql += ' AND timestamp >= ?';
    params.push(sinceMs);
  }

  sql += ' ORDER BY timestamp ASC';

  return db.prepare(sql).all(...params) as OHLCVCandle[];
}

function saveCandlesToCache(
  db: Database.Database,
  symbol: string,
  timeframe: string,
  candles: OHLCVCandle[],
): void {
  if (candles.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO ohlcv_history (symbol, timeframe, timestamp, open, high, low, close, volume, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const insert = db.transaction((data: OHLCVCandle[]) => {
    for (const c of data) {
      stmt.run(symbol, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume, now);
    }
  });

  insert(candles);
}

function updateFetchMetadata(
  db: Database.Database,
  symbol: string,
  timeframe: string,
): void {
  const row = db.prepare(`
    SELECT
      MIN(timestamp) as oldest,
      MAX(timestamp) as newest,
      COUNT(*) as total
    FROM ohlcv_history
    WHERE symbol = ? AND timeframe = ?
  `).get(symbol, timeframe) as { oldest: number; newest: number; total: number } | undefined;

  if (row) {
    db.prepare(`
      INSERT OR REPLACE INTO fetch_metadata (symbol, timeframe, oldest_timestamp, newest_timestamp, total_candles, last_fetch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(symbol, timeframe, row.oldest, row.newest, row.total, new Date().toISOString());
  }
}

function getFetchMetadata(
  db: Database.Database,
  symbol: string,
  timeframe: string,
): { oldest: number; newest: number; total: number } | null {
  const row = db.prepare(`
    SELECT oldest_timestamp as oldest, newest_timestamp as newest, total_candles as total
    FROM fetch_metadata WHERE symbol = ? AND timeframe = ?
  `).get(symbol, timeframe) as { oldest: number; newest: number; total: number } | undefined;

  return row ?? null;
}

// ─── Main Fetcher ───

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch historical OHLCV data with pagination and caching.
 * Returns close prices array.
 */
export async function fetchHistoricalData(
  symbol: string,
  config: Partial<HistoricalFetchConfig> = {},
  onProgress?: ProgressCallback,
): Promise<number[]> {
  const cfg: HistoricalFetchConfig = { ...DEFAULT_CONFIG, ...config };
  const db = initCacheDb(cfg.dbPath);

  try {
    const candles = await fetchHistoricalCandles(db, symbol, cfg, onProgress);
    return candles.map(c => c.close);
  } finally {
    db.close();
  }
}

/**
 * Fetch full OHLCV candle objects with caching
 */
export async function fetchHistoricalCandles(
  db: Database.Database,
  symbol: string,
  config: HistoricalFetchConfig,
  onProgress?: ProgressCallback,
): Promise<OHLCVCandle[]> {
  const now = Date.now();
  const sinceMs = now - yearsToMs(config.years);
  const expected = expectedCandles(config.years, config.timeframe);
  const tfMs = TIMEFRAME_MS[config.timeframe] ?? TIMEFRAME_MS['1h'];

  // Check cache first — allow 1 timeframe period tolerance for boundary alignment
  const meta = getFetchMetadata(db, symbol, config.timeframe);
  const tolerance = tfMs * 2; // 2 bar tolerance for rounding
  if (meta && meta.oldest <= sinceMs + tolerance && meta.total >= expected * 0.9) {
    log.info({
      symbol, timeframe: config.timeframe,
      cached: meta.total, expected,
      oldest: formatDate(meta.oldest),
    }, 'Using cached data');

    const cached = getCachedCandles(db, symbol, config.timeframe, sinceMs);
    if (cached.length >= expected * 0.9) {
      onProgress?.({
        symbol, timeframe: config.timeframe,
        totalCandles: cached.length, expectedCandles: expected,
        percentComplete: 100, currentDate: formatDate(cached[cached.length - 1]?.timestamp ?? now),
        elapsed: 0,
      });
      return cached;
    }
  }

  // Need to fetch from exchange
  log.info({
    symbol, timeframe: config.timeframe,
    years: config.years, expected,
    since: formatDate(sinceMs),
  }, 'Fetching historical data from exchange');

  const ccxt = await import('ccxt');
  const exchange = new ccxt.okx({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_SECRET,
    password: process.env.OKX_PASSPHRASE,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  });

  if (process.env.OKX_SANDBOX === 'true') {
    exchange.setSandboxMode(true);
  }

  await exchange.loadMarkets();

  const ccxtSymbol = `${symbol}/USDT:USDT`;

  // Check if symbol exists
  if (!exchange.markets[ccxtSymbol]) {
    throw new Error(`Symbol ${ccxtSymbol} not found on OKX`);
  }

  // Fetch in forward-moving chunks
  let cursor = sinceMs;
  let totalFetched = 0;
  let batchCount = 0;
  const startTime = Date.now();
  const allCandles: OHLCVCandle[] = [];

  // Also load any existing cache to find gaps
  const existingCached = getCachedCandles(db, symbol, config.timeframe, sinceMs);
  const cachedTimestamps = new Set(existingCached.map(c => c.timestamp));

  log.info({
    symbol, cachedCandles: existingCached.length,
    startDate: formatDate(sinceMs),
  }, 'Starting paginated fetch');

  while (cursor < now) {
    try {
      const rawCandles = await exchange.fetchOHLCV(
        ccxtSymbol,
        config.timeframe,
        cursor,
        config.batchSize,
      );

      if (!rawCandles || rawCandles.length === 0) {
        // No more data available — try jumping forward
        cursor += tfMs * config.batchSize;
        batchCount++;
        if (batchCount > 2000) break; // Safety limit
        continue;
      }

      // Convert to OHLCVCandle format
      const candles: OHLCVCandle[] = rawCandles.map((c: number[]) => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));

      // Filter out already-cached
      const newCandles = candles.filter(c => !cachedTimestamps.has(c.timestamp));

      if (newCandles.length > 0) {
        saveCandlesToCache(db, symbol, config.timeframe, newCandles);
        newCandles.forEach(c => cachedTimestamps.add(c.timestamp));
      }

      allCandles.push(...candles);
      totalFetched += candles.length;
      batchCount++;

      // Move cursor to after last candle
      const lastTimestamp = rawCandles[rawCandles.length - 1][0];
      cursor = lastTimestamp + tfMs;

      // Progress callback
      const elapsed = (Date.now() - startTime) / 1000;
      const pct = Math.min(100, (totalFetched / expected) * 100);

      onProgress?.({
        symbol,
        timeframe: config.timeframe,
        totalCandles: totalFetched,
        expectedCandles: expected,
        percentComplete: pct,
        currentDate: formatDate(lastTimestamp),
        elapsed,
      });

      // Rate limiting
      await sleep(config.delayMs);

      // If we got fewer than expected, we might have reached the end of history
      if (rawCandles.length < config.batchSize * 0.5) {
        // Possibly end of history for older dates, try jumping ahead
        if (lastTimestamp < now - tfMs * 10) {
          cursor = lastTimestamp + tfMs;
        } else {
          break; // We're near current time
        }
      }

    } catch (err: any) {
      if (err.message?.includes('rate') || err.message?.includes('Too Many')) {
        log.warn({ symbol, batch: batchCount }, 'Rate limited — waiting 5s');
        await sleep(5000);
        continue;
      }

      log.warn({ symbol, batch: batchCount, error: err.message }, 'Fetch error — skipping batch');
      cursor += tfMs * config.batchSize;
      batchCount++;

      if (batchCount > 2000) break;
    }
  }

  // Update metadata
  updateFetchMetadata(db, symbol, config.timeframe);

  // Return complete data from cache (includes pre-existing + newly fetched)
  const finalCandles = getCachedCandles(db, symbol, config.timeframe, sinceMs);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info({
    symbol, timeframe: config.timeframe,
    batchesFetched: batchCount,
    newCandles: totalFetched,
    totalCached: finalCandles.length,
    elapsed: `${elapsed}s`,
    dateRange: `${formatDate(finalCandles[0]?.timestamp ?? sinceMs)} → ${formatDate(finalCandles[finalCandles.length - 1]?.timestamp ?? now)}`,
  }, 'Historical data fetch complete');

  return finalCandles;
}

/**
 * Get cached data info without fetching
 */
export function getCacheInfo(
  symbol: string,
  timeframe: string,
  dbPath: string = DEFAULT_CONFIG.dbPath,
): { oldest: string; newest: string; total: number } | null {
  if (!fs.existsSync(dbPath)) return null;

  const db = initCacheDb(dbPath);
  try {
    const meta = getFetchMetadata(db, symbol, timeframe);
    if (!meta) return null;
    return {
      oldest: formatDate(meta.oldest),
      newest: formatDate(meta.newest),
      total: meta.total,
    };
  } finally {
    db.close();
  }
}

/**
 * Fetch multiple symbols concurrently (with rate limiting)
 */
export async function fetchMultipleSymbols(
  symbols: string[],
  config: Partial<HistoricalFetchConfig> = {},
  onProgress?: (symbol: string, progress: FetchProgress) => void,
): Promise<Map<string, number[]>> {
  const cfg: HistoricalFetchConfig = { ...DEFAULT_CONFIG, ...config };
  const db = initCacheDb(cfg.dbPath);
  const result = new Map<string, number[]>();

  try {
    for (const symbol of symbols) {
      console.log(`\n📡 Fetching ${symbol}...`);

      const candles = await fetchHistoricalCandles(db, symbol, cfg, (p) => {
        onProgress?.(symbol, p);
        // Print progress bar
        const bar = progressBar(p.percentComplete, 30);
        process.stdout.write(`\r  ${bar} ${p.percentComplete.toFixed(1)}% | ${p.totalCandles}/${p.expectedCandles} candles | ${p.currentDate} | ${p.elapsed.toFixed(0)}s`);
      });

      result.set(symbol, candles.map(c => c.close));
      console.log(`\n  ✅ ${symbol}: ${candles.length} candles (${formatDate(candles[0]?.timestamp ?? 0)} → ${formatDate(candles[candles.length - 1]?.timestamp ?? 0)})`);
    }
  } finally {
    db.close();
  }

  return result;
}

function progressBar(percent: number, width: number): string {
  const filled = Math.floor(percent / 100 * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * Clear cached data for a symbol
 */
export function clearCache(
  symbol?: string,
  timeframe?: string,
  dbPath: string = DEFAULT_CONFIG.dbPath,
): void {
  if (!fs.existsSync(dbPath)) return;

  const db = initCacheDb(dbPath);
  try {
    if (symbol && timeframe) {
      db.prepare('DELETE FROM ohlcv_history WHERE symbol = ? AND timeframe = ?').run(symbol, timeframe);
      db.prepare('DELETE FROM fetch_metadata WHERE symbol = ? AND timeframe = ?').run(symbol, timeframe);
    } else if (symbol) {
      db.prepare('DELETE FROM ohlcv_history WHERE symbol = ?').run(symbol);
      db.prepare('DELETE FROM fetch_metadata WHERE symbol = ?').run(symbol);
    } else {
      db.exec('DELETE FROM ohlcv_history');
      db.exec('DELETE FROM fetch_metadata');
    }
  } finally {
    db.close();
  }
}
