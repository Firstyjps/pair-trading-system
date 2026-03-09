import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { initializeDatabase } from './db/schema.js';
import { runMigrations } from './db/migrations.js';
import { TradingQueries } from './db/queries.js';
import { loadEnvConfig, loadTradingConfig, getTradingConfig } from './config.js';
import { PositionManager } from './trader/position-manager.js';
import { createOkxAdapter } from './exchange/okx-adapter.js';
import { createGrammyAdapter } from './telegram/grammy-adapter.js';
import { createTelegramBot } from './telegram/bot.js';
import { DataFetcher } from './scanner/data-fetcher.js';
import { buildCorrelationMatrix, tagSectors } from './scanner/correlation.js';
import { testCointegration, rankPairs } from './scanner/cointegration.js';
import { generateSignals, persistSignals, calculateZScore } from './scanner/signal-generator.js';
import { executePairTrade, closePairPosition } from './trader/order-executor.js';
import { checkSpreads } from './monitor/spread-monitor.js';
import { reconcile } from './monitor/reconciliation.js';
import { detectOrphans } from './monitor/orphan-detector.js';
import { dollarNeutral } from './sizing/dollar-neutral.js';
import { buildPnLReport } from './telegram/pnl-report.js';
import type { Direction, OHLCVCandle } from './types.js';
import type { CointegrationResult } from './scanner/cointegration.js';
import {
  cleanupAndRegister,
  registerShutdownHandlers,
  getStartupTime,
} from './lifecycle.js';
import { logger } from './logger.js';

// ─── In-memory caches for spread monitoring ───
const betaCache = new Map<string, number>();
const priceCache = new Map<string, number[]>();
const contractSizeCache = new Map<string, number>(); // base → contractSize (e.g. ETH → 0.01)

async function main() {
  logger.info('Starting Pair Trading System...');

  // ═══ Load Configs ═══
  const envConfig = loadEnvConfig();
  const tradingConfig = loadTradingConfig('./config.json');

  logger.info({
    sandbox: envConfig.OKX_SANDBOX,
    leverage: tradingConfig.maxLeverage,
    maxPairs: tradingConfig.maxOpenPairs,
    capitalPerPair: tradingConfig.maxCapitalPerPair,
    mode: tradingConfig.targetPairs ? 'TARGETED' : 'DYNAMIC_SCAN',
    targetPairs: tradingConfig.targetPairs ?? 'none (full scan)',
  }, 'Configuration loaded');

  // SAFETY: Verify sandbox mode
  if (!envConfig.OKX_SANDBOX) {
    logger.warn('⚠️  RUNNING IN LIVE MODE — NOT SANDBOX');
  }

  // ═══ Initialize DB (RULE 1: DB-First) ═══
  const db = initializeDatabase(envConfig.DB_PATH);
  runMigrations(db);
  const queries = new TradingQueries(db);

  // Save config to history
  queries.insertConfigHistory(JSON.stringify(tradingConfig));

  // Position Manager — restore state from DB
  const positionManager = new PositionManager(queries);
  const restoredPositions = positionManager.restoreOnBoot();
  logger.info({ restored: restoredPositions.length }, 'Positions restored from DB');

  // Startup guard: don't act on old signals for first 30 seconds
  const startupTime = getStartupTime();
  const STARTUP_GUARD_MS = 30000;

  // Register shutdown handlers
  registerShutdownHandlers(async () => {
    logger.info('Shutting down gracefully...');
    queries.close();
  });

  // ═══ 1. Initialize Exchange Adapter (ccxt OKX) ═══
  logger.info('Initializing OKX exchange adapter...');
  const exchangeAdapter = await createOkxAdapter({
    apiKey: envConfig.OKX_API_KEY,
    secret: envConfig.OKX_SECRET,
    passphrase: envConfig.OKX_PASSPHRASE,
    sandbox: envConfig.OKX_SANDBOX,
  });
  logger.info('OKX exchange adapter ready');

  // Data fetcher for scanner
  const dataFetcher = new DataFetcher(exchangeAdapter, queries);

  // ═══ 2. Initialize Telegram Bot (grammy) ═══
  logger.info('Initializing Telegram bot...');
  const grammyAdapter = createGrammyAdapter(envConfig.TELEGRAM_BOT_TOKEN);

  const { bot: telegramBot, notifications } = createTelegramBot(
    grammyAdapter,
    queries,
    positionManager,
    grammyAdapter, // Also implements NotificationSender
    envConfig.TELEGRAM_CHAT_ID,
    {
      onScan: async () => {
        await runFullScan();
      },
      onOpenPair: async (pair: string) => {
        return await manualOpenPair(pair);
      },
      onClosePair: async (pair: string) => {
        return await manualClosePair(pair);
      },
      onPnlReport: async () => {
        const [exchangePositions, balance, pairPositions] = await Promise.all([
          exchangeAdapter.fetchPositions(),
          exchangeAdapter.fetchBalance(),
          Promise.resolve(queries.getOpenPositions()),
        ]);
        const realized = queries.getRealizedPnl();
        return buildPnLReport(
          {
            pairPositions,
            exchangePositions,
            totalBalance: balance.totalEquity,
            realizedPnl: realized.total,
          },
          queries,
        );
      },
    },
  );

  await telegramBot.start();
  logger.info('Telegram bot started');

  // Send startup notification
  await notifications.errorAlert(
    `🟢 System started (${envConfig.OKX_SANDBOX ? 'SANDBOX' : 'LIVE'}) — ${restoredPositions.length} positions restored`,
    'startup',
  );

  // ═══ Scanner Logic ═══

  async function runFullScan() {
    const config = getTradingConfig();

    // ── Targeted pair mode: skip full scan, directly process target pairs ──
    if (config.targetPairs && config.targetPairs.length > 0) {
      await runTargetedScan(config);
      return;
    }

    // ── Full dynamic scan mode (original behavior) ──
    logger.info('Starting full scan...');

    try {
      // Step 1: Get all swap markets
      const markets = await dataFetcher.getSwapMarkets();
      const activeMarkets = markets.filter(m => m.active).slice(0, 50);
      const topSymbols = activeMarkets.map(m => m.symbol);

      // Cache contract sizes for sizing (e.g. ETH → 0.01)
      for (const m of activeMarkets) {
        const baseName = m.symbol.split('/')[0];
        contractSizeCache.set(baseName, m.contractSize);
      }

      logger.info({ symbolCount: topSymbols.length }, 'Fetching OHLCV for scan');

      // Step 2: Fetch OHLCV data
      const ohlcvData = await dataFetcher.fetchMultipleOHLCV(
        topSymbols,
        config.primaryTimeframe,
        config.lookbackPeriods,
      );

      // Step 3: Extract close prices (convert ccxt symbols to base names)
      // "ETH/USDT:USDT" → "ETH" so pair names become "ETH/XRP" not "ETH/USDT:USDT/XRP/USDT:USDT"
      const priceData = new Map<string, number[]>();
      for (const [symbol, candles] of ohlcvData) {
        if (candles.length < 20) continue;
        const baseName = symbol.split('/')[0]; // "ETH/USDT:USDT" → "ETH"
        priceData.set(baseName, candles.map(c => c.close));
        // Update price cache for spread monitoring
        priceCache.set(baseName, candles.map(c => c.close));
      }

      // Step 4: Build correlation matrix
      const correlatedPairs = buildCorrelationMatrix(priceData, config.correlationThreshold);
      const taggedPairs = tagSectors(correlatedPairs);

      logger.info({ pairsAboveThreshold: taggedPairs.length }, 'Correlation scan complete');

      // Step 5: Cointegration tests
      const cointegrationResults = new Map<string, CointegrationResult>();
      for (const pair of taggedPairs.slice(0, 30)) { // Top 30 correlated pairs
        const pricesA = priceData.get(pair.symbolA);
        const pricesB = priceData.get(pair.symbolB);
        if (!pricesA || !pricesB) continue;

        const coint = testCointegration(
          pricesA, pricesB,
          pair.symbolA, pair.symbolB,
          config.cointegrationPValue,
        );
        const key = `${pair.symbolA}/${pair.symbolB}`;
        cointegrationResults.set(key, coint);

        // Cache beta for spread monitoring
        if (coint.isCointegrated) {
          betaCache.set(key, coint.beta);
        }
      }

      // Step 6: Rank cointegrated pairs
      const ranked = rankPairs(taggedPairs, cointegrationResults);
      logger.info({ cointegratedPairs: ranked.length }, 'Cointegration analysis complete');

      // Step 7: Generate signals
      const signalInput = ranked.map(r => ({
        symbolA: r.symbolA,
        symbolB: r.symbolB,
        correlation: r.correlation,
        coint: {
          ...r,
          // Already a CointegrationResult
        } as CointegrationResult,
        pricesA: priceData.get(r.symbolA) ?? [],
        pricesB: priceData.get(r.symbolB) ?? [],
      }));

      const candidates = generateSignals(signalInput);
      const signals = persistSignals(queries, candidates);

      logger.info({ signals: signals.length }, 'Scan complete — signals generated');

      // Step 8: Notify signals
      for (const signal of signals) {
        await notifications.signalDetected(signal);
      }

      // Step 9: Auto-trade signals (if within guard period, skip)
      if (Date.now() - startupTime < STARTUP_GUARD_MS) {
        logger.info('Startup guard active — skipping auto-trade');
        return;
      }

      for (const signal of signals) {
        await tryAutoTrade(signal.id, signal.pair, signal.direction, signal.z_score, signal.spread);
      }
    } catch (err) {
      logger.error({ error: err }, 'Scan failed');
      await notifications.errorAlert(`Scan failed: ${err}`, 'scanner');
    }
  }

  // ═══ Targeted Pair Scan ═══
  // When targetPairs is configured, skip the full 50-market correlation scan
  // and directly fetch + analyze only the specified pairs.

  async function runTargetedScan(config: ReturnType<typeof getTradingConfig>) {
    const targetPairs = config.targetPairs!;
    logger.info({ targetPairs }, 'Starting targeted scan...');

    try {
      // Collect all unique base symbols needed
      const uniqueSymbols = new Set<string>();
      for (const pair of targetPairs) {
        const [a, b] = pair.split('/');
        uniqueSymbols.add(a);
        uniqueSymbols.add(b);
      }

      // Fetch swap markets to get contract sizes + validate symbols exist
      const markets = await dataFetcher.getSwapMarkets();
      const swapSymbols: string[] = [];

      for (const base of uniqueSymbols) {
        const market = markets.find(m => m.symbol.startsWith(`${base}/`) && m.active);
        if (!market) {
          logger.warn({ symbol: base }, 'Target symbol not found on exchange — skipping');
          continue;
        }
        swapSymbols.push(market.symbol);
        contractSizeCache.set(base, market.contractSize);
      }

      if (swapSymbols.length < 2) {
        logger.error({ swapSymbols }, 'Not enough valid symbols for targeted scan');
        return;
      }

      logger.info({ symbols: swapSymbols }, 'Fetching OHLCV for target pairs');

      // Fetch OHLCV data for target symbols only
      const ohlcvData = await dataFetcher.fetchMultipleOHLCV(
        swapSymbols,
        config.primaryTimeframe,
        config.lookbackPeriods,
      );

      // Extract close prices
      const priceData = new Map<string, number[]>();
      for (const [symbol, candles] of ohlcvData) {
        if (candles.length < 20) continue;
        const baseName = symbol.split('/')[0];
        priceData.set(baseName, candles.map(c => c.close));
        priceCache.set(baseName, candles.map(c => c.close));
      }

      // Process each target pair
      const allSignalInputs: Array<{
        symbolA: string;
        symbolB: string;
        correlation: number;
        coint: CointegrationResult;
        pricesA: number[];
        pricesB: number[];
      }> = [];

      for (const pair of targetPairs) {
        const [symbolA, symbolB] = pair.split('/');
        const pricesA = priceData.get(symbolA);
        const pricesB = priceData.get(symbolB);

        if (!pricesA || !pricesB) {
          logger.warn({ pair }, 'Missing price data for target pair — skipping');
          continue;
        }

        // Cointegration test (use relaxed p-value since we trust the optimization)
        const coint = testCointegration(
          pricesA, pricesB,
          symbolA, symbolB,
          config.cointegrationPValue,
        );

        // Cache beta for spread monitoring regardless of cointegration result
        // (we trust the optimization — episodic cointegration is expected for meme pairs)
        betaCache.set(pair, coint.beta);

        logger.info({
          pair,
          pValue: coint.pValue.toFixed(4),
          beta: coint.beta.toFixed(4),
          isCointegrated: coint.isCointegrated,
        }, 'Target pair cointegration result');

        // Always generate signals for target pairs (even if not currently cointegrated)
        // The optimizer validated this pair works over 3 years of data
        allSignalInputs.push({
          symbolA,
          symbolB,
          correlation: 1.0, // Not relevant in targeted mode
          coint,
          pricesA,
          pricesB,
        });
      }

      if (allSignalInputs.length === 0) {
        logger.warn('No valid target pairs after data fetch');
        return;
      }

      // Generate signals using the same signal generator
      const candidates = generateSignals(allSignalInputs);
      const signals = persistSignals(queries, candidates);

      logger.info({ signals: signals.length, targetPairs }, 'Targeted scan complete');

      // Notify signals
      for (const signal of signals) {
        await notifications.signalDetected(signal);
      }

      // Auto-trade (respect startup guard)
      if (Date.now() - startupTime < STARTUP_GUARD_MS) {
        logger.info('Startup guard active — skipping auto-trade');
        return;
      }

      for (const signal of signals) {
        await tryAutoTrade(signal.id, signal.pair, signal.direction, signal.z_score, signal.spread);
      }
    } catch (err) {
      logger.error({ error: err }, 'Targeted scan failed');
      await notifications.errorAlert(`Targeted scan failed: ${err}`, 'scanner');
    }
  }

  // ═══ Auto-Trade Logic ═══

  async function tryAutoTrade(
    signalId: string,
    pair: string,
    direction: Direction,
    zScore: number,
    spread: number,
  ): Promise<void> {
    const config = getTradingConfig();
    if (!config.autoTradingEnabled) {
      logger.info({ pair, signalId }, 'Auto-trading disabled in config — skipping order placement');
      return;
    }
    const [symbolA, symbolB] = pair.split('/');
    const instrumentA = `${symbolA}-USDT-SWAP`;
    const instrumentB = `${symbolB}-USDT-SWAP`;
    const groupId = uuid();

    // 5-layer dedup check
    const canOpen = await positionManager.canOpenPair(
      pair,
      groupId,
      async (p) => {
        const [a, b] = p.split('/');
        const posA = await exchangeAdapter.getPosition(`${a}-USDT-SWAP`);
        const posB = await exchangeAdapter.getPosition(`${b}-USDT-SWAP`);
        return (posA !== null && posA.size > 0) || (posB !== null && posB.size > 0);
      },
    );

    if (!canOpen.allowed) {
      logger.info({ pair, reason: canOpen.reason }, 'Cannot open pair — dedup blocked');
      return;
    }

    try {
      // Fetch current prices for sizing
      const [tickerA, tickerB] = await Promise.all([
        exchangeAdapter.fetchTicker(instrumentA),
        exchangeAdapter.fetchTicker(instrumentB),
      ]);

      // Dollar-neutral sizing (use contract sizes from exchange)
      const ctSizeA = contractSizeCache.get(symbolA) ?? 1;
      const ctSizeB = contractSizeCache.get(symbolB) ?? 1;
      // Convert price per coin to price per contract
      const pricePerContractA = tickerA.last * ctSizeA;
      const pricePerContractB = tickerB.last * ctSizeB;

      const sizing = dollarNeutral(
        pricePerContractA,
        pricePerContractB,
        config.maxCapitalPerPair,
        config.maxLeverage,
      );

      logger.info({
        pair, symbolA, symbolB,
        priceA: tickerA.last, priceB: tickerB.last,
        ctSizeA, ctSizeB,
        pricePerContractA, pricePerContractB,
        legASize: sizing.legASize, legBSize: sizing.legBSize,
      }, 'Sizing calculated');

      if (sizing.legASize <= 0 || sizing.legBSize <= 0) {
        logger.warn({ pair, sizing }, 'Sizing produced zero size — skipping');
        return;
      }

      // Determine sides based on direction
      // SHORT_SPREAD: sell A, buy B
      // LONG_SPREAD: buy A, sell B
      const sideA = direction === 'SHORT_SPREAD' ? 'sell' : 'buy';
      const sideB = direction === 'SHORT_SPREAD' ? 'buy' : 'sell';

      const result = await executePairTrade(
        exchangeAdapter,
        queries,
        {
          instrument: instrumentA,
          side: sideA as 'buy' | 'sell',
          size: sizing.legASize,
          leverage: config.maxLeverage,
        },
        {
          instrument: instrumentB,
          side: sideB as 'buy' | 'sell',
          size: sizing.legBSize,
          leverage: config.maxLeverage,
        },
        direction,
        zScore,
        spread,
        signalId,
        groupId,
      );

      if (result.success && result.positionId) {
        queries.markSignalActedOn(signalId);
        const position = queries.getPosition(result.positionId);
        if (position) {
          await notifications.positionOpened(position);
        }
        logger.info({ pair, positionId: result.positionId }, 'Auto-trade executed');
      } else {
        logger.warn({ pair, error: result.error }, 'Auto-trade failed');
        await notifications.errorAlert(`Auto-trade failed for ${pair}: ${result.error}`, 'auto-trade');
      }
    } catch (err) {
      logger.error({ pair, error: err }, 'Auto-trade error');
      await notifications.errorAlert(`Auto-trade error for ${pair}: ${err}`, 'auto-trade');
    }
  }

  // ═══ Manual Trade Helpers ═══

  async function manualOpenPair(pair: string): Promise<string> {
    // Find the latest signal for this pair
    const config = getTradingConfig();
    const signals = queries.getRecentSignals(pair, config.cooldownMs);
    if (signals.length === 0) {
      return `No recent signal for ${pair}. Run /scan first.`;
    }
    const latest = signals[0];
    await tryAutoTrade(latest.id, pair, latest.direction, latest.z_score, latest.spread);
    return `Attempted to open ${pair} (${latest.direction})`;
  }

  async function manualClosePair(pair: string): Promise<string> {
    const position = queries.getActivePositionByPair(pair);
    if (!position) {
      return `No active position for ${pair}`;
    }

    const result = await closePairPosition(exchangeAdapter, queries, position, 'MANUAL');
    if (result.success) {
      const closed = queries.getPosition(position.id);
      if (closed) await notifications.positionClosed(closed);
      return `Position ${pair} closed successfully`;
    }
    return `Failed to close ${pair}: ${result.error}`;
  }

  // ═══ 3. Start Scanner Scheduler ═══
  const scanIntervalMs = tradingConfig.scanIntervalMs;
  logger.info({ intervalMs: scanIntervalMs }, 'Starting scanner scheduler');

  const scannerInterval = setInterval(async () => {
    try {
      await runFullScan();
    } catch (err) {
      logger.error({ error: err }, 'Scheduled scan error');
    }
  }, scanIntervalMs);

  cleanupAndRegister('scannerInterval', scannerInterval);

  // Run initial scan after startup guard
  setTimeout(async () => {
    logger.info('Running initial scan...');
    try {
      await runFullScan();
    } catch (err) {
      logger.error({ error: err }, 'Initial scan failed');
    }
  }, STARTUP_GUARD_MS + 5000);

  // ═══ 4. Start Spread Monitor ═══
  const SPREAD_CHECK_MS = 60_000; // Check spreads every 60 seconds
  logger.info({ intervalMs: SPREAD_CHECK_MS }, 'Starting spread monitor');

  const spreadMonitorInterval = setInterval(async () => {
    try {
      const updates = await checkSpreads(
        queries,
        exchangeAdapter,
        (pair: string) => betaCache.get(pair) ?? 1,
        (symbol: string) => priceCache.get(symbol) ?? [],
      );

      // Process exits
      for (const update of updates) {
        if (update.action === 'EXIT_TP' || update.action === 'EXIT_SL') {
          const position = queries.getPosition(update.positionId);
          if (!position) continue;

          const reason = update.action === 'EXIT_TP' ? 'TP' : 'SL';
          await notifications.positionClosing(position);

          const result = await closePairPosition(exchangeAdapter, queries, position, reason);
          if (result.success) {
            const closed = queries.getPosition(update.positionId);
            if (closed) await notifications.positionClosed(closed);
          } else {
            await notifications.errorAlert(
              `Failed to close ${update.pair} (${reason}): ${result.error}`,
              'spread-monitor',
            );
          }
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Spread monitor error');
    }
  }, SPREAD_CHECK_MS);

  cleanupAndRegister('spreadMonitor', spreadMonitorInterval);

  // ═══ 5. Start Reconciliation ═══
  const reconIntervalMs = tradingConfig.reconciliationIntervalMs;
  logger.info({ intervalMs: reconIntervalMs }, 'Starting reconciliation');

  const reconInterval = setInterval(async () => {
    try {
      const discrepancies = await reconcile(queries, exchangeAdapter);
      if (discrepancies.length > 0) {
        await notifications.errorAlert(
          `Reconciliation: ${discrepancies.length} discrepancies found`,
          'reconciliation',
        );
      }
    } catch (err) {
      logger.error({ error: err }, 'Reconciliation error');
    }
  }, reconIntervalMs);

  cleanupAndRegister('reconciliation', reconInterval);

  // ═══ 6. Start Orphan Detector ═══
  const ORPHAN_CHECK_MS = 600_000; // Check every 10 minutes
  logger.info({ intervalMs: ORPHAN_CHECK_MS }, 'Starting orphan detector');

  const orphanInterval = setInterval(async () => {
    try {
      const orphans = await detectOrphans(queries, exchangeAdapter);
      if (orphans.length > 0) {
        await notifications.orphanAlert(orphans);
      }
    } catch (err) {
      logger.error({ error: err }, 'Orphan detector error');
    }
  }, ORPHAN_CHECK_MS);

  cleanupAndRegister('orphanDetector', orphanInterval);

  // ═══ 7. Start PnL Report (Telegram, Thai format) ═══
  const pnlReportIntervalMs = tradingConfig.pnlReportIntervalMs;
  if (pnlReportIntervalMs > 0) {
    logger.info({ intervalMs: pnlReportIntervalMs }, 'Starting PnL report notifications');

    const pnlReportInterval = setInterval(async () => {
      try {
        const [exchangePositions, balance, pairPositions] = await Promise.all([
          exchangeAdapter.fetchPositions(),
          exchangeAdapter.fetchBalance(),
          Promise.resolve(queries.getOpenPositions()),
        ]);
        const realized = queries.getRealizedPnl();
        const message = buildPnLReport(
          {
            pairPositions,
            exchangePositions,
            totalBalance: balance.totalEquity,
            realizedPnl: realized.total,
          },
          queries,
        );
        await notifications.pnlReport(message);
      } catch (err) {
        logger.error({ error: err }, 'PnL report error');
      }
    }, pnlReportIntervalMs);

    cleanupAndRegister('pnlReport', pnlReportInterval);

    // Run first report after 60s (avoid startup flood)
    setTimeout(async () => {
      try {
        const [exchangePositions, balance, pairPositions] = await Promise.all([
          exchangeAdapter.fetchPositions(),
          exchangeAdapter.fetchBalance(),
          Promise.resolve(queries.getOpenPositions()),
        ]);
        const realized = queries.getRealizedPnl();
        const message = buildPnLReport(
          {
            pairPositions,
            exchangePositions,
            totalBalance: balance.totalEquity,
            realizedPnl: realized.total,
          },
          queries,
        );
        await notifications.pnlReport(message);
      } catch (err) {
        logger.error({ error: err }, 'Initial PnL report error');
      }
    }, 60000);
  } else {
    logger.info('PnL report disabled (pnlReportIntervalMs = 0)');
  }

  // ═══ System Ready ═══
  logger.info('Pair Trading System started successfully');
  logger.info({
    startupTime: new Date(startupTime).toISOString(),
    startupGuardUntil: new Date(startupTime + STARTUP_GUARD_MS).toISOString(),
    openPositions: restoredPositions.length,
    scanInterval: `${scanIntervalMs / 1000}s`,
    spreadMonitor: `${SPREAD_CHECK_MS / 1000}s`,
    reconciliation: `${reconIntervalMs / 1000}s`,
    orphanDetector: `${ORPHAN_CHECK_MS / 1000}s`,
  }, 'System ready — all monitors active');
}

main().catch(err => {
  logger.fatal({ error: err }, 'Fatal error starting system');
  process.exit(1);
});
