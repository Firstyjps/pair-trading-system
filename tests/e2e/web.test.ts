import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createApiRouter } from '../../src/web/routes/api.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { TradingQueries } from '../../src/db/queries.js';
import { resetConfigForTesting, loadTradingConfig } from '../../src/config.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

let server: Server;
let baseUrl: string;
let db: ReturnType<typeof initializeDatabase>;
let queries: TradingQueries;

beforeAll(() => {
  resetConfigForTesting();
  loadTradingConfig(); // defaults

  db = initializeDatabase(':memory:');
  queries = new TradingQueries(db);

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(queries, null));

  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    db.close();
  });
});

beforeEach(() => {
  resetConfigForTesting();
  loadTradingConfig();
});

describe('GET /api/overview', () => {
  it('should return 200 with overview data', async () => {
    const res = await fetch(`${baseUrl}/api/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalEquity');
    expect(body).toHaveProperty('realizedPnl');
    expect(body).toHaveProperty('openPairs');
  });
});

describe('GET /api/config', () => {
  it('should return 200 with config data', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('config');
    expect(body.config).toHaveProperty('entryZScore');
  });
});

describe('POST /api/config', () => {
  it('should return 401 when no auth token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryZScore: 2.5 }),
    });
    expect(res.status).toBe(401);
  });

  it('should return 401 when CONFIG_SECRET is not set', async () => {
    // CONFIG_SECRET is not set in test env
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Config-Token': 'any-token',
      },
      body: JSON.stringify({ entryZScore: 2.5 }),
    });
    expect(res.status).toBe(401);
  });

  it('should return 401 when token does not match', async () => {
    const originalSecret = process.env.CONFIG_SECRET;
    process.env.CONFIG_SECRET = 'test-secret-123';
    try {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Config-Token': 'wrong-token',
        },
        body: JSON.stringify({ entryZScore: 2.5 }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (originalSecret === undefined) delete process.env.CONFIG_SECRET;
      else process.env.CONFIG_SECRET = originalSecret;
    }
  });

  it('should return 200 when valid token is provided via X-Config-Token', async () => {
    const originalSecret = process.env.CONFIG_SECRET;
    process.env.CONFIG_SECRET = 'test-secret-123';
    try {
      const res = await fetch(`${baseUrl}/api/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Config-Token': 'test-secret-123',
        },
        body: JSON.stringify({ entryZScore: 2.5 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.entryZScore).toBe(2.5);
    } finally {
      if (originalSecret === undefined) delete process.env.CONFIG_SECRET;
      else process.env.CONFIG_SECRET = originalSecret;
    }
  });

  it('should return 200 when valid token is provided via Authorization Bearer', async () => {
    const originalSecret = process.env.CONFIG_SECRET;
    process.env.CONFIG_SECRET = 'bearer-secret';
    try {
      resetConfigForTesting();
      loadTradingConfig();
      const res = await fetch(`${baseUrl}/api/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer bearer-secret',
        },
        body: JSON.stringify({ exitZScore: 0.3 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.exitZScore).toBe(0.3);
    } finally {
      if (originalSecret === undefined) delete process.env.CONFIG_SECRET;
      else process.env.CONFIG_SECRET = originalSecret;
    }
  });
});

describe('GET /api/positions', () => {
  it('should return 200 with positions array', async () => {
    const res = await fetch(`${baseUrl}/api/positions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('positions');
    expect(Array.isArray(body.positions)).toBe(true);
  });
});

describe('GET /api/signals', () => {
  it('should return 200 with signals array', async () => {
    const res = await fetch(`${baseUrl}/api/signals`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('signals');
  });
});

describe('GET /api/spread/:pair (validation)', () => {
  it('should return 400 for invalid pair format', async () => {
    const res = await fetch(`${baseUrl}/api/spread/${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(res.status).toBe(400);
  });

  it('should return 200 for valid pair format', async () => {
    const res = await fetch(`${baseUrl}/api/spread/${encodeURIComponent('BTC/ETH')}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/backtest/run (validation)', () => {
  it('should return 400 when pair is missing', async () => {
    const res = await fetch(`${baseUrl}/api/backtest/run`);
    expect(res.status).toBe(400);
  });

  it('should return 400 for invalid pair format', async () => {
    const res = await fetch(`${baseUrl}/api/backtest/run?pair=INVALID`);
    expect(res.status).toBe(400);
  });
});
