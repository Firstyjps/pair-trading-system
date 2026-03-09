import { getTradingConfig } from './config.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('webhook');

export async function sendWebhook(event: string, payload: Record<string, unknown>): Promise<void> {
  const url = getTradingConfig().webhookUrl;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload, timestamp: new Date().toISOString() }),
    });
    if (!res.ok) {
      log.warn({ status: res.status, event }, 'Webhook returned non-2xx');
    }
  } catch (err: any) {
    log.error({ url, event, error: err.message }, 'Webhook failed');
  }
}
