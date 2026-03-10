/**
 * WebSocket Real-Time Push Server
 *
 * Replaces HTTP polling on the dashboard with real-time pushes.
 * Clients connect to ws://host:port and receive JSON events.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('websocket');

// ─── Event Types ───

export type WsEventType =
  | 'scanner:update'
  | 'position:update'
  | 'position:opened'
  | 'position:closed'
  | 'account:update'
  | 'ticker:update'
  | 'ping';

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  ts: number;
}

// ─── Singleton ───

let wss: WebSocketServer | null = null;

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Call once during startup.
 */
export function attachWebSocket(httpServer: HttpServer): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    log.info({ ip, clients: wss!.clients.size }, 'WebSocket client connected');

    // Send welcome
    sendTo(ws, { type: 'ping', data: { message: 'connected' }, ts: Date.now() });

    ws.on('close', () => {
      log.debug({ ip, clients: wss!.clients.size - 1 }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      log.warn({ error: err, ip }, 'WebSocket client error');
    });
  });

  // Heartbeat every 30s to keep connections alive
  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  log.info('WebSocket server attached');
  return wss;
}

// ─── Broadcast helpers ───

function sendTo(ws: WebSocket, event: WsEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

/** Broadcast an event to all connected clients */
export function broadcast(type: WsEventType, data: unknown): void {
  if (!wss || wss.clients.size === 0) return;

  const event: WsEvent = { type, data, ts: Date.now() };
  const payload = JSON.stringify(event);

  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent++;
    }
  }

  log.debug({ type, clients: sent }, 'Broadcast sent');
}

// ─── Typed broadcast wrappers ───

export function broadcastScannerUpdate(pairs: unknown[], metrics: unknown): void {
  broadcast('scanner:update', { pairs, metrics });
}

export function broadcastPositionUpdate(positions: unknown[]): void {
  broadcast('position:update', { positions });
}

export function broadcastPositionOpened(position: unknown): void {
  broadcast('position:opened', { position });
}

export function broadcastPositionClosed(position: unknown, reason: string): void {
  broadcast('position:closed', { position, reason });
}

export function broadcastAccountUpdate(account: unknown): void {
  broadcast('account:update', { account });
}

export function broadcastTickerUpdate(tickers: unknown[]): void {
  broadcast('ticker:update', { tickers });
}

export function getClientCount(): number {
  return wss?.clients.size ?? 0;
}
