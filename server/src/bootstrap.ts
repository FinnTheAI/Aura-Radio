import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config, mergeNcmCookies } from './config.js';
import { buildExpressApp } from './express-app.js';
import { log } from './logger.js';
import { QueueEngine } from './queue-engine.js';
import { scheduleNextTrackDiscovery } from './next-track-segment.js';
import { StreamHub } from './stream-hub.js';
import { warmupClaudeCli } from './brain.js';

export async function bootstrap() {
  // 预热 Claude CLI（减少首次用户请求延迟）
  await warmupClaudeCli();
  
  const streamHub = new StreamHub();
  const queue = new QueueEngine(streamHub);
  queue.setOnQueueDrainedAfterMusic((meta) => scheduleNextTrackDiscovery(queue, meta));
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
      ncmApiBase: config.ncmApiBaseUrl || '[empty]',
      /** 为 true 时「播放xxx」才走 ncmSearch；缺省 false，仅改 .env 须重启进程才生效 */
      playIntentNcmSearch: config.neteaseCliPlayEnabled,
    });

    if (!config.ncmApiBaseUrl || config.ncmMock) {
      log.warn('[aura] NCM 上游未就绪（NCM_API_BASE_URL 为空或 NCM_MOCK=1）', {
        remediation:
          'cloudsearch/song/url 将弱化，选曲更易落候选修正与 ultimate_fallback_pick；生产请配置常驻代理并关闭 MOCK（见 docs/NCM_UPSTREAM.md）。',
      });
    } else if (!mergeNcmCookies().trim()) {
      log.warn('[aura] 已配置 NCM 代理但未设置 MUSIC_U / NCM_UPSTREAM_COOKIE', {
        remediation:
          '大量 VIP/地区受限曲可能无法取到 url，日志中易出现 discoveryNote_no_playable_hit 与 ultimate_fallback_pick；请按 Enhanced 文档配置登录 Cookie。',
      });
    }
  });

  const shutdown = () => {
    queue.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, queue, streamHub };
}
