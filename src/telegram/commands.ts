import type { TradingQueries } from '../db/queries.js';
import type { PositionManager } from '../trader/position-manager.js';
import { getTradingConfig, updateTradingConfig } from '../config.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('commands');

export interface CommandContext {
  reply(text: string): Promise<void>;
}

export function registerCommands(
  queries: TradingQueries,
  positionManager: PositionManager,
  onScan?: () => Promise<void>,
  onOpenPair?: (pair: string) => Promise<string>,
  onClosePair?: (pair: string) => Promise<string>,
  onBacktest?: (pair: string, days: number) => Promise<string>,
) {
  return {
    async status(ctx: CommandContext) {
      const positions = positionManager.getActivePositions();
      if (positions.length === 0) {
        await ctx.reply('No open positions.');
        return;
      }

      const lines = positions.map(p => {
        const z = p.current_z_score?.toFixed(4) ?? 'N/A';
        const pnl = p.pnl !== null ? `$${p.pnl.toFixed(2)}` : 'N/A';
        return `• \`${p.pair}\` [${p.state}] Z=${z} PnL=${pnl} (${p.direction})`;
      });

      await ctx.reply(`📊 *Open Positions* (${positions.length})\n${lines.join('\n')}`);
    },

    async scan(ctx: CommandContext) {
      if (onScan) {
        await ctx.reply('🔍 Starting scan...');
        try {
          await onScan();
          await ctx.reply('✅ Scan completed.');
        } catch (err) {
          await ctx.reply(`❌ Scan error: ${err}`);
        }
      } else {
        await ctx.reply('Scanner not configured.');
      }
    },

    async open(ctx: CommandContext, pair: string) {
      if (!pair) {
        await ctx.reply('Usage: /open HMSTR/BABY');
        return;
      }
      if (onOpenPair) {
        const result = await onOpenPair(pair);
        await ctx.reply(result);
      } else {
        await ctx.reply('Auto-trade not configured.');
      }
    },

    async close(ctx: CommandContext, pair: string) {
      if (!pair) {
        await ctx.reply('Usage: /close HMSTR/BABY');
        return;
      }
      if (onClosePair) {
        const result = await onClosePair(pair);
        await ctx.reply(result);
      } else {
        await ctx.reply('Auto-trade not configured.');
      }
    },

    async config(ctx: CommandContext) {
      const cfg = getTradingConfig();
      const lines = Object.entries(cfg).map(([k, v]) => `  ${k}: ${v}`);
      await ctx.reply(`⚙️ *Config*\n\`\`\`\n${lines.join('\n')}\n\`\`\``);
    },

    async setconfig(ctx: CommandContext, key: string, value: string) {
      if (!key || !value) {
        await ctx.reply('Usage: /setconfig entryZScore 2.5');
        return;
      }

      try {
        const numValue = Number(value);
        const update: Record<string, unknown> = {};

        if (!isNaN(numValue)) {
          update[key] = numValue;
        } else if (value === 'true' || value === 'false') {
          update[key] = value === 'true';
        } else {
          update[key] = value;
        }

        updateTradingConfig(update as any);
        queries.insertConfigHistory(JSON.stringify(getTradingConfig()));
        await ctx.reply(`✅ Updated \`${key}\` = \`${value}\``);
      } catch (err) {
        await ctx.reply(`❌ Error: ${err}`);
      }
    },

    async backtest(ctx: CommandContext, pair: string, days: string) {
      if (!pair || !days) {
        await ctx.reply('Usage: /backtest HMSTR/BABY 30');
        return;
      }
      if (onBacktest) {
        await ctx.reply(`⏳ Running backtest for ${pair} over ${days} days...`);
        try {
          const result = await onBacktest(pair, parseInt(days, 10));
          await ctx.reply(result);
        } catch (err) {
          await ctx.reply(`❌ Backtest error: ${err}`);
        }
      } else {
        await ctx.reply('Backtest engine not configured.');
      }
    },

    async pnl(ctx: CommandContext) {
      const summary = positionManager.getPnlSummary();
      const winRate = summary.count > 0 ? (summary.wins / summary.count * 100).toFixed(1) : '0.0';
      await ctx.reply([
        `💰 *PnL Summary*`,
        `Total: $${summary.total.toFixed(2)}`,
        `Trades: ${summary.count}`,
        `Wins: ${summary.wins} | Losses: ${summary.losses}`,
        `Win Rate: ${winRate}%`,
      ].join('\n'));
    },

    async orphans(ctx: CommandContext) {
      // Delegate to orphan detector at runtime
      await ctx.reply('Run orphan detection via monitor. Use /status for current positions.');
    },
  };
}
