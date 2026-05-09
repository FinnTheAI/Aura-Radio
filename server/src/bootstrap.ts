import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { buildExpressApp } from './express-app.js';
import { log } from './logger.js';
import { QueueEngine } from './queue-engine.js';
import { StreamHub } from './stream-hub.js';

export function bootstrap() {
  const streamHub = new StreamHub();
  const queue = new QueueEngine(streamHub);
  queue.start();

  const app = buildExpressApp(queue, streamHub);
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: '/stream' });
  wss.on('connection', (ws) => {
    streamHub.add(ws);
    try {
      ws.send(JSON.stringify({ type: 'now_playing', payload: queue.getNow() }));
      ws.send(JSON.stringify({ type: 'queue', items: queue.peek(8) }));
    } catch {
      /** ignore */
    }
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', schemaVersion: 1, ts: new Date().toISOString() }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid websocket frame' }));
      }
    });
  });

  server.listen(config.port, () => {
    log.info(`Aura Radio server listening http://localhost:${config.port}`, {
      cwd: process.cwd(),
      sqlite: config.stateDbPath,
      ncmApiBase: config.ncmApiBaseUrl ? '[set]' : '[empty]',
      /** 为 true 时「播放xxx」才走 ncmSearch；缺省 false，仅改 .env 须重启进程才生效 */
      playIntentNcmSearch: config.neteaseCliPlayEnabled,
    });
  });

  const shutdown = () => {
    queue.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, queue, streamHub };
}
