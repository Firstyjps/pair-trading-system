import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from './logger.js';

const log = createChildLogger('config');

const TradingConfigSchema = z.object({
  // Scanner
  correlationThreshold: z.number().min(0).max(1).default(0.75),
  cointegrationPValue: z.number().min(0).max(1).default(0.05),
  lookbackPeriods: z.number().int().min(24).default(168),

  // Entry/Exit
  entryZScore: z.number().positive().default(2.0),
  exitZScore: z.number().min(0).default(0.5),
  stopLossZScore: z.number().positive().default(3.0),
  safeZoneBuffer: z.number().min(0).default(0.5),

  // Risk
  autoTradingEnabled: z.boolean().default(true),
  lossAlertThresholdUsd: z.number().min(0).default(50),
  lossAlertThresholdPct: z.number().min(0).max(100).default(10),
  circuitBreakerLosses: z.number().int().min(0).default(3),
  circuitBreakerCooldownMs: z.number().int().min(0).default(3600000),
  trailingStopEnabled: z.boolean().default(false),
  trailingStopZ: z.number().positive().default(1.5),
  partialTPPercent: z.number().min(0).max(100).default(0),
  maxLeverage: z.number().int().min(1).max(20).default(5).refine(v => v <= 20, {
    message: 'Hard cap: max leverage is 20x',
  }),
  maxCapitalPerPair: z.number().positive().max(5000).default(300),
  maxOpenPairs: z.number().int().positive().max(20).default(8),

  // Timing
  cooldownMs: z.number().int().positive().default(3600000),
  gracePeriodMs: z.number().int().positive().default(300000),
  reconciliationIntervalMs: z.number().int().positive().default(300000),
  scanIntervalMs: z.number().int().positive().default(3600000),
  pnlReportIntervalMs: z.number().int().min(0).default(300000), // 0 = disabled
  weeklySummaryCron: z.string().default('0 9 * * 1'),
  monthlySummaryCron: z.string().default('0 9 1 * *'),
  webhookUrl: z.string().optional(),
  dbBackupPath: z.string().default('./data/backups'),

  // Smart entry/exit
  /** Minimum bars to hold before allowing TP exit (prevent instant close) */
  minHoldBarsTP: z.number().int().min(0).default(3),
  /** Minimum expected profit as multiple of fees before entering (e.g. 2.0 = need 2x fees profit) */
  minProfitMultiplier: z.number().min(0).default(2.0),
  /** Fee rate per side (entry + exit = 2x this) */
  feeRate: z.number().min(0).default(0.0006),

  // Dedup
  signalDedup: z.boolean().default(true),
  notificationTTL: z.number().int().positive().default(300000),

  // Sizing
  sizingMethod: z.enum([
    'dollar-neutral',
    'kelly',
    'fixed-fraction',
    'volatility-scaled',
    'equal-weight',
  ]).default('dollar-neutral'),
  fixedFractionPercent: z.number().min(0.01).max(1).default(0.1),

  // Timeframe
  primaryTimeframe: z.enum(['1h', '4h']).default('1h'),

  // Target pairs — when set, skip full scan and only trade these pairs
  // Format: ["PEPE/SHIB", "ETH/BTC"] (base names, not full ccxt symbols)
  targetPairs: z.array(z.string().regex(/^[A-Z0-9]+\/[A-Z0-9]+$/, 'Pair format must be "BASE_A/BASE_B"'))
    .optional(),
});

export type TradingConfig = z.infer<typeof TradingConfigSchema>;

const EnvConfigSchema = z.object({
  OKX_API_KEY: z.string().min(1),
  OKX_SECRET: z.string().min(1),
  OKX_PASSPHRASE: z.string().min(1),
  OKX_SANDBOX: z.string().transform(v => v === 'true').default('true'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  DB_PATH: z.string().default('./data/trading.db'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DEFAULT_LEVERAGE: z.string().transform(Number).pipe(z.number().int().min(1).max(20)).default('5'),
  MAX_CAPITAL_PER_PAIR: z.string().transform(Number).pipe(z.number().positive()).default('300'),
  MAX_OPEN_PAIRS: z.string().transform(Number).pipe(z.number().int().positive()).default('8'),
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

let _tradingConfig: TradingConfig | null = null;
let _envConfig: EnvConfig | null = null;

export function loadEnvConfig(): EnvConfig {
  if (_envConfig) return _envConfig;

  const result = EnvConfigSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    log.error({ errors }, 'Invalid environment configuration');
    throw new Error(`Invalid environment config:\n${errors.join('\n')}`);
  }

  _envConfig = result.data;
  log.info({ sandbox: _envConfig.OKX_SANDBOX }, 'Environment config loaded');
  return _envConfig;
}

export function loadTradingConfig(configPath?: string): TradingConfig {
  if (_tradingConfig) return _tradingConfig;

  let rawConfig: Record<string, unknown> = {};

  if (configPath && fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      rawConfig = JSON.parse(content);
      log.info({ path: configPath }, 'Trading config loaded from file');
    } catch (err) {
      log.error({ path: configPath, error: err }, 'Failed to load trading config file');
      throw err;
    }
  } else {
    log.warn('No trading config file found, using defaults (should be from backtest output)');
  }

  // Override with env vars if present
  const env = process.env;
  if (env.DEFAULT_LEVERAGE) rawConfig.maxLeverage = Number(env.DEFAULT_LEVERAGE);
  if (env.MAX_CAPITAL_PER_PAIR) rawConfig.maxCapitalPerPair = Number(env.MAX_CAPITAL_PER_PAIR);
  if (env.MAX_OPEN_PAIRS) rawConfig.maxOpenPairs = Number(env.MAX_OPEN_PAIRS);

  const result = TradingConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    log.error({ errors }, 'Invalid trading configuration');
    throw new Error(`Invalid trading config:\n${errors.join('\n')}`);
  }

  // Hard enforce leverage cap
  if (result.data.maxLeverage > 20) {
    log.warn({ requested: result.data.maxLeverage }, 'Leverage exceeds hard cap of 20x, clamping');
    result.data.maxLeverage = 20;
  }

  // Validate entry/SL relationship
  if (result.data.entryZScore + result.data.safeZoneBuffer >= result.data.stopLossZScore) {
    log.warn(
      { entry: result.data.entryZScore, buffer: result.data.safeZoneBuffer, sl: result.data.stopLossZScore },
      'Entry + buffer >= SL — positions will open too close to stop loss'
    );
  }

  _tradingConfig = result.data;
  return _tradingConfig;
}

export function updateTradingConfig(updates: Partial<TradingConfig>): TradingConfig {
  const current = _tradingConfig ?? loadTradingConfig();
  const merged = { ...current, ...updates };

  const result = TradingConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid config update: ${result.error.issues.map(i => i.message).join(', ')}`);
  }

  if (result.data.maxLeverage > 20) {
    result.data.maxLeverage = 20;
  }

  _tradingConfig = result.data;
  log.info({ updates: Object.keys(updates) }, 'Trading config updated');
  return _tradingConfig;
}

export function getTradingConfig(): TradingConfig {
  if (!_tradingConfig) return loadTradingConfig();
  return _tradingConfig;
}

export async function loadTradingConfigAsync(configPath?: string): Promise<TradingConfig> {
  if (_tradingConfig) return _tradingConfig;

  let rawConfig: Record<string, unknown> = {};

  if (configPath) {
    try {
      const content = await fs.promises.readFile(configPath, 'utf-8');
      rawConfig = JSON.parse(content);
      log.info({ path: configPath }, 'Trading config loaded from file (async)');
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ path: configPath, error: err }, 'Failed to load trading config file');
        throw err;
      }
      log.warn('No trading config file found, using defaults');
    }
  }

  // Delegate to sync parser for validation
  return _applyTradingConfig(rawConfig);
}

function _applyTradingConfig(rawConfig: Record<string, unknown>): TradingConfig {
  const env = process.env;
  if (env.DEFAULT_LEVERAGE) rawConfig.maxLeverage = Number(env.DEFAULT_LEVERAGE);
  if (env.MAX_CAPITAL_PER_PAIR) rawConfig.maxCapitalPerPair = Number(env.MAX_CAPITAL_PER_PAIR);
  if (env.MAX_OPEN_PAIRS) rawConfig.maxOpenPairs = Number(env.MAX_OPEN_PAIRS);

  const result = TradingConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    log.error({ errors }, 'Invalid trading configuration');
    throw new Error(`Invalid trading config:\n${errors.join('\n')}`);
  }

  if (result.data.maxLeverage > 20) {
    log.warn({ requested: result.data.maxLeverage }, 'Leverage exceeds hard cap of 20x, clamping');
    result.data.maxLeverage = 20;
  }

  if (result.data.entryZScore + result.data.safeZoneBuffer >= result.data.stopLossZScore) {
    log.warn(
      { entry: result.data.entryZScore, buffer: result.data.safeZoneBuffer, sl: result.data.stopLossZScore },
      'Entry + buffer >= SL — positions will open too close to stop loss'
    );
  }

  _tradingConfig = result.data;
  return _tradingConfig;
}

export function resetConfigForTesting(): void {
  _tradingConfig = null;
  _envConfig = null;
}
