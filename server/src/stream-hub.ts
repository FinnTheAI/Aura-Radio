import type { WebSocket } from 'ws';
import type { NowPlaying } from './types.js';
import type { QueueItem } from './types.js';

export type StreamMessage =
  | { type: 'pong'; schemaVersion: 1; ts: string }
  | { type: 'now_playing'; payload: NowPlaying }
  | { type: 'queue'; items: QueueItem[] }
  | { type: 'error'; message: string; traceId?: string };

export class StreamHub {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
  }

  broadcast(msg: StreamMessage) {
    const raw = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState === 1) c.send(raw);
    }
  }
}
