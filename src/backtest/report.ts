import type { BacktestReport } from './engine.js';
import type { StrategyReport, StrategyComparison, MultiLogicResult } from './multi-logic-engine.js';

// ─── Single Report (legacy) ───

export function formatReport(report: BacktestReport): string {
  const lines: string[] = [
    `═══ Backtest Report: ${report.pair} ═══`,
    ``,
    `Config:`,
    `  Entry Z: ${report.config.entryZ}`,
    `  Exit Z: ${report.config.exitZ}`,
    `  Stop Loss Z: ${report.config.stopLossZ}`,
    `  Leverage: ${report.config.leverage}x`,
    `  Capital/Leg: $${report.config.capitalPerLeg}`,
    ``,
    `Results:`,
    `  Total Trades: ${report.totalTrades}`,
    `  Win Rate: ${(report.winRate * 100).toFixed(1)}%`,
    `  Total PnL: $${report.totalPnl.toFixed(2)}`,
    `  Avg PnL/Trade: $${report.avgPnl.toFixed(2)}`,
    `  Sharpe Ratio: ${report.sharpeRatio.toFixed(4)}`,
    `  Max Drawdown: $${report.maxDrawdown.toFixed(2)} (${(report.maxDrawdownPercent * 100).toFixed(1)}%)`,
    `  Profit Factor: ${report.profitFactor === Infinity ? '∞' : report.profitFactor.toFixed(2)}`,
    `  Avg Bars Held: ${report.avgBarsHeld.toFixed(1)}`,
    ``,
  ];

  if (report.trades.length > 0) {
    const wins = report.trades.filter(t => t.pnl > 0);
    const losses = report.trades.filter(t => t.pnl <= 0);
    const tpTrades = report.trades.filter(t => t.closeReason === 'TP');
    const slTrades = report.trades.filter(t => t.closeReason === 'SL');

    lines.push(
      `Breakdown:`,
      `  Wins: ${wins.length} | Losses: ${losses.length}`,
      `  TP exits: ${tpTrades.length} | SL exits: ${slTrades.length}`,
      `  Avg Win: $${wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : '0.00'}`,
      `  Avg Loss: $${losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : '0.00'}`,
      ``,
    );
  }

  return lines.join('\n');
}

export function formatComparisonTable(reports: BacktestReport[], topN: number = 10): string {
  const sorted = [...reports].sort((a, b) => b.sharpeRatio - a.sharpeRatio).slice(0, topN);

  const header = `${'Rank'.padStart(4)} | ${'EntryZ'.padStart(6)} | ${'ExitZ'.padStart(5)} | ${'SLZ'.padStart(5)} | ${'Trades'.padStart(6)} | ${'WinR%'.padStart(6)} | ${'PnL$'.padStart(8)} | ${'Sharpe'.padStart(7)}`;
  const sep = '-'.repeat(header.length);

  const rows = sorted.map((r, i) => {
    const rank = String(i + 1).padStart(4);
    const entryZ = r.config.entryZ.toFixed(1).padStart(6);
    const exitZ = r.config.exitZ.toFixed(1).padStart(5);
    const slZ = r.config.stopLossZ.toFixed(1).padStart(5);
    const trades = String(r.totalTrades).padStart(6);
    const winRate = (r.winRate * 100).toFixed(1).padStart(6);
    const pnl = r.totalPnl.toFixed(2).padStart(8);
    const sharpe = r.sharpeRatio.toFixed(3).padStart(7);
    return `${rank} | ${entryZ} | ${exitZ} | ${slZ} | ${trades} | ${winRate} | ${pnl} | ${sharpe}`;
  });

  return [header, sep, ...rows].join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Multi-Logic Reports
// ═══════════════════════════════════════════════════════════════

/**
 * Format a strategy-specific detailed report
 */
export function formatStrategyReport(report: StrategyReport): string {
  const lines: string[] = [
    ``,
    `╔══════════════════════════════════════════════════════════════╗`,
    `║  ${report.strategyName.toUpperCase().padEnd(56)} ║`,
    `║  ${report.strategyDescription.padEnd(56)} ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    ``,
    `  Pair: ${report.pair}`,
    ``,
    `  Parameters:`,
  ];

  // Show key params
  for (const [key, val] of Object.entries(report.strategyParams)) {
    lines.push(`    ${key}: ${typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(4)) : val}`);
  }

  lines.push(
    ``,
    `  ── Performance ──`,
    `  Total Trades: ${report.totalTrades}`,
    `  Win Rate:     ${(report.winRate * 100).toFixed(1)}%`,
    `  Total PnL:    $${report.totalPnl.toFixed(2)}`,
    `  Avg PnL:      $${report.avgPnl.toFixed(2)}`,
    `  Sharpe Ratio: ${report.sharpeRatio.toFixed(4)}`,
    `  Max Drawdown: $${report.maxDrawdown.toFixed(2)} (${(report.maxDrawdownPercent * 100).toFixed(1)}%)`,
    `  Profit Factor:${report.profitFactor === Infinity ? ' ∞' : ' ' + report.profitFactor.toFixed(2)}`,
    `  Avg Bars Held:${(' ' + report.avgBarsHeld.toFixed(1))}`,
  );

  if (report.trades.length > 0) {
    const wins = report.trades.filter(t => t.pnl > 0);
    const losses = report.trades.filter(t => t.pnl <= 0);
    const tpTrades = report.trades.filter(t => t.closeReason === 'TP');
    const slTrades = report.trades.filter(t => t.closeReason === 'SL');

    lines.push(
      ``,
      `  ── Breakdown ──`,
      `  Wins: ${wins.length}  |  Losses: ${losses.length}`,
      `  TP exits: ${tpTrades.length}  |  SL exits: ${slTrades.length}`,
      `  Avg Win:  $${wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : '0.00'}`,
      `  Avg Loss: $${losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : '0.00'}`,
    );

    // Mini equity curve (ASCII sparkline)
    if (report.equityCurve.length > 0) {
      lines.push(``, `  ── Equity Curve ──`);
      lines.push(`  ${drawSparkline(report.equityCurve, 50)}`);
    }
  }

  lines.push(``);
  return lines.join('\n');
}

/**
 * Format multi-logic comparison table
 */
export function formatMultiLogicComparison(result: MultiLogicResult): string {
  const lines: string[] = [
    ``,
    `╔══════════════════════════════════════════════════════════════════════════════════╗`,
    `║                        MULTI-LOGIC BACKTEST COMPARISON                         ║`,
    `╚══════════════════════════════════════════════════════════════════════════════════╝`,
    ``,
    `  Pair: ${result.pair}  |  Data Points: ${result.dataPoints}  |  Best: ${result.bestStrategy}`,
    ``,
  ];

  if (result.comparison.length === 0) {
    lines.push(`  No strategies produced trades.`);
    return lines.join('\n');
  }

  // Table header
  const header = `  ${'#'.padStart(2)} | ${'Strategy'.padEnd(20)} | ${'Trades'.padStart(6)} | ${'WinR%'.padStart(6)} | ${'PnL $'.padStart(9)} | ${'Sharpe'.padStart(7)} | ${'MaxDD $'.padStart(8)} | ${'PF'.padStart(6)} | ${'AvgBars'.padStart(7)}`;
  const sep = `  ${'─'.repeat(header.length - 2)}`;

  lines.push(header, sep);

  for (const c of result.comparison) {
    const rank = String(c.rank).padStart(2);
    const name = c.name.padEnd(20);
    const trades = String(c.trades).padStart(6);
    const winRate = (c.winRate * 100).toFixed(1).padStart(6);
    const pnl = c.totalPnl.toFixed(2).padStart(9);
    const sharpe = c.sharpe.toFixed(3).padStart(7);
    const maxDD = c.maxDD.toFixed(2).padStart(8);
    const pf = (c.profitFactor === Infinity ? '∞' : c.profitFactor.toFixed(2)).padStart(6);
    const avgBars = c.avgBars.toFixed(1).padStart(7);

    const prefix = c.rank === 1 ? '🏆' : '  ';
    lines.push(`${prefix}${rank} | ${name} | ${trades} | ${winRate} | ${pnl} | ${sharpe} | ${maxDD} | ${pf} | ${avgBars}`);
  }

  lines.push(sep, ``);
  return lines.join('\n');
}

/**
 * Format complete multi-logic report with all details
 */
export function formatFullMultiLogicReport(result: MultiLogicResult): string {
  const parts: string[] = [];

  // Comparison table first
  parts.push(formatMultiLogicComparison(result));

  // Then individual strategy details
  for (const report of result.strategies) {
    parts.push(formatStrategyReport(report));
  }

  return parts.join('\n');
}

/**
 * Format Telegram-friendly summary (shorter)
 */
export function formatTelegramSummary(result: MultiLogicResult): string {
  const lines: string[] = [
    `📊 *Multi\\-Logic Backtest: ${escapeTgMd(result.pair)}*`,
    `Data: ${result.dataPoints} bars`,
    ``,
  ];

  if (result.comparison.length === 0) {
    lines.push(`No strategies produced trades\\.`);
    return lines.join('\n');
  }

  for (const c of result.comparison) {
    const medal = c.rank === 1 ? '🥇' : c.rank === 2 ? '🥈' : c.rank === 3 ? '🥉' : `${c.rank}\\.`;
    lines.push(
      `${medal} *${escapeTgMd(c.name)}*`,
      `   Trades: ${c.trades} \\| WinR: ${(c.winRate * 100).toFixed(1)}%`,
      `   PnL: $${escapeTgMd(c.totalPnl.toFixed(2))} \\| Sharpe: ${escapeTgMd(c.sharpe.toFixed(3))}`,
      ``,
    );
  }

  lines.push(`Best: *${escapeTgMd(result.bestStrategy)}* 🏆`);
  return lines.join('\n');
}

function escapeTgMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/**
 * Draw a simple ASCII sparkline
 */
function drawSparkline(data: number[], width: number): string {
  if (data.length === 0) return '';

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const step = Math.max(1, Math.floor(data.length / width));

  let result = '';
  for (let i = 0; i < data.length; i += step) {
    const normalized = (data[i] - min) / range;
    const idx = Math.min(chars.length - 1, Math.floor(normalized * (chars.length - 1)));
    result += chars[idx];
  }

  return `${result}  ($${min.toFixed(2)} → $${data[data.length - 1].toFixed(2)})`;
}
