import type { TradingQueries } from '../db/queries.js';
import type { PairPosition } from '../types.js';
import type { ExchangePosition } from '../monitor/reconciliation.js';

/** Extract base symbol from OKX instrument (e.g. BTC-USDT-SWAP → BTC) */
function toBaseSymbol(instrument: string): string {
  return instrument.replace('-USDT-SWAP', '');
}

/** Format Thai Buddhist date: D/M/YYYY HH:mm:ss */
function formatThaiTimestamp(): string {
  const d = new Date();
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear() + 543;
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${day}/${month}/${year} ${h}:${m}:${s}`;
}

export interface PnlReportData {
  pairPositions: PairPosition[];
  exchangePositions: ExchangePosition[];
  totalBalance: number;
  realizedPnl: number;
}

/**
 * Build PnL report message in Thai format (like Pairtrading bot).
 * Format: กำไร/ขาดทุน with sections คู่เทรด, ออเดอร์บน OKX, สรุป
 */
export function buildPnLReport(
  data: PnlReportData,
  queries: TradingQueries,
): string {
  const lines: string[] = [];

  // Header
  lines.push('📊 *กำไร/ขาดทุน*');

  // ─── คู่เทรด (Pair) ───
  lines.push('');
  lines.push('─── คู่เทรด (Pair) ───');

  for (const pos of data.pairPositions) {
    if (pos.state !== 'BOTH_LEGS_OPEN') continue;

    const latest = queries.getLatestZScoreForPair(pos.pair);
    let pct = 0;
    if (latest && Math.abs(pos.entry_spread) > 1e-10) {
      if (pos.direction === 'SHORT_SPREAD') {
        pct = ((pos.entry_spread - latest.spread) / Math.abs(pos.entry_spread)) * 100;
      } else {
        pct = ((latest.spread - pos.entry_spread) / Math.abs(pos.entry_spread)) * 100;
      }
    }
    const emoji = pct >= 0 ? '🟢' : '🔴';
    const sign = pct >= 0 ? '+' : '';
    lines.push(`${emoji} ${pos.pair}: ${sign}${pct.toFixed(2)}%`);
  }

  if (data.pairPositions.filter(p => p.state === 'BOTH_LEGS_OPEN').length === 0) {
    lines.push('(ไม่มีคู่เทรดที่เปิดอยู่)');
  }

  // ─── ออเดอร์บน OKX ───
  lines.push('');
  lines.push('─── ออเดอร์บน OKX ───');

  for (const pos of data.exchangePositions) {
    if (pos.size === 0) continue;
    const base = toBaseSymbol(pos.symbol);
    const side = pos.side === 'long' ? 'long' : 'short';
    const pnl = pos.unrealizedPnl;
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    const sign = pnl >= 0 ? '+' : '';
    lines.push(`${emoji} ${base} (${side}): ${sign}$${pnl.toFixed(2)}`);
  }

  if (data.exchangePositions.filter(p => p.size > 0).length === 0) {
    lines.push('(ไม่มีออเดอร์เปิดอยู่)');
  }

  // ─── สรุป ───
  const totalUnrealized = data.exchangePositions
    .filter(p => p.size > 0)
    .reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalPnl = data.realizedPnl + totalUnrealized;

  lines.push('');
  lines.push('─── สรุป ───');
  const pnlSign = totalPnl >= 0 ? '+' : '';
  lines.push(`กำไร/ขาดทุนรวม: ${pnlSign}$${totalPnl.toFixed(2)}`);
  lines.push(`ยอดเงินทั้งหมด: $${data.totalBalance.toFixed(2)}`);
  lines.push('');
  lines.push(`⏰ ${formatThaiTimestamp()}`);

  return lines.join('\n');
}
