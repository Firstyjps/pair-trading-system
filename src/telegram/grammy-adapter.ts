import { Bot } from 'grammy';
import type { TelegramBotAdapter } from './bot.js';
import type { CommandContext } from './commands.js';
import type { NotificationSender } from './notifications.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('grammy-adapter');

/**
 * grammy adapter implementing TelegramBotAdapter + NotificationSender.
 */
export class GrammyAdapter implements TelegramBotAdapter, NotificationSender {
  private bot: Bot;

  constructor(token: string) {
    this.bot = new Bot(token);
    log.info('Grammy bot adapter created');
  }

  onCommand(
    command: string,
    handler: (ctx: CommandContext, ...args: string[]) => Promise<void>,
  ): void {
    this.bot.command(command, async (grammyCtx) => {
      const text = grammyCtx.message?.text ?? '';
      // Parse args: "/command arg1 arg2" → ["arg1", "arg2"]
      const parts = text.trim().split(/\s+/).slice(1);

      const commandCtx: CommandContext = {
        reply: async (msg: string) => {
          await grammyCtx.reply(msg, { parse_mode: 'Markdown' });
        },
      };

      try {
        await handler(commandCtx, ...parts);
      } catch (err: any) {
        log.error({ command, error: err.message }, 'Command handler error');
        await grammyCtx.reply(`Error: ${err.message}`);
      }
    });
  }

  onText(handler: (ctx: CommandContext, text: string) => Promise<void>): void {
    this.bot.on('message:text', async (grammyCtx) => {
      const text = grammyCtx.message.text;
      // Skip commands (handled by onCommand)
      if (text.startsWith('/')) return;

      const commandCtx: CommandContext = {
        reply: async (msg: string) => {
          await grammyCtx.reply(msg, { parse_mode: 'Markdown' });
        },
      };

      try {
        await handler(commandCtx, text);
      } catch (err: any) {
        log.error({ error: err.message }, 'Text handler error');
        await grammyCtx.reply(`Error: ${err.message}`);
      }
    });
  }

  async start(): Promise<void> {
    log.info('Starting grammy bot (long polling)...');

    // Error handler
    this.bot.catch((err) => {
      log.error({ error: err.message }, 'Grammy bot error');
    });

    // Start polling (non-blocking)
    this.bot.start({
      drop_pending_updates: true,
      onStart: (botInfo) => {
        log.info({ username: botInfo.username }, 'Telegram bot started');
      },
    });
  }

  stop(): void {
    log.info('Stopping grammy bot...');
    this.bot.stop();
  }

  // ─── NotificationSender ───

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err: any) {
      log.error({ chatId, error: err.message }, 'Failed to send Telegram message');
      throw err;
    }
  }
}

/**
 * Factory function to create Grammy adapter
 */
export function createGrammyAdapter(token: string): GrammyAdapter {
  return new GrammyAdapter(token);
}
