import pino from 'pino';
import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || './data/logs';
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);

// Ensure log directory exists
if (process.env.NODE_ENV === 'production' || process.env.LOG_TO_FILE === 'true') {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* ignore if already exists */ }
}

function buildTransport(): pino.TransportSingleOptions | pino.TransportMultiOptions | undefined {
  const isProduction = process.env.NODE_ENV === 'production';
  const logToFile = process.env.LOG_TO_FILE === 'true';

  if (isProduction || logToFile) {
    // Production: log to file with daily rotation + stdout
    const logFile = path.join(LOG_DIR, 'pair-bot.log');
    return {
      targets: [
        {
          target: 'pino/file',
          options: { destination: logFile, mkdir: true },
          level: process.env.LOG_LEVEL || 'info',
        },
        {
          target: 'pino-pretty',
          options: { colorize: false, destination: 1 }, // stdout
          level: process.env.LOG_LEVEL || 'info',
        },
      ],
    } as pino.TransportMultiOptions;
  }

  // Development: pino-pretty to stdout
  return { target: 'pino-pretty', options: { colorize: true } };
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: buildTransport(),
});

export function createChildLogger(module: string) {
  return logger.child({ module });
}

/**
 * Rotate log files: rename current log, delete old logs beyond retention.
 * Call this daily (e.g., via cron or setInterval).
 */
export function rotateLogs(): { rotated: boolean; cleaned: number } {
  const logFile = path.join(LOG_DIR, 'pair-bot.log');
  let rotated = false;
  let cleaned = 0;

  try {
    // Rotate current log file
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > 0) {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const rotatedName = path.join(LOG_DIR, `pair-bot.${date}.log`);
        // Don't overwrite existing rotation for today
        if (!fs.existsSync(rotatedName)) {
          fs.copyFileSync(logFile, rotatedName);
          fs.writeFileSync(logFile, ''); // Truncate current
          rotated = true;
        }
      }
    }

    // Clean old rotated logs
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('pair-bot.') || !file.endsWith('.log')) continue;
      if (file === 'pair-bot.log') continue; // Skip current log

      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }
  } catch (err) {
    // Best-effort — don't crash the system for log rotation
    logger.warn({ error: err }, 'Log rotation error');
  }

  if (rotated || cleaned > 0) {
    logger.info({ rotated, cleaned }, 'Log rotation completed');
  }

  return { rotated, cleaned };
}
