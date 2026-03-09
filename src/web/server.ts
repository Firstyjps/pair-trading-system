import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import { TradingQueries } from '../db/queries.js';
import { loadTradingConfig } from '../config.js';
import { createApiRouter } from './routes/api.js';
import { createOkxAdapter, type OkxAdapter } from '../exchange/okx-adapter.js';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.WEB_PORT ?? '3000', 10);
const DB_PATH = process.env.DB_PATH ?? './data/trading.db';

// Load config (defaults if no file)
try { loadTradingConfig('./config.json'); } catch { loadTradingConfig(); }

// Initialize DB
const db = initializeDatabase(DB_PATH);
runMigrations(db);
const queries = new TradingQueries(db);

// Optionally initialize OKX adapter for live account data
let exchange: OkxAdapter | null = null;

async function initExchange(): Promise<OkxAdapter | null> {
  const { OKX_API_KEY, OKX_SECRET, OKX_PASSPHRASE, OKX_SANDBOX } = process.env;
  if (!OKX_API_KEY || !OKX_SECRET || !OKX_PASSPHRASE) {
    logger.warn('OKX API keys not found — dashboard will run without live account data');
    return null;
  }
  try {
    const adapter = await createOkxAdapter({
      apiKey: OKX_API_KEY,
      secret: OKX_SECRET,
      passphrase: OKX_PASSPHRASE,
      sandbox: OKX_SANDBOX === 'true',
    });
    logger.info('OKX adapter initialized for dashboard');
    return adapter;
  } catch (err) {
    logger.warn({ error: err }, 'Failed to initialize OKX adapter — dashboard will run without live account data');
    return null;
  }
}

// Start server
(async () => {
  exchange = await initExchange();

  const app = express();
  app.use(express.json());

  // Serve static frontend
  app.use(express.static(path.join(__dirname, 'public')));

  // API routes
  app.use('/api', createApiRouter(queries, exchange));

  // SPA fallback (Express 5 syntax)
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => {
    logger.info({ port: PORT, db: DB_PATH, exchange: exchange ? 'connected' : 'none' }, `Dashboard running at http://localhost:${PORT}`);
  });
})();
