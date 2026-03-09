import type { FullExchangeAdapter, ExchangeOrderResult } from '../trader/order-executor.js';
import type { SpreadMonitorExchange } from '../monitor/spread-monitor.js';
import type { ReconciliationExchange, ExchangePosition } from '../monitor/reconciliation.js';
import type { DataFetcherExchange, MarketInfo } from '../scanner/data-fetcher.js';
import type { OrderParams } from '../types.js';
import { createChildLogger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';

const log = createChildLogger('okx-adapter');

/**
 * Unified OKX adapter using ccxt.
 * Implements all exchange interfaces needed by the system.
 */
export class OkxAdapter
  implements FullExchangeAdapter, SpreadMonitorExchange, ReconciliationExchange, DataFetcherExchange
{
  private exchange: any; // ccxt.okx instance

  constructor(private ccxtInstance: any) {
    this.exchange = ccxtInstance;
  }

  // ─── Helpers ───

  /** Convert OKX native ID (BTC-USDT-SWAP) to ccxt symbol (BTC/USDT:USDT) */
  private toSymbol(instrument: string): string {
    // BTC-USDT-SWAP → BTC/USDT:USDT
    const base = instrument.replace('-USDT-SWAP', '');
    return `${base}/USDT:USDT`;
  }

  /** Convert ccxt symbol (BTC/USDT:USDT) to OKX native ID (BTC-USDT-SWAP) */
  private toInstrument(symbol: string): string {
    // BTC/USDT:USDT → BTC-USDT-SWAP
    const base = symbol.replace('/USDT:USDT', '');
    return `${base}-USDT-SWAP`;
  }

  // ─── FullExchangeAdapter (order-executor.ts + rollback.ts) ───

  async createOrder(params: OrderParams): Promise<ExchangeOrderResult> {
    const symbol = this.toSymbol(params.instrument);
    try {
      log.info({ symbol, side: params.side, size: params.size, leverage: params.leverage }, 'Creating order');

      const clientOrderId = uuidv4().replace(/-/g, '').slice(0, 32);

      const order = await this.exchange.createOrder(
        symbol,
        'market',
        params.side,
        params.size,
        undefined, // price — market order
        {
          tdMode: 'cross',     // Cross-margin mode for swaps
          reduceOnly: params.reduceOnly ?? false,
          clOrdId: clientOrderId,
        },
      );

      // OKX market orders may not have avgPrice immediately — fetch order to get fill price
      let avgPrice = order.average ?? order.price ?? 0;
      if ((!avgPrice || avgPrice === 0) && order.id) {
        try {
          await new Promise(r => setTimeout(r, 500)); // wait for fill
          const fetched = await this.exchange.fetchOrder(order.id, symbol);
          avgPrice = fetched.average ?? fetched.price ?? 0;
          log.info({ orderId: order.id, fetchedAvgPrice: avgPrice }, 'Fetched fill price');
        } catch (fetchErr: any) {
          log.warn({ orderId: order.id, error: fetchErr.message }, 'Could not fetch fill price');
        }
      }

      log.info({ orderId: order.id, symbol, side: params.side, avgPrice }, 'Order created');
      return {
        success: true,
        orderId: order.id,
        avgPrice,
      };
    } catch (err: any) {
      log.error({ symbol, side: params.side, error: err.message }, 'Order creation failed');
      return { success: false, error: err.message };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    try {
      await this.exchange.setLeverage(leverage, ccxtSymbol, { mgnMode: 'cross' });
      log.info({ symbol: ccxtSymbol, leverage }, 'Leverage set');
    } catch (err: any) {
      // Some exchanges return errors if leverage is already set — log but don't throw
      if (err.message?.includes('leverage not modified') || err.message?.includes('No need to change')) {
        log.debug({ symbol: ccxtSymbol, leverage }, 'Leverage already set');
      } else {
        log.error({ symbol: ccxtSymbol, leverage, error: err.message }, 'Failed to set leverage');
        throw err;
      }
    }
  }

  async getPosition(symbol: string): Promise<{ size: number; side: string } | null> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    try {
      const positions = await this.exchange.fetchPositions([ccxtSymbol]);
      const pos = positions.find((p: any) => p.contracts > 0 || Math.abs(p.contractSize ?? 0) > 0);
      if (!pos || pos.contracts === 0) return null;
      return {
        size: pos.contracts,
        side: pos.side ?? (pos.contracts > 0 ? 'long' : 'short'),
      };
    } catch (err: any) {
      log.error({ symbol: ccxtSymbol, error: err.message }, 'Failed to fetch position');
      return null;
    }
  }

  async closePosition(
    symbol: string,
    side: 'buy' | 'sell',
    size: number,
  ): Promise<{ success: boolean; orderId?: string; avgPrice?: number; error?: string }> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    try {
      log.info({ symbol: ccxtSymbol, side, size }, 'Closing position');
      const order = await this.exchange.createOrder(
        ccxtSymbol,
        'market',
        side,
        size,
        undefined,
        {
          tdMode: 'cross',
          reduceOnly: true,
        },
      );

      // Fetch fill price for P&L calculation
      let avgPrice = order.average ?? order.price ?? 0;
      if ((!avgPrice || avgPrice === 0) && order.id) {
        try {
          await new Promise(r => setTimeout(r, 500));
          const fetched = await this.exchange.fetchOrder(order.id, ccxtSymbol);
          avgPrice = fetched.average ?? fetched.price ?? 0;
        } catch (fetchErr: any) {
          log.warn({ orderId: order.id, error: fetchErr.message }, 'Could not fetch close fill price');
        }
      }

      log.info({ orderId: order.id, symbol: ccxtSymbol, avgPrice }, 'Close order created');
      return { success: true, orderId: order.id, avgPrice };
    } catch (err: any) {
      log.error({ symbol: ccxtSymbol, error: err.message }, 'Failed to close position');
      return { success: false, error: err.message };
    }
  }

  // ─── SpreadMonitorExchange ───

  async fetchTicker(symbol: string): Promise<{ last: number }> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    const ticker = await this.exchange.fetchTicker(ccxtSymbol);
    return { last: ticker.last ?? ticker.close ?? 0 };
  }

  // ─── ReconciliationExchange ───

  async fetchPositions(): Promise<ExchangePosition[]> {
    try {
      const positions = await this.exchange.fetchPositions();
      return positions
        .filter((p: any) => p.contracts > 0)
        .map((p: any) => ({
          symbol: this.toInstrument(p.symbol),
          side: p.side ?? 'long',
          size: p.contracts,
          avgPrice: p.entryPrice ?? 0,
          unrealizedPnl: p.unrealizedPnl ?? 0,
        }));
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to fetch all positions');
      return [];
    }
  }

  /** Get contract size (ctVal) for a symbol — e.g. ETH-USDT-SWAP → 0.1 */
  async getContractSize(symbol: string): Promise<number> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    try {
      await this.exchange.loadMarkets();
      const market = this.exchange.market(ccxtSymbol);
      return market?.contractSize ?? 1;
    } catch (err: any) {
      log.warn({ symbol, error: err.message }, 'Could not get contract size, defaulting to 1');
      return 1;
    }
  }

  /** Fetch fill price for an order by its ID */
  async fetchOrderFillPrice(orderId: string, symbol: string): Promise<number> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    try {
      const order = await this.exchange.fetchOrder(orderId, ccxtSymbol);
      return order.average ?? order.price ?? 0;
    } catch (err: any) {
      log.warn({ orderId, symbol, error: err.message }, 'Could not fetch order fill price');
      return 0;
    }
  }

  /** Fetch recent closed orders for a symbol to find exit fills */
  async fetchClosedOrders(symbol: string, since?: number, limit?: number): Promise<Array<{
    orderId: string;
    avgPrice: number;
    side: string;
    amount: number;
    timestamp: number;
  }>> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    try {
      const orders = await this.exchange.fetchClosedOrders(ccxtSymbol, since, limit ?? 20);
      return orders.map((o: any) => ({
        orderId: o.id,
        avgPrice: o.average ?? o.price ?? 0,
        side: o.side,
        amount: o.amount ?? o.filled ?? 0,
        timestamp: o.timestamp ?? 0,
      }));
    } catch (err: any) {
      log.warn({ symbol, error: err.message }, 'Could not fetch closed orders');
      return [];
    }
  }

  // ─── Dashboard Data (account, tickers) ───

  async fetchBalance(): Promise<{
    totalEquity: number;
    availableBalance: number;
    unrealizedPnl: number;
    frozenBalance: number;
  }> {
    try {
      const balance = await this.exchange.fetchBalance({ type: 'swap' });
      const usdt = balance?.USDT ?? balance?.info?.data?.[0] ?? {};
      return {
        totalEquity: Number(usdt.total ?? 0),
        availableBalance: Number(usdt.free ?? 0),
        unrealizedPnl: Number(usdt.used ?? 0),
        frozenBalance: Number(balance?.info?.data?.[0]?.frozenBal ?? 0),
      };
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to fetch balance');
      throw err;
    }
  }

  async fetchAccountInfo(): Promise<{
    uid: string;
    accountType: string;
    positionMode: string;
  }> {
    try {
      const config = await this.exchange.privateGetAccountConfig();
      const data = config?.data?.[0] ?? {};
      return {
        uid: data.uid ?? 'unknown',
        accountType: data.acctLv ?? 'unknown',
        positionMode: data.posMode ?? 'unknown',
      };
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to fetch account info');
      throw err;
    }
  }

  async fetchTickers(symbols?: string[]): Promise<Array<{
    symbol: string;
    last: number;
    change24h: number;
  }>> {
    try {
      const ccxtSymbols = symbols?.map(s => {
        if (s.endsWith('-USDT-SWAP')) return this.toSymbol(s);
        if (s.includes('/')) return s;
        return `${s}/USDT:USDT`;
      });
      const tickers = await this.exchange.fetchTickers(ccxtSymbols);
      return Object.values(tickers).map((t: any) => ({
        symbol: (t.symbol as string).split('/')[0],
        last: t.last ?? 0,
        change24h: t.percentage ?? 0,
      }));
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to fetch tickers');
      return [];
    }
  }

  // ─── DataFetcherExchange ───

  async fetchMarkets(): Promise<MarketInfo[]> {
    const markets = await this.exchange.loadMarkets();
    const result: MarketInfo[] = [];

    for (const [symbol, market] of Object.entries(markets) as [string, any][]) {
      if (market.type !== 'swap' || market.quote !== 'USDT') continue;
      result.push({
        id: market.id,           // e.g. BTC-USDT-SWAP
        symbol: market.symbol,   // e.g. BTC/USDT:USDT
        base: market.base,
        quote: market.quote,
        active: market.active ?? true,
        contractSize: market.contractSize ?? 1,
        minSize: market.limits?.amount?.min ?? 1,
      });
    }

    return result;
  }

  async fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<number[][]> {
    const ccxtSymbol = symbol.endsWith('-USDT-SWAP') ? this.toSymbol(symbol) : symbol;
    return await this.exchange.fetchOHLCV(ccxtSymbol, timeframe, since, limit);
  }
}

/**
 * Factory function to create OKX adapter
 */
export async function createOkxAdapter(config: {
  apiKey: string;
  secret: string;
  passphrase: string;
  sandbox: boolean;
}): Promise<OkxAdapter> {
  const ccxt = await import('ccxt');
  const exchange = new ccxt.okx({
    apiKey: config.apiKey,
    secret: config.secret,
    password: config.passphrase,
    enableRateLimit: true,
    options: {
      defaultType: 'swap',
    },
  });

  if (config.sandbox) {
    exchange.setSandboxMode(true);
    log.info('OKX adapter initialized in SANDBOX mode');
  } else {
    log.warn('⚠️  OKX adapter initialized in LIVE mode');
  }

  // Load markets on init
  await exchange.loadMarkets();
  log.info({ marketCount: Object.keys(exchange.markets).length }, 'Markets loaded');

  return new OkxAdapter(exchange);
}
