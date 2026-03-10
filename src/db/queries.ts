import type Database from 'better-sqlite3';
import type {
  PairPosition,
  PositionState,
  Signal,
  ZScoreRecord,
  NotificationRecord,
  BacktestResult,
  CloseReason,
  OHLCVCandle,
} from '../types.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('queries');

export class TradingQueries {
  constructor(private db: Database.Database) {}

  // ─── Position Queries ───

  insertPosition(pos: PairPosition): void {
    const stmt = this.db.prepare(`
      INSERT INTO positions (
        id, pair, direction, state,
        leg_a_symbol, leg_a_side, leg_a_size, leg_a_entry_price, leg_a_order_id,
        leg_b_symbol, leg_b_side, leg_b_size, leg_b_entry_price, leg_b_order_id,
        entry_z_score, entry_spread, current_z_score,
        stop_loss_z, take_profit_z, leverage, margin_per_leg,
        pnl, signal_id, group_id, opened_at, closed_at, close_reason, metadata
      ) VALUES (
        @id, @pair, @direction, @state,
        @leg_a_symbol, @leg_a_side, @leg_a_size, @leg_a_entry_price, @leg_a_order_id,
        @leg_b_symbol, @leg_b_side, @leg_b_size, @leg_b_entry_price, @leg_b_order_id,
        @entry_z_score, @entry_spread, @current_z_score,
        @stop_loss_z, @take_profit_z, @leverage, @margin_per_leg,
        @pnl, @signal_id, @group_id, @opened_at, @closed_at, @close_reason, @metadata
      )
    `);
    stmt.run(pos);
    log.info({ id: pos.id, pair: pos.pair, state: pos.state }, 'Position inserted');
  }

  updatePositionState(
    id: string,
    state: PositionState,
    updates?: Partial<Pick<PairPosition,
      'leg_a_order_id' | 'leg_a_entry_price' |
      'leg_b_order_id' | 'leg_b_entry_price' |
      'current_z_score' | 'pnl' | 'closed_at' | 'close_reason' | 'metadata'
    >>
  ): void {
    const fields: string[] = ['state = @state'];
    const params: Record<string, unknown> = { id, state };

    if (updates) {
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          fields.push(`${key} = @${key}`);
          params[key] = value;
        }
      }
    }

    const sql = `UPDATE positions SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
    log.info({ id, state, updates: updates ? Object.keys(updates) : [] }, 'Position state updated');
  }

  getPosition(id: string): PairPosition | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as PairPosition | undefined;
  }

  getOpenPositions(): PairPosition[] {
    return this.db.prepare(
      `SELECT * FROM positions WHERE state NOT IN ('CLOSED', 'ERROR') ORDER BY opened_at DESC`
    ).all() as PairPosition[];
  }

  getActivePositionByPair(pair: string): PairPosition | undefined {
    return this.db.prepare(
      `SELECT * FROM positions WHERE pair = ? AND state NOT IN ('CLOSED', 'ERROR') LIMIT 1`
    ).get(pair) as PairPosition | undefined;
  }

  hasOpenPosition(pair: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM positions WHERE pair = ? AND state NOT IN ('CLOSED', 'ERROR') LIMIT 1`
    ).get(pair);
    return !!row;
  }

  getLastClosedTime(pair: string): number | null {
    const row = this.db.prepare(
      `SELECT closed_at FROM positions WHERE pair = ? AND state = 'CLOSED' ORDER BY closed_at DESC LIMIT 1`
    ).get(pair) as { closed_at: string } | undefined;
    return row ? new Date(row.closed_at).getTime() : null;
  }

  isGroupIdUsed(groupId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM positions WHERE group_id = ? LIMIT 1`
    ).get(groupId);
    return !!row;
  }

  isSignalIdUsed(signalId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM positions WHERE signal_id = ? LIMIT 1`
    ).get(signalId);
    return !!row;
  }

  getOpenPositionCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM positions WHERE state NOT IN ('CLOSED', 'ERROR')`
    ).get() as { count: number };
    return row.count;
  }

  getClosedPositions(limit: number = 50): PairPosition[] {
    return this.db.prepare(
      `SELECT * FROM positions WHERE state IN ('CLOSED', 'ERROR') ORDER BY closed_at DESC LIMIT ?`
    ).all(limit) as PairPosition[];
  }

  getRecentlyClosedPairs(withinMs: number): string[] {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    return (this.db.prepare(
      `SELECT DISTINCT pair FROM positions WHERE state = 'CLOSED' AND closed_at > ?`
    ).all(cutoff) as { pair: string }[]).map(r => r.pair);
  }

  getRealizedPnl(): { total: number; count: number; wins: number; losses: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(pnl), 0) as total,
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
      FROM positions
      WHERE state = 'CLOSED' AND pnl IS NOT NULL
    `).get() as { total: number; count: number; wins: number; losses: number };
    return row;
  }

  getRealizedPnlSince(cutoff: string): { total: number; count: number; wins: number } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(pnl), 0) as total,
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
      FROM positions
      WHERE state = 'CLOSED' AND pnl IS NOT NULL AND closed_at >= ?
    `).get(cutoff) as { total: number; count: number; wins: number };
    return row;
  }

  getRealizedPnlByPair(): Array<{ pair: string; totalPnl: number; trades: number; wins: number; avgPnl: number }> {
    return this.db.prepare(`
      SELECT
        pair,
        COALESCE(SUM(pnl), 0) as totalPnl,
        COUNT(*) as trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        COALESCE(AVG(pnl), 0) as avgPnl
      FROM positions
      WHERE state = 'CLOSED' AND pnl IS NOT NULL
      GROUP BY pair
      ORDER BY totalPnl DESC
    `).all() as Array<{ pair: string; totalPnl: number; trades: number; wins: number; avgPnl: number }>;
  }

  getEquityCurve(): Array<{ closed_at: string; pnl: number; cumPnl: number }> {
    const rows = this.db.prepare(`
      SELECT closed_at, pnl FROM positions
      WHERE state = 'CLOSED' AND pnl IS NOT NULL AND closed_at IS NOT NULL
      ORDER BY closed_at ASC
    `).all() as Array<{ closed_at: string; pnl: number }>;
    let cum = 0;
    return rows.map(r => { cum += r.pnl; return { closed_at: r.closed_at, pnl: r.pnl, cumPnl: cum }; });
  }

  getConsecutiveLosses(): number {
    const closed = this.db.prepare(
      `SELECT pnl FROM positions WHERE state = 'CLOSED' AND pnl IS NOT NULL ORDER BY closed_at DESC LIMIT 20`
    ).all() as { pnl: number }[];
    let count = 0;
    for (const r of closed) {
      if (r.pnl <= 0) count++;
      else break;
    }
    return count;
  }

  // ─── Signal Queries ───

  insertSignal(signal: Signal): void {
    this.db.prepare(`
      INSERT INTO signals (id, pair, direction, z_score, spread, correlation, cointegration_pvalue, half_life, created_at, acted_on)
      VALUES (@id, @pair, @direction, @z_score, @spread, @correlation, @cointegration_pvalue, @half_life, @created_at, @acted_on)
    `).run({ ...signal, acted_on: signal.acted_on ? 1 : 0 });
    log.debug({ id: signal.id, pair: signal.pair }, 'Signal inserted');
  }

  markSignalActedOn(id: string): void {
    this.db.prepare('UPDATE signals SET acted_on = 1 WHERE id = ?').run(id);
  }

  getUnactedSignals(): Signal[] {
    return (this.db.prepare(
      'SELECT * FROM signals WHERE acted_on = 0 ORDER BY created_at DESC'
    ).all() as (Omit<Signal, 'acted_on'> & { acted_on: number })[]).map(s => ({
      ...s,
      acted_on: !!s.acted_on,
    }));
  }

  getRecentSignals(pair: string, withinMs: number): Signal[] {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    return (this.db.prepare(
      'SELECT * FROM signals WHERE pair = ? AND created_at > ? ORDER BY created_at DESC'
    ).all(pair, cutoff) as (Omit<Signal, 'acted_on'> & { acted_on: number })[]).map(s => ({
      ...s,
      acted_on: !!s.acted_on,
    }));
  }

  // ─── Z-Score History ───

  insertZScoreRecord(record: Omit<ZScoreRecord, 'id'>): void {
    this.db.prepare(`
      INSERT INTO z_score_history (pair, z_score, spread, price_a, price_b, timestamp)
      VALUES (@pair, @z_score, @spread, @price_a, @price_b, @timestamp)
    `).run(record);
  }

  getZScoreHistory(pair: string, limit: number = 1000): ZScoreRecord[] {
    return this.db.prepare(
      'SELECT * FROM z_score_history WHERE pair = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(pair, limit) as ZScoreRecord[];
  }

  getLatestZScoreForPair(pair: string): { z_score: number; spread: number } | undefined {
    return this.db.prepare(
      'SELECT z_score, spread FROM z_score_history WHERE pair = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(pair) as { z_score: number; spread: number } | undefined;
  }

  // ─── Notification Queries ───

  insertNotification(notification: NotificationRecord): void {
    this.db.prepare(`
      INSERT INTO notifications (id, type, message, dedup_key, sent_at)
      VALUES (@id, @type, @message, @dedup_key, @sent_at)
    `).run(notification);
  }

  hasRecentNotification(dedupKey: string, ttlMs: number): boolean {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const row = this.db.prepare(
      'SELECT 1 FROM notifications WHERE dedup_key = ? AND sent_at > ? LIMIT 1'
    ).get(dedupKey, cutoff);
    return !!row;
  }

  cleanOldNotifications(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.db.prepare('DELETE FROM notifications WHERE sent_at < ?').run(cutoff);
    return result.changes;
  }

  // ─── Config History ───

  insertConfigHistory(configJson: string, backtestRank?: number): void {
    this.db.prepare(`
      INSERT INTO config_history (config_json, backtest_rank, applied_at)
      VALUES (?, ?, ?)
    `).run(configJson, backtestRank ?? null, new Date().toISOString());
  }

  getLatestConfig(): { config_json: string; backtest_rank: number | null; applied_at: string } | undefined {
    return this.db.prepare(
      'SELECT config_json, backtest_rank, applied_at FROM config_history ORDER BY applied_at DESC LIMIT 1'
    ).get() as { config_json: string; backtest_rank: number | null; applied_at: string } | undefined;
  }

  // ─── Backtest Results ───

  insertBacktestResult(result: Omit<BacktestResult, 'id'>): void {
    this.db.prepare(`
      INSERT INTO backtest_results (config_json, pair, total_trades, win_rate, sharpe_ratio, max_drawdown, total_pnl, rank, tested_at)
      VALUES (@config_json, @pair, @total_trades, @win_rate, @sharpe_ratio, @max_drawdown, @total_pnl, @rank, @tested_at)
    `).run(result);
  }

  getTopBacktestResults(limit: number = 10): BacktestResult[] {
    return this.db.prepare(
      'SELECT * FROM backtest_results ORDER BY sharpe_ratio DESC LIMIT ?'
    ).all(limit) as BacktestResult[];
  }

  // ─── OHLCV Cache ───

  upsertOHLCV(symbol: string, timeframe: string, candles: OHLCVCandle[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ohlcv_cache (symbol, timeframe, timestamp, open, high, low, close, volume, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const insert = this.db.transaction((data: OHLCVCandle[]) => {
      for (const c of data) {
        stmt.run(symbol, timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume, now);
      }
    });
    insert(candles);
    log.debug({ symbol, timeframe, count: candles.length }, 'OHLCV cached');
  }

  getOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): OHLCVCandle[] {
    let sql = 'SELECT timestamp, open, high, low, close, volume FROM ohlcv_cache WHERE symbol = ? AND timeframe = ?';
    const params: (string | number)[] = [symbol, timeframe];

    if (since) {
      sql += ' AND timestamp >= ?';
      params.push(since);
    }
    sql += ' ORDER BY timestamp ASC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    return this.db.prepare(sql).all(...params) as OHLCVCandle[];
  }

  // ─── Dashboard helpers ───

  getDistinctSymbols(): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT symbol FROM ohlcv_cache ORDER BY symbol'
    ).all() as { symbol: string }[]).map(r => r.symbol);
  }

  getDistinctZScorePairs(): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT pair FROM z_score_history ORDER BY pair'
    ).all() as { pair: string }[]).map(r => r.pair);
  }

  // ─── Alerts ───

  insertAlert(alert: { id: string; chat_id: string; type: string; pair?: string; target_value?: number }): void {
    this.db.prepare(`
      INSERT INTO alerts (id, chat_id, type, pair, target_value, created_at)
      VALUES (@id, @chat_id, @type, @pair, @target_value, @created_at)
    `).run({
      ...alert,
      created_at: new Date().toISOString(),
    });
  }

  getAlerts(chatId?: string, pair?: string): Array<{ id: string; chat_id: string; type: string; pair: string | null; target_value: number | null }> {
    let sql = 'SELECT id, chat_id, type, pair, target_value FROM alerts WHERE 1=1';
    const params: string[] = [];
    if (chatId) {
      sql += ' AND chat_id = ?';
      params.push(chatId);
    }
    if (pair) {
      sql += ' AND (pair = ? OR pair IS NULL)';
      params.push(pair);
    }
    return this.db.prepare(sql).all(...params) as any[];
  }

  deleteAlert(id: string): void {
    this.db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  }

  // ─── Utility ───

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
    log.info('Database connection closed');
  }
}
