import type { TradingQueries } from '../db/queries.js';
import type { PositionManager } from '../trader/position-manager.js';
import { registerCommands, type CommandContext } from './commands.js';
import { NotificationService, type NotificationSender } from './notifications.js';
import { cleanupAndRegister } from '../lifecycle.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('telegram-bot');

export interface TelegramBotAdapter {
  onCommand(command: string, handler: (ctx: CommandContext, ...args: string[]) => Promise<void>): void;
  onText(handler: (ctx: CommandContext, text: string) => Promise<void>): void;
  start(): Promise<void>;
  stop(): void;
}

export function createTelegramBot(
  botAdapter: TelegramBotAdapter,
  queries: TradingQueries,
  positionManager: PositionManager,
  notificationSender: NotificationSender,
  chatId: string,
  callbacks?: {
    onScan?: () => Promise<void>;
    onOpenPair?: (pair: string) => Promise<string>;
    onClosePair?: (pair: string) => Promise<string>;
    onBacktest?: (pair: string, days: number) => Promise<string>;
    onPnlReport?: () => Promise<string>;
    onTrades?: (limit: number) => Promise<string>;
    onAlerts?: () => Promise<Array<{ id: string; pair?: string; type: string; target: number }>>;
    onAddAlert?: (pair: string, type: string, target: number) => Promise<string>;
    onDeleteAlert?: (id: string) => Promise<string>;
  },
): { bot: TelegramBotAdapter; notifications: NotificationService } {
  const commands = registerCommands(
    queries,
    positionManager,
    callbacks?.onScan,
    callbacks?.onOpenPair,
    callbacks?.onClosePair,
    callbacks?.onBacktest,
    callbacks?.onPnlReport,
    callbacks?.onTrades,
    callbacks?.onAlerts,
    callbacks?.onAddAlert,
    callbacks?.onDeleteAlert,
    chatId,
  );

  const notifications = new NotificationService(notificationSender, queries, chatId);

  // Register commands
  botAdapter.onCommand('status', (ctx) => commands.status(ctx));
  botAdapter.onCommand('scan', (ctx) => commands.scan(ctx));
  botAdapter.onCommand('open', (ctx, ...args) => commands.open(ctx, args.join(' ')));
  botAdapter.onCommand('close', (ctx, ...args) => commands.close(ctx, args.join(' ')));
  botAdapter.onCommand('config', (ctx) => commands.config(ctx));
  botAdapter.onCommand('setconfig', (ctx, key, value) => commands.setconfig(ctx, key, value));
  botAdapter.onCommand('backtest', (ctx, pair, days) => commands.backtest(ctx, pair, days));
  botAdapter.onCommand('pnl', (ctx) => commands.pnl(ctx));
  botAdapter.onCommand('pnlreport', (ctx) => commands.pnlreport(ctx, callbacks?.onPnlReport));
  botAdapter.onCommand('trades', (ctx, ...args) => commands.trades(ctx, args[0], callbacks?.onTrades));
  botAdapter.onCommand('alert', (ctx, ...args) => commands.alert(ctx, args[0], args[1], args[2], args[3]));
  botAdapter.onCommand('tune', (ctx, ...args) => commands.tune(ctx, args[0]));
  botAdapter.onCommand('orphans', (ctx) => commands.orphans(ctx));

  // Register singleton (RULE 5)
  cleanupAndRegister('telegramBot', botAdapter as any, (old: any) => {
    if (typeof old.stop === 'function') old.stop();
  });

  log.info('Telegram bot initialized');

  return { bot: botAdapter, notifications };
}
