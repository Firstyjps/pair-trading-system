import { Router } from 'express';
import type { Request, Response } from 'express';
import type { TradingQueries } from '../../db/queries.js';
import type { OkxAdapter } from '../../exchange/okx-adapter.js';
import { getTradingConfig, updateTradingConfig, loadTradingConfig } from '../../config.js';
import { runBacktest, type BacktestConfig } from '../../backtest/engine.js';
import { runGridSearch, saveTopResults } from '../../backtest/optimizer.js';
import { formatReport, formatComparisonTable } from '../../backtest/report.js';
import { pearsonCorrelation, logReturns, getSector } from '../../scanner/correlation.js';
import { testCointegration, ols } from '../../scanner/cointegration.js';
import { calculateZScore } from '../../scanner/signal-generator.js';
import { createChildLogger } from '../../logger.js';
import type { OHLCVCandle } from '../../types.js';
import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';

const log = createChildLogger('api');

// ─── Rate Limiter (in-memory) ───

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_MAX_RELAXED = 200; // for /overview, /health

function getRateLimitKey(req: Request): string {
  return (req.ip ?? req.socket?.remoteAddress ?? 'unknown') as string;
}

function checkRateLimit(ip: string, max: number): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > max) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000).unref();

// ─── Input Validation Helpers ───

const PAIR_REGEX = /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/i;
const MAX_QUERY_LIMIT = 500;

function sanitizePairParam(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  return PAIR_REGEX.test(decoded) ? decoded : null;
}

function parseQueryLimit(raw: unknown, defaultVal: number = 50): number {
  const n = parseInt(raw as string);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, MAX_QUERY_LIMIT);
}

function parsePositiveFloat(raw: unknown, defaultVal: number): number {
  const n = parseFloat(raw as string);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return n;
}

function parsePositiveInt(raw: unknown, defaultVal: number): number {
  const n = parseInt(raw as string);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return n;
}

// Top USDT-SWAP symbols to scan (public data, no API key needed)
const SCAN_SYMBOLS = [
  'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'AVAX-USDT-SWAP',
  'NEAR-USDT-SWAP', 'SUI-USDT-SWAP', 'APT-USDT-SWAP', 'SEI-USDT-SWAP',
  'INJ-USDT-SWAP', 'ARB-USDT-SWAP', 'OP-USDT-SWAP', 'POL-USDT-SWAP',
  'DOGE-USDT-SWAP', 'SHIB-USDT-SWAP', 'PEPE-USDT-SWAP', 'BONK-USDT-SWAP',
  'WIF-USDT-SWAP', 'LINK-USDT-SWAP', 'AAVE-USDT-SWAP', 'UNI-USDT-SWAP',
  'IMX-USDT-SWAP', 'GALA-USDT-SWAP', 'SAND-USDT-SWAP', 'AXS-USDT-SWAP',
];

// Ticker tape symbols (top 12 for scrolling display)
const TICKER_SYMBOLS = SCAN_SYMBOLS.slice(0, 12);

let scanInProgress = false;
let lastScanAt: string | null = null;

// ─── OKX Public OHLCV Fetcher (no API key needed) ───

/** Convert OKX native symbol to ccxt format: "PEPE-USDT-SWAP" → "PEPE/USDT:USDT" */
function toCcxtSymbol(sym: string): string {
  if (sym.includes('/')) return sym; // already ccxt format
  const base = sym.replace('-USDT-SWAP', '');
  return `${base}/USDT:USDT`;
}

/**
 * Ensure we have at least `minCandles` of 1h OHLCV data for a symbol.
 * Fetches from OKX public API if cached data is insufficient, then caches it.
 */
async function ensureOHLCV(
  queries: TradingQueries,
  symbol: string,
  minCandles: number = 1000,
): Promise<OHLCVCandle[]> {
  // Check what we already have
  const cached = queries.getOHLCV(symbol, '1h');
  if (cached.length >= minCandles) return cached;

  log.info({ symbol, cached: cached.length, target: minCandles }, 'Fetching historical OHLCV from OKX...');

  const exchange = new ccxt.okx({ enableRateLimit: true });
  const ccxtSym = toCcxtSymbol(symbol);
  const tfMs = 3600 * 1000; // 1h
  const maxPerRequest = 100;

  // Start from `minCandles` hours ago
  let since = Date.now() - (minCandles * tfMs);
  const allCandles: OHLCVCandle[] = [];

  for (let page = 0; page < Math.ceil(minCandles / maxPerRequest) + 2; page++) {
    try {
      const raw = await exchange.fetchOHLCV(ccxtSym, '1h', since, maxPerRequest);
      if (!raw || raw.length === 0) break;

      for (const c of raw) {
        allCandles.push({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        });
      }

      since = (raw[raw.length - 1][0] as number) + 1;
      if (raw.length < maxPerRequest) break;

      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err: any) {
      log.warn({ symbol, page, error: err.message }, 'OHLCV fetch page failed');
      break;
    }
  }

  if (allCandles.length > 0) {
    // Cache in DB for future use
    queries.upsertOHLCV(symbol, '1h', allCandles);
    log.info({ symbol, fetched: allCandles.length }, 'Historical OHLCV cached');
  }

  // Return full dataset (cached + newly fetched — upsertOHLCV handles dedup)
  return queries.getOHLCV(symbol, '1h');
}

/** Strip exchange suffixes to get clean base symbol: "BTC-USDT-SWAP" → "BTC", "BTC/USDT:USDT" → "BTC" */
function shortSymbol(sym: string): string {
  return sym
    .replace('-USDT-SWAP', '')
    .replace('/USDT:USDT', '')
    .replace('/USDT', '')
    .replace(':USDT', '');
}

export function createApiRouter(queries: TradingQueries, exchange?: OkxAdapter | null): Router {
  const router = Router();

  // ─── Rate Limiting Middleware ───
  router.use((req: Request, res: Response, next) => {
    const ip = getRateLimitKey(req);
    const relaxedPaths = ['/overview', '/health'];
    const max = relaxedPaths.some(p => req.path === p) ? RATE_LIMIT_MAX_RELAXED : RATE_LIMIT_MAX;
    const { allowed, retryAfterMs } = checkRateLimit(ip, max);
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    next();
  });

  // ─── Health Check ───
  router.get('/health', (_req: Request, res: Response) => {
    try {
      const openCount = queries.getOpenPositionCount();
      const pnl = queries.getRealizedPnl();
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        openPositions: openCount,
        totalTrades: pnl.count,
        realizedPnl: pnl.total,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: String(err) });
    }
  });

  // ─── Export CSV ───
  router.get('/export/trades.csv', (req: Request, res: Response) => {
    try {
      const limit = parseQueryLimit(req.query.limit, 500);
      const positions = queries.getClosedPositions(limit);
      const headers = ['id', 'pair', 'direction', 'pnl', 'close_reason', 'opened_at', 'closed_at'];
      const rows = positions.map(p => [
        p.id,
        p.pair,
        p.direction,
        p.pnl?.toFixed(2) ?? '',
        p.close_reason ?? '',
        p.opened_at,
        p.closed_at ?? '',
      ].join(','));
      const csv = [headers.join(','), ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=trades.csv');
      res.send(csv);
    } catch (err) {
      log.error({ error: err }, 'Export CSV error');
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Overview ───
  router.get('/overview', (_req: Request, res: Response) => {
    try {
      const openPositions = queries.getOpenPositions();
      const pnlSummary = queries.getRealizedPnl();
      const config = getTradingConfig();

      let unrealizedPnl = 0;
      let totalMargin = 0;
      for (const pos of openPositions) {
        unrealizedPnl += pos.pnl ?? 0;
        totalMargin += pos.margin_per_leg * 2;
      }

      // Build equity curve from closed positions
      const closedPositions = queries.getClosedPositions(500);
      const equityCurve: { time: string; equity: number }[] = [];
      let cumPnl = 0;
      const sorted = [...closedPositions].reverse();
      for (const pos of sorted) {
        if (pos.pnl !== null) {
          cumPnl += pos.pnl;
          equityCurve.push({
            time: pos.closed_at ?? pos.opened_at,
            equity: cumPnl,
          });
        }
      }

      res.json({
        totalEquity: config.maxCapitalPerPair * config.maxOpenPairs + pnlSummary.total,
        realizedPnl: pnlSummary.total,
        unrealizedPnl,
        availableMargin: config.maxCapitalPerPair * config.maxOpenPairs - totalMargin,
        openPairs: openPositions.length,
        totalTrades: pnlSummary.count,
        winRate: pnlSummary.count > 0 ? pnlSummary.wins / pnlSummary.count : 0,
        wins: pnlSummary.wins,
        losses: pnlSummary.losses,
        equityCurve,
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /overview');
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Positions ───
  router.get('/positions', (_req: Request, res: Response) => {
    try {
      const open = queries.getOpenPositions();
      const positions = open.map(pos => {
        const durationMs = Date.now() - new Date(pos.opened_at).getTime();
        const durationMin = Math.floor(durationMs / 60000);
        const hours = Math.floor(durationMin / 60);
        const mins = durationMin % 60;

        // Get recent Z-Score history for sparkline
        const zHistory = queries.getZScoreHistory(pos.pair, 50);

        return {
          ...pos,
          durationFormatted: hours > 0 ? `${hours}h ${mins}m` : `${mins}m`,
          durationMs,
          uplPercent: pos.margin_per_leg > 0 ? ((pos.pnl ?? 0) / (pos.margin_per_leg * 2)) * 100 : 0,
          sparkline: zHistory.reverse().map(z => z.z_score),
        };
      });

      res.json({ positions });
    } catch (err) {
      log.error({ error: err }, 'Error in /positions');
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/positions/closed', (req: Request, res: Response) => {
    try {
      const limit = parseQueryLimit(req.query.limit, 50);
      const positions = queries.getClosedPositions(limit);
      res.json({ positions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Scanner ───
  router.get('/scanner/pairs', (req: Request, res: Response) => {
    try {
      const minCorr = parseFloat(req.query.minCorr as string) || 0.5;
      const sector = req.query.sector as string || '';

      // Get all symbols from OHLCV cache, deduplicated by base name
      const rawSymbols = queries.getDistinctSymbols();
      if (rawSymbols.length < 2) {
        return res.json({ pairs: [], message: 'Not enough OHLCV data cached. Run a scan first.' });
      }

      // Deduplicate: group by base name, keep the symbol with most candles
      const baseMap = new Map<string, string>(); // baseName → best raw symbol
      const priceMap = new Map<string, number[]>();
      for (const sym of rawSymbols) {
        const base = shortSymbol(sym);
        const candles = queries.getOHLCV(sym, '1h', undefined, 200);
        if (candles.length < 30) continue;

        const existing = baseMap.get(base);
        if (!existing || candles.length > (priceMap.get(existing)?.length ?? 0)) {
          baseMap.set(base, sym);
          priceMap.set(sym, candles.map(c => c.close));
          // Remove old entry if exists
          if (existing && existing !== sym) priceMap.delete(existing);
        }
      }

      // Calculate correlations
      const validSymbols = Array.from(priceMap.keys());
      const pairs: any[] = [];

      for (let i = 0; i < validSymbols.length; i++) {
        for (let j = i + 1; j < validSymbols.length; j++) {
          const a = priceMap.get(validSymbols[i])!;
          const b = priceMap.get(validSymbols[j])!;
          const retA = logReturns(a);
          const retB = logReturns(b);
          const minLen = Math.min(retA.length, retB.length);
          if (minLen < 10) continue;

          const corr = pearsonCorrelation(retA.slice(-minLen), retB.slice(-minLen));
          if (corr < minCorr) continue;

          const sectorA = getSector(validSymbols[i]);
          const sectorB = getSector(validSymbols[j]);
          if (sector && sector !== 'all' && sectorA !== sector && sectorB !== sector) continue;

          // Cointegration test
          const coint = testCointegration(
            a.slice(-minLen - 1), b.slice(-minLen - 1),
            validSymbols[i], validSymbols[j], 0.1
          );

          // Z-Score
          const { zScore, spread } = calculateZScore(
            a.slice(-minLen - 1), b.slice(-minLen - 1), coint.beta
          );

          // Compute order instruction based on Z-Score thresholds & active positions
          const pairName = `${shortSymbol(validSymbols[i])}/${shortSymbol(validSymbols[j])}`;
          const config = getTradingConfig();
          const absZ = Math.abs(zScore);
          const activePos = queries.getActivePositionByPair(pairName);

          let orderInstruction = 'MONITORING';
          let legAAction = '';
          let legBAction = '';
          let signalStrength = 0;

          if (activePos) {
            // Position exists — check for exit conditions
            // Grace period: don't trigger SL if position is too young
            const posAge = Date.now() - new Date(activePos.opened_at).getTime();
            const pastGracePeriod = posAge >= (config.gracePeriodMs ?? 300000);

            if (absZ > config.stopLossZScore && pastGracePeriod) {
              orderInstruction = 'CLOSE_SL';
              legAAction = 'CLOSE';
              legBAction = 'CLOSE';
              signalStrength = absZ / config.stopLossZScore;
            } else if (absZ > config.stopLossZScore && !pastGracePeriod) {
              // SL zone but within grace period — show as HOLD with warning
              orderInstruction = 'HOLD';
              legAAction = 'GRACE PERIOD';
              legBAction = `${Math.ceil((config.gracePeriodMs ?? 300000 - posAge) / 60000)}m left`;
              signalStrength = absZ / config.stopLossZScore;
            } else if (absZ <= config.exitZScore) {
              orderInstruction = 'CLOSE_TP';
              legAAction = 'CLOSE';
              legBAction = 'CLOSE';
              signalStrength = 1 - (absZ / config.exitZScore);
            } else {
              orderInstruction = 'HOLD';
              signalStrength = absZ / config.entryZScore;
            }
          } else {
            // No position — check for entry
            if (absZ > config.entryZScore && absZ < config.stopLossZScore - (config.safeZoneBuffer ?? 0.5)) {
              orderInstruction = 'OPEN_PAIR';
              signalStrength = absZ / config.stopLossZScore;
              if (zScore > 0) {
                // SHORT_SPREAD: sell A, buy B
                legAAction = `SELL ${shortSymbol(validSymbols[i])}`;
                legBAction = `BUY ${shortSymbol(validSymbols[j])}`;
              } else {
                // LONG_SPREAD: buy A, sell B
                legAAction = `BUY ${shortSymbol(validSymbols[i])}`;
                legBAction = `SELL ${shortSymbol(validSymbols[j])}`;
              }
            } else if (absZ > config.entryZScore * 0.7) {
              orderInstruction = 'SIGNAL_ONLY';
              signalStrength = absZ / config.entryZScore;
            }
          }

          pairs.push({
            symbolA: validSymbols[i],
            symbolB: validSymbols[j],
            pair: pairName,
            correlation: corr,
            cointegrationPValue: coint.pValue,
            halfLife: coint.halfLife,
            isCointegrated: coint.isCointegrated,
            zScore,
            spread,
            sectorA,
            sectorB,
            orderInstruction,
            legAAction,
            legBAction,
            signalStrength,
            hasActivePosition: !!activePos,
          });
        }
      }

      pairs.sort((a, b) => b.correlation - a.correlation);

      // Build heatmap data
      const heatmap = {
        symbols: validSymbols.map(s => shortSymbol(s)),
        matrix: [] as number[][],
      };

      for (let i = 0; i < validSymbols.length; i++) {
        const row: number[] = [];
        for (let j = 0; j < validSymbols.length; j++) {
          if (i === j) {
            row.push(1);
          } else {
            const a = logReturns(priceMap.get(validSymbols[i])!);
            const b = logReturns(priceMap.get(validSymbols[j])!);
            const minLen = Math.min(a.length, b.length);
            row.push(minLen >= 3 ? pearsonCorrelation(a.slice(-minLen), b.slice(-minLen)) : 0);
          }
        }
        heatmap.matrix.push(row);
      }

      res.json({ pairs, heatmap });
    } catch (err) {
      log.error({ error: err }, 'Error in /scanner/pairs');
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/scanner/run', async (_req: Request, res: Response) => {
    if (scanInProgress) {
      return res.json({ message: 'Scan already in progress...', status: 'running' });
    }

    scanInProgress = true;
    try {
      // Dynamic import ccxt (public API — no API key needed for OHLCV)
      const ccxt = await import('ccxt');
      const exchange = new ccxt.okx({ enableRateLimit: true });

      const timeframe = '1h';
      const lookbackBars = 200;
      const tfMs = 3600000;
      const since = Date.now() - lookbackBars * tfMs;
      let fetched = 0;
      let failed = 0;

      for (const symbol of SCAN_SYMBOLS) {
        try {
          // ccxt uses slash format: BTC-USDT-SWAP → BTC/USDT:USDT
          const base = symbol.replace('-USDT-SWAP', '');
          const ccxtSymbol = `${base}/USDT:USDT`;

          const raw = await exchange.fetchOHLCV(ccxtSymbol, timeframe, since, lookbackBars);
          if (!raw || raw.length === 0) {
            log.warn({ symbol }, 'No OHLCV data returned');
            failed++;
            continue;
          }

          const candles: OHLCVCandle[] = raw.map((c: any) => ({
            timestamp: c[0] as number,
            open: c[1] as number,
            high: c[2] as number,
            low: c[3] as number,
            close: c[4] as number,
            volume: c[5] as number,
          }));

          queries.upsertOHLCV(symbol, timeframe, candles);
          fetched++;
          log.info({ symbol, bars: candles.length }, 'OHLCV fetched');
        } catch (err) {
          log.error({ symbol, error: String(err) }, 'Failed to fetch OHLCV');
          failed++;
        }
      }

      lastScanAt = new Date().toISOString();
      res.json({
        message: `Scan complete: ${fetched} symbols fetched, ${failed} failed`,
        status: 'done',
        fetched,
        failed,
        total: SCAN_SYMBOLS.length,
      });
    } catch (err) {
      log.error({ error: err }, 'Scanner run error');
      res.status(500).json({ error: String(err) });
    } finally {
      scanInProgress = false;
    }
  });

  // ─── Spread Monitor ───
  router.get('/spread/:pair', (req: Request, res: Response) => {
    try {
      const pair = sanitizePairParam(req.params.pair as string);
      if (!pair) {
        return res.status(400).json({ error: 'Invalid pair format. Expected e.g. BTC/ETH' });
      }
      const limit = parseQueryLimit(req.query.limit, 500);
      const history = queries.getZScoreHistory(pair, limit);
      const config = getTradingConfig();

      // Get active position for this pair
      const activePos = queries.getActivePositionByPair(pair);

      res.json({
        pair,
        history: history.reverse(),
        entryZ: config.entryZScore,
        exitZ: config.exitZScore,
        stopLossZ: config.stopLossZScore,
        currentZ: history.length > 0 ? history[history.length - 1]?.z_score : null,
        activePosition: activePos ? {
          direction: activePos.direction,
          entryZ: activePos.entry_z_score,
          openedAt: activePos.opened_at,
        } : null,
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /spread');
      res.status(500).json({ error: String(err) });
    }
  });

  // Get list of pairs with z-score data
  router.get('/spread', (_req: Request, res: Response) => {
    try {
      const openPositions = queries.getOpenPositions();
      const pairsFromPositions = openPositions.map(p => p.pair);

      // Also find pairs with z-score history
      const pairsFromHistory = queries.getDistinctZScorePairs();

      const allPairs = [...new Set([...pairsFromPositions, ...pairsFromHistory])];
      res.json({ pairs: allPairs });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Backtest ───
  router.get('/backtest/run', async (req: Request, res: Response) => {
    try {
      const pair = req.query.pair as string;
      if (!pair) {
        return res.status(400).json({ error: 'pair parameter required (e.g., BTC/ETH)' });
      }
      if (!PAIR_REGEX.test(pair)) {
        return res.status(400).json({ error: 'Invalid pair format. Expected e.g. BTC/ETH' });
      }

      const entryZ = parsePositiveFloat(req.query.entryZ, 2.0);
      const exitZ = parsePositiveFloat(req.query.exitZ, 0.5);
      const stopLossZ = parsePositiveFloat(req.query.stopLossZ, 3.0);
      const lookback = parsePositiveInt(req.query.lookback, 168);
      const corrThreshold = parsePositiveFloat(req.query.corrThreshold, 0.75);

      if (entryZ > 10 || exitZ > 10 || stopLossZ > 20 || lookback > 10000) {
        return res.status(400).json({ error: 'Parameter values out of reasonable range' });
      }

      const [symA, symB] = pair.split('/');
      const symbolA = `${symA}-USDT-SWAP`;
      const symbolB = `${symB}-USDT-SWAP`;

      // Auto-fetch historical data from OKX if insufficient (target: 1000 candles ≈ 42 days)
      const candlesA = await ensureOHLCV(queries, symbolA, 1000);
      const candlesB = await ensureOHLCV(queries, symbolB, 1000);

      if (candlesA.length < 50 || candlesB.length < 50) {
        return res.status(400).json({
          error: `Not enough OHLCV data. ${symA}: ${candlesA.length} candles, ${symB}: ${candlesB.length} candles. Need at least 50. Check that the symbol exists on OKX.`,
        });
      }

      const pricesA = candlesA.map(c => c.close);
      const pricesB = candlesB.map(c => c.close);

      const config: BacktestConfig = {
        entryZ,
        exitZ,
        stopLossZ,
        halfLifeFilter: lookback,
        correlationFilter: corrThreshold,
        safeZoneBuffer: 0.5,
        gracePeriodBars: 5,
        cooldownBars: 24,
        capitalPerLeg: getTradingConfig().maxCapitalPerPair,
        leverage: getTradingConfig().maxLeverage,
        feeRate: 0.0006,
      };

      const report = runBacktest(pricesA, pricesB, pair, config);

      // Build equity curve
      let cumPnl = 0;
      const equityCurve = report.trades.map(t => {
        cumPnl += t.pnl;
        return { bar: t.exitBar, equity: cumPnl };
      });

      // Compute diagnostic Z-Score stats for the user
      const n = Math.min(pricesA.length, pricesB.length);
      const logA = pricesA.map(Math.log);
      const logB = pricesB.map(Math.log);
      const halfN = Math.floor(n / 2);
      let zMin = Infinity, zMax = -Infinity;
      try {
        const { beta } = ols(logB.slice(0, halfN), logA.slice(0, halfN));
        const spread: number[] = [];
        for (let i = 0; i < n; i++) spread.push(logA[i] - beta * logB[i]);
        const effectiveWindow = Math.min(lookback, Math.floor(n * 0.8));
        for (let i = effectiveWindow; i < n; i++) {
          const ws = spread.slice(i - effectiveWindow, i + 1);
          const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
          const std = Math.sqrt(ws.reduce((a, b) => a + (b - mean) ** 2, 0) / ws.length);
          const z = std > 0 ? (spread[i] - mean) / std : 0;
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
        }
      } catch { /* diagnostic only, don't fail */ }

      res.json({
        report: {
          pair: report.pair,
          totalTrades: report.totalTrades,
          winRate: report.winRate,
          totalPnl: report.totalPnl,
          avgPnl: report.avgPnl,
          sharpeRatio: report.sharpeRatio,
          maxDrawdown: report.maxDrawdown,
          maxDrawdownPercent: report.maxDrawdownPercent,
          profitFactor: report.profitFactor,
          avgBarsHeld: report.avgBarsHeld,
        },
        trades: report.trades,
        equityCurve,
        config,
        diagnostics: {
          candlesA: candlesA.length,
          candlesB: candlesB.length,
          tradingBars: n - Math.min(lookback, Math.floor(n * 0.8)),
          zScoreRange: { min: zMin === Infinity ? 0 : +zMin.toFixed(3), max: zMax === -Infinity ? 0 : +zMax.toFixed(3) },
          entryThreshold: entryZ,
          hint: report.totalTrades === 0
            ? `Z-Score range [${(zMin === Infinity ? 0 : zMin).toFixed(2)}, ${(zMax === -Infinity ? 0 : zMax).toFixed(2)}] — entry needs |Z| > ${entryZ}. Try lowering Entry Z or picking a different pair.`
            : undefined,
        },
        textReport: formatReport(report),
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /backtest/run');
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/backtest/grid', async (req: Request, res: Response) => {
    try {
      const pair = req.query.pair as string;
      if (!pair) {
        return res.status(400).json({ error: 'pair parameter required' });
      }
      if (!PAIR_REGEX.test(pair)) {
        return res.status(400).json({ error: 'Invalid pair format. Expected e.g. BTC/ETH' });
      }

      const [symA, symB] = pair.split('/');
      // Auto-fetch historical data if insufficient
      const candlesA = await ensureOHLCV(queries, `${symA}-USDT-SWAP`, 1000);
      const candlesB = await ensureOHLCV(queries, `${symB}-USDT-SWAP`, 1000);

      if (candlesA.length < 50 || candlesB.length < 50) {
        return res.status(400).json({ error: `Not enough OHLCV data. ${symA}: ${candlesA.length}, ${symB}: ${candlesB.length}. Check symbol exists on OKX.` });
      }

      const pricesA = candlesA.map(c => c.close);
      const pricesB = candlesB.map(c => c.close);

      const { results, bestConfig, totalCombinations } = runGridSearch(pricesA, pricesB, pair);

      // Save top results
      saveTopResults(queries, results, 10);

      const topResults = results.slice(0, 20).map((r, i) => ({
        rank: i + 1,
        entryZ: r.config.entryZ,
        exitZ: r.config.exitZ,
        stopLossZ: r.config.stopLossZ,
        totalTrades: r.totalTrades,
        winRate: r.winRate,
        totalPnl: r.totalPnl,
        sharpeRatio: r.sharpeRatio,
        maxDrawdown: r.maxDrawdown,
        profitFactor: r.profitFactor,
      }));

      res.json({
        pair,
        totalCombinations,
        topResults,
        bestConfig,
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /backtest/grid');
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/backtest/history', (_req: Request, res: Response) => {
    try {
      const results = queries.getTopBacktestResults(20);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Config ───
  router.get('/config', (_req: Request, res: Response) => {
    try {
      const config = getTradingConfig();
      const latestDb = queries.getLatestConfig();
      res.json({
        config,
        source: latestDb?.backtest_rank ? `backtest rank #${latestDb.backtest_rank}` : 'manual',
        appliedAt: latestDb?.applied_at ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/config', async (req: Request, res: Response) => {
    try {
      // Auth check
      const configSecret = process.env.CONFIG_SECRET || process.env.WEB_CONFIG_TOKEN;
      if (!configSecret) {
        return res.status(401).json({ error: 'Unauthorized — CONFIG_SECRET not configured' });
      }

      const authHeader = req.headers.authorization;
      const tokenHeader = req.headers['x-config-token'] as string | undefined;
      const token = tokenHeader
        ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);

      if (!token || token !== configSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Request body must be a JSON object' });
      }

      const newConfig = updateTradingConfig(updates);
      queries.insertConfigHistory(JSON.stringify(newConfig));

      // Also write to config.json file (async, non-blocking)
      try {
        await fs.promises.writeFile(
          path.join(process.cwd(), 'config.json'),
          JSON.stringify(newConfig, null, 2),
        );
      } catch (writeErr) {
        log.warn({ error: writeErr }, 'Failed to write config.json (non-critical)');
      }

      res.json({ config: newConfig, message: 'Config updated successfully' });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ─── Signals ───
  router.get('/signals', (req: Request, res: Response) => {
    try {
      const signals = queries.getUnactedSignals();
      res.json({ signals });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Account (live OKX data) ───
  router.get('/account', async (_req: Request, res: Response) => {
    if (!exchange) {
      return res.json({ connected: false, message: 'OKX adapter not available' });
    }
    try {
      const [balance, info] = await Promise.all([
        exchange.fetchBalance(),
        exchange.fetchAccountInfo(),
      ]);
      const marginUsed = balance.totalEquity - balance.availableBalance;
      const marginRatio = balance.totalEquity > 0 ? marginUsed / balance.totalEquity : 0;
      res.json({
        connected: true,
        totalEquity: balance.totalEquity,
        availableBalance: balance.availableBalance,
        unrealizedPnl: balance.unrealizedPnl,
        frozenBalance: balance.frozenBalance,
        marginUsed,
        marginRatio,
        accountType: info.accountType,
        positionMode: info.positionMode,
        uid: info.uid,
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /account');
      res.json({ connected: false, error: String(err) });
    }
  });

  // ─── Account Stats (computed from DB) ───
  router.get('/account/stats', (_req: Request, res: Response) => {
    try {
      const pnlSummary = queries.getRealizedPnl();
      const closed = queries.getClosedPositions(500);
      const openPositions = queries.getOpenPositions();

      const pnls = closed.filter(p => p.pnl !== null).map(p => p.pnl as number);
      const wins = pnls.filter(p => p > 0);
      const losses = pnls.filter(p => p < 0);

      // Max drawdown from equity curve
      let peak = 0;
      let maxDD = 0;
      let cumPnl = 0;
      const sorted = [...closed].reverse();
      for (const pos of sorted) {
        if (pos.pnl !== null) {
          cumPnl += pos.pnl;
          if (cumPnl > peak) peak = cumPnl;
          const dd = peak - cumPnl;
          if (dd > maxDD) maxDD = dd;
        }
      }

      // Sharpe ratio (simple: mean/std of trade PnLs)
      let sharpe = 0;
      if (pnls.length > 1) {
        const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const std = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length);
        sharpe = std > 0 ? mean / std : 0;
      }

      const totalWins = wins.reduce((a, b) => a + b, 0);
      const totalLosses = Math.abs(losses.reduce((a, b) => a + b, 0));

      res.json({
        realizedPnl: pnlSummary.total,
        totalFees: pnls.length * 0.0006 * 2 * (getTradingConfig().maxCapitalPerPair * getTradingConfig().maxLeverage), // estimated
        totalTrades: pnlSummary.count,
        openPositions: openPositions.length,
        pairTrades: pnlSummary.count,
        winRate: pnlSummary.count > 0 ? pnlSummary.wins / pnlSummary.count : 0,
        avgWin: wins.length > 0 ? totalWins / wins.length : 0,
        avgLoss: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
        profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
        bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
        worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
        sharpeRatio: sharpe,
        maxDrawdown: maxDD,
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /account/stats');
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Ticker Tape (public data) ───
  router.get('/ticker/tape', async (_req: Request, res: Response) => {
    try {
      // Use exchange adapter if available, otherwise create public ccxt instance
      if (exchange) {
        const tickers = await exchange.fetchTickers(TICKER_SYMBOLS);
        return res.json({ tickers });
      }

      // Fallback: public ccxt (no API key needed)
      const ccxt = await import('ccxt');
      const pub = new ccxt.okx({ enableRateLimit: true });
      const ccxtSymbols = TICKER_SYMBOLS.map(s => {
        const base = s.replace('-USDT-SWAP', '');
        return `${base}/USDT:USDT`;
      });
      const raw = await pub.fetchTickers(ccxtSymbols);
      const tickers = Object.values(raw).map((t: any) => ({
        symbol: (t.symbol as string).split('/')[0],
        last: t.last ?? 0,
        change24h: t.percentage ?? 0,
      }));
      res.json({ tickers });
    } catch (err) {
      log.error({ error: err }, 'Error in /ticker/tape');
      res.json({ tickers: [] });
    }
  });

  // ─── Exchange Positions (raw OKX positions) ───
  router.get('/positions/exchange', async (_req: Request, res: Response) => {
    if (!exchange) {
      return res.json({ connected: false, positions: [] });
    }
    try {
      const raw = await exchange.fetchPositions();
      const positions = raw.map(p => {
        const entryPrice = p.avgPrice ?? 0;
        const upl = p.unrealizedPnl ?? 0;
        const notional = entryPrice * p.size;
        const uplPercent = notional > 0 ? (upl / notional) * 100 : 0;
        return {
          symbol: shortSymbol(p.symbol),
          rawSymbol: p.symbol,
          side: p.side,
          size: p.size,
          entryPrice,
          markPrice: entryPrice + (p.size > 0 ? upl / p.size : 0),
          upl,
          uplPercent,
        };
      });
      res.json({ connected: true, positions });
    } catch (err) {
      log.error({ error: err }, 'Error in /positions/exchange');
      res.json({ connected: false, positions: [], error: String(err) });
    }
  });

  // ─── Scanner Status ───
  router.get('/scanner/status', (_req: Request, res: Response) => {
    try {
      const symbols = queries.getDistinctSymbols();
      const config = getTradingConfig();
      res.json({
        status: scanInProgress ? 'scanning' : 'idle',
        lastScanAt,
        symbolCount: symbols.length,
        pairCount: (symbols.length * (symbols.length - 1)) / 2,
        scanIntervalMs: config.scanIntervalMs,
        autoTradingEnabled: config.autoTradingEnabled ?? true,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Reconcile P&L (fix trades with missing entry/exit prices) ───
  router.post('/account/reconcile', async (_req: Request, res: Response) => {
    if (!exchange) {
      return res.json({ success: false, message: 'OKX adapter not available' });
    }
    try {
      const closed = queries.getClosedPositions(100);
      let fixed = 0;
      const details: any[] = [];

      for (const pos of closed) {
        let entryA = pos.leg_a_entry_price ?? 0;
        let entryB = pos.leg_b_entry_price ?? 0;
        let needsUpdate = false;

        // Fetch missing entry prices from order history
        if (entryA === 0 && pos.leg_a_order_id) {
          entryA = await exchange.fetchOrderFillPrice(pos.leg_a_order_id, pos.leg_a_symbol);
          if (entryA > 0) needsUpdate = true;
        }
        if (entryB === 0 && pos.leg_b_order_id) {
          entryB = await exchange.fetchOrderFillPrice(pos.leg_b_order_id, pos.leg_b_symbol);
          if (entryB > 0) needsUpdate = true;
        }

        // Try to find exit prices from closed orders on OKX
        // Look for opposite-side orders (close = opposite of entry side), excluding entry order IDs
        let exitA = 0;
        let exitB = 0;
        if (pos.closed_at) {
          const closeTime = new Date(pos.closed_at).getTime();
          const openTime = new Date(pos.opened_at).getTime();
          const searchSince = openTime - 60000; // search from slightly before open

          const oppSideA = pos.leg_a_side === 'buy' ? 'sell' : 'buy';
          const oppSideB = pos.leg_b_side === 'buy' ? 'sell' : 'buy';

          try {
            const closedOrdersA = await exchange.fetchClosedOrders(pos.leg_a_symbol, searchSince, 20);
            // Find opposite-side order that's NOT the entry order, closest to close time
            const matchA = closedOrdersA
              .filter(o => o.orderId !== pos.leg_a_order_id && o.side === oppSideA)
              .sort((a, b) => Math.abs(a.timestamp - closeTime) - Math.abs(b.timestamp - closeTime))[0];
            if (matchA && Math.abs(matchA.timestamp - closeTime) < 300000) exitA = matchA.avgPrice;
          } catch { /* skip */ }

          try {
            const closedOrdersB = await exchange.fetchClosedOrders(pos.leg_b_symbol, searchSince, 20);
            const matchB = closedOrdersB
              .filter(o => o.orderId !== pos.leg_b_order_id && o.side === oppSideB)
              .sort((a, b) => Math.abs(a.timestamp - closeTime) - Math.abs(b.timestamp - closeTime))[0];
            if (matchB && Math.abs(matchB.timestamp - closeTime) < 300000) exitB = matchB.avgPrice;
          } catch { /* skip */ }
        }

        // Get contract sizes (ctVal) for proper P&L calculation
        // OKX contracts: ETH-USDT-SWAP = 0.1 ETH/ct, XRP-USDT-SWAP = 100 XRP/ct, etc.
        const ctValA = await exchange.getContractSize(pos.leg_a_symbol);
        const ctValB = await exchange.getContractSize(pos.leg_b_symbol);

        // Calculate P&L: (exitPrice - entryPrice) * numContracts * ctVal * direction
        let pnl = 0;
        if (entryA > 0 && exitA > 0) {
          const multiplierA = pos.leg_a_side === 'buy' ? 1 : -1;
          pnl += (exitA - entryA) * pos.leg_a_size * ctValA * multiplierA;
          needsUpdate = true;
        }
        if (entryB > 0 && exitB > 0) {
          const multiplierB = pos.leg_b_side === 'buy' ? 1 : -1;
          pnl += (exitB - entryB) * pos.leg_b_size * ctValB * multiplierB;
          needsUpdate = true;
        }

        // Deduct fees if we have exit data
        if (exitA > 0 || exitB > 0) {
          const notionalA = (exitA > 0 ? exitA : entryA) * pos.leg_a_size * ctValA;
          const notionalB = (exitB > 0 ? exitB : entryB) * pos.leg_b_size * ctValB;
          pnl -= (notionalA + notionalB) * 0.0006 * 2;
        }

        if (needsUpdate || exitA > 0 || exitB > 0) {
          const updates: Record<string, any> = {};
          if (entryA > 0) updates.leg_a_entry_price = entryA;
          if (entryB > 0) updates.leg_b_entry_price = entryB;
          if (exitA > 0 || exitB > 0) updates.pnl = pnl;

          queries.updatePositionState(pos.id, pos.state as any, updates);
          fixed++;
          details.push({
            id: pos.id,
            pair: pos.pair,
            entryA, exitA,
            entryB, exitB,
            pnl,
            oldPnl: pos.pnl,
          });
          log.info({ posId: pos.id, entryA, exitA, entryB, exitB, pnl }, 'Reconciled position');
        }
      }

      res.json({
        success: true,
        message: `Reconciled ${fixed} positions`,
        totalChecked: closed.length,
        fixed,
        details,
      });
    } catch (err) {
      log.error({ error: err }, 'Error in /account/reconcile');
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
