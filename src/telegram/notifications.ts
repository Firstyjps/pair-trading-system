import { v4 as uuid } from 'uuid';
import type { TradingQueries } from '../db/queries.js';
import type { PairPosition, Signal } from '../types.js';
import type { OrphanPosition } from '../monitor/orphan-detector.js';
import { getTradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';
import { sendWebhook } from '../webhook.js';

const log = createChildLogger('notifications');

export interface NotificationSender {
  sendMessage(chatId: string, text: string): Promise<void>;
}

export class NotificationService {
  private sentKeys = new Set<string>();

  constructor(
    private sender: NotificationSender,
    private queries: TradingQueries,
    private chatId: string,
  ) {}

  private getDedupKey(pair: string, type: string): string {
    const bucket = Math.floor(Date.now() / 300000); // 5-minute bucket
    return `${pair}:${type}:${bucket}`;
  }

  private async canSend(dedupKey: string): Promise<boolean> {
    const config = getTradingConfig();

    // In-memory check (fast path)
    if (this.sentKeys.has(dedupKey)) return false;

    // DB check (survives restart)
    if (this.queries.hasRecentNotification(dedupKey, config.notificationTTL)) return false;

    return true;
  }

  /** Escape Markdown special chars in dynamic values */
  private escMd(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  private async send(type: string, message: string, dedupKey: string): Promise<void> {
    if (!(await this.canSend(dedupKey))) {
      log.debug({ dedupKey }, 'Notification deduplicated');
      return;
    }

    try {
      await this.sender.sendMessage(this.chatId, message);
      if (['ERROR', 'ORPHAN', 'CLOSED', 'LOSS_ALERT'].includes(type)) {
        sendWebhook(type, { message }).catch(() => {});
      }

      // Record in both memory and DB
      this.sentKeys.add(dedupKey);
      this.queries.insertNotification({
        id: uuid(),
        type,
        message,
        dedup_key: dedupKey,
        sent_at: new Date().toISOString(),
      });

      log.info({ type, dedupKey }, 'Notification sent');
    } catch (err) {
      log.error({ type, error: err }, 'Failed to send notification');
    }
  }

  async signalDetected(signal: Signal): Promise<void> {
    const dedupKey = this.getDedupKey(signal.pair, 'SIGNAL');
    const message = [
      `🟢 *Signal Detected*`,
      `Pair: \`${signal.pair}\``,
      `Direction: ${this.escMd(signal.direction)}`,
      `Z-Score: ${signal.z_score.toFixed(4)}`,
      `Correlation: ${signal.correlation.toFixed(4)}`,
      `Coint p-value: ${signal.cointegration_pvalue.toFixed(4)}`,
      `Half-life: ${signal.half_life.toFixed(1)} bars`,
    ].join('\n');

    await this.send('SIGNAL', message, dedupKey);
  }

  async positionOpened(position: PairPosition): Promise<void> {
    const dedupKey = this.getDedupKey(position.pair, 'OPENED');
    const message = [
      `🔵 *Position Opened*`,
      `Pair: \`${position.pair}\``,
      `Direction: ${this.escMd(position.direction)}`,
      `Entry Z: ${position.entry_z_score.toFixed(4)}`,
      `SL: ${position.stop_loss_z.toFixed(1)} | TP: ${position.take_profit_z.toFixed(1)}`,
      `Leverage: ${position.leverage}x`,
      `Margin/leg: $${position.margin_per_leg}`,
    ].join('\n');

    await this.send('OPENED', message, dedupKey);
  }

  async positionClosing(position: PairPosition): Promise<void> {
    const dedupKey = this.getDedupKey(position.pair, 'CLOSING');
    const message = [
      `🟡 *Position Closing*`,
      `Pair: \`${position.pair}\``,
      `Current Z: ${position.current_z_score?.toFixed(4) ?? 'N/A'}`,
    ].join('\n');

    await this.send('CLOSING', message, dedupKey);
  }

  async positionClosed(position: PairPosition): Promise<void> {
    const dedupKey = this.getDedupKey(position.pair, 'CLOSED');
    const pnlEmoji = (position.pnl ?? 0) >= 0 ? '📈' : '📉';
    const message = [
      `⚪ *Position Closed* ${pnlEmoji}`,
      `Pair: \`${position.pair}\``,
      `PnL: $${(position.pnl ?? 0).toFixed(2)}`,
      `Reason: ${this.escMd(position.close_reason ?? 'N/A')}`,
      `Duration: ${position.closed_at && position.opened_at ?
        Math.round((new Date(position.closed_at).getTime() - new Date(position.opened_at).getTime()) / 60000) + ' min' :
        'N/A'}`,
    ].join('\n');

    await this.send('CLOSED', message, dedupKey);

    // สรุปสั้น (แบบ Pairtrading bot) — position ที่ขาดทุนมากสุด
    const pnl = position.pnl ?? 0;
    if (pnl < 0) {
      const realized = this.queries.getRealizedPnl();
      const shortMsg = [
        `🔴 ${position.pair} (${position.direction === 'SHORT_SPREAD' ? 'short' : 'long'}): $${pnl.toFixed(2)}`,
        '─── สรุป ───',
        `กำไร/ขาดทุนรวม: ${realized.total >= 0 ? '+' : ''}$${realized.total.toFixed(2)}`,
        `⏰ ${new Date().toLocaleString('th-TH')}`,
      ].join('\n');
      await this.send('CLOSED_SHORT', shortMsg, `${position.pair}:CLOSED_SHORT:${Math.floor(Date.now() / 60000)}`);
    }
  }

  async errorAlert(error: string, context?: string): Promise<void> {
    const dedupKey = this.getDedupKey(context ?? 'system', 'ERROR');
    const message = [
      `🔴 *Error*`,
      `${error}`,
      context ? `Context: ${context}` : '',
    ].filter(Boolean).join('\n');

    await this.send('ERROR', message, dedupKey);
  }

  async orphanAlert(orphans: OrphanPosition[]): Promise<void> {
    const dedupKey = this.getDedupKey('orphans', 'ORPHAN');
    const lines = orphans.map(o =>
      `  • \`${o.symbol}\` ${o.side} ${o.size} @ ${o.avgPrice} (PnL: ${o.unrealizedPnl.toFixed(2)})`
    );
    const message = [
      `🔴 *Orphan Positions Detected*`,
      `Count: ${orphans.length}`,
      ...lines,
      `⚠️ Manual action required — NO auto-close`,
    ].join('\n');

    await this.send('ORPHAN', message, dedupKey);
  }

  async dailySummary(stats: {
    openPositions: number;
    totalPnl: number;
    winRate: number;
    trades: number;
  }): Promise<void> {
    const dedupKey = this.getDedupKey('daily', 'SUMMARY');
    const message = [
      `📊 *Daily Summary*`,
      `Open positions: ${stats.openPositions}`,
      `Total realized PnL: $${stats.totalPnl.toFixed(2)}`,
      `Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
      `Total trades: ${stats.trades}`,
    ].join('\n');

    await this.send('SUMMARY', message, dedupKey);
  }

  /** Send periodic PnL report (Thai format, like Pairtrading bot) */
  async pnlReport(message: string): Promise<void> {
    const bucket = Math.floor(Date.now() / 300000); // 5-minute bucket
    await this.send('PNL_REPORT', message, `pnl:${bucket}`);
  }

  /** แจ้งเตือนเมื่อขาดทุนเกินเกณฑ์ */
  async lossAlert(
    context: string,
    lossUsd: number,
    lossPct: number,
    totalBalance: number,
  ): Promise<void> {
    const dedupKey = this.getDedupKey('loss', 'LOSS_ALERT');
    const message = [
      `🔴 *แจ้งเตือนขาดทุน*`,
      context,
      `ขาดทุน: $${lossUsd.toFixed(2)} (${lossPct.toFixed(1)}%)`,
      `ยอดเงิน: $${totalBalance.toFixed(2)}`,
    ].join('\n');
    await this.send('LOSS_ALERT', message, dedupKey);
  }

  /** รายงานสัปดาห์/เดือน */
  async periodSummary(
    period: 'weekly' | 'monthly',
    stats: { totalPnl: number; trades: number; wins: number; winRate: number },
  ): Promise<void> {
    const dedupKey = this.getDedupKey(period, 'PERIOD_SUMMARY');
    const label = period === 'weekly' ? 'รายสัปดาห์' : 'รายเดือน';
    const message = [
      `📅 *สรุป${label}*`,
      `กำไร/ขาดทุน: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`,
      `จำนวนเทรด: ${stats.trades}`,
      `ชนะ: ${stats.wins} | Win Rate: ${(stats.winRate * 100).toFixed(1)}%`,
    ].join('\n');
    await this.send('PERIOD_SUMMARY', message, dedupKey);
  }

  /** Send to specific chat (for alerts) — no dedup */
  async sendToChat(chatId: string, message: string): Promise<void> {
    try {
      await this.sender.sendMessage(chatId, message);
      log.info({ chatId }, 'Alert sent');
    } catch (err) {
      log.error({ chatId, error: err }, 'Failed to send alert');
    }
  }

  clearMemoryCache(): void {
    this.sentKeys.clear();
  }
}
