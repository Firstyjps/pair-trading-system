import { createChildLogger } from './logger.js';

const log = createChildLogger('lifecycle');

const GLOBAL_KEY = '__pair_trading_system__';

interface SystemInstances {
  scheduler: ReturnType<typeof setInterval> | null;
  telegramBot: unknown | null;
  orphanDetector: ReturnType<typeof setInterval> | null;
  reconciliation: ReturnType<typeof setInterval> | null;
  spreadMonitor: ReturnType<typeof setInterval> | null;
  scannerInterval: ReturnType<typeof setInterval> | null;
  pnlReport: ReturnType<typeof setInterval> | null;
  startupTime: number;
}

function getGlobal(): SystemInstances {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      scheduler: null,
      telegramBot: null,
      orphanDetector: null,
      reconciliation: null,
      spreadMonitor: null,
      scannerInterval: null,
      pnlReport: null,
      startupTime: Date.now(),
    };
  }
  return g[GLOBAL_KEY] as SystemInstances;
}

export function cleanupAndRegister<K extends keyof SystemInstances>(
  key: K,
  instance: SystemInstances[K],
  cleanupFn?: (old: NonNullable<SystemInstances[K]>) => void
): void {
  const g = getGlobal();

  if (g[key] !== null && g[key] !== undefined) {
    log.info({ key }, 'Cleaning up existing instance before registering new one');

    if (cleanupFn) {
      cleanupFn(g[key] as NonNullable<SystemInstances[K]>);
    } else if (typeof g[key] === 'object' && g[key] !== null) {
      // Default cleanup: try clearInterval
      try {
        clearInterval(g[key] as unknown as ReturnType<typeof setInterval>);
      } catch {
        // ignore
      }
    }
  }

  g[key] = instance;
  log.debug({ key }, 'Instance registered');
}

export function getInstance<K extends keyof SystemInstances>(key: K): SystemInstances[K] {
  return getGlobal()[key];
}

export function getStartupTime(): number {
  return getGlobal().startupTime;
}

export function cleanupAll(): void {
  const g = getGlobal();

  for (const key of Object.keys(g) as (keyof SystemInstances)[]) {
    if (key === 'startupTime') continue;

    if (g[key] !== null) {
      log.info({ key }, 'Cleaning up instance');
      try {
        if (key === 'telegramBot') {
          const bot = g[key] as { stop?: () => void };
          if (bot && typeof bot.stop === 'function') {
            bot.stop();
          }
        } else {
          clearInterval(g[key] as unknown as ReturnType<typeof setInterval>);
        }
      } catch {
        // ignore cleanup errors
      }
      g[key] = null;
    }
  }

  log.info('All instances cleaned up');
}

export function isSystemRunning(): boolean {
  const g = getGlobal();
  return g.scheduler !== null || g.spreadMonitor !== null;
}

// Graceful shutdown handler
export function registerShutdownHandlers(onShutdown: () => void | Promise<void>): void {
  const handler = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    try {
      await onShutdown();
      cleanupAll();
    } catch (err) {
      log.error({ error: err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
