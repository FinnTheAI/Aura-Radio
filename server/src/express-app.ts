import express from 'express';
import cors from 'cors';
import type { QueueEngine } from './queue-engine.js';
import { newTraceId } from './queue-engine.js';
import { loadUserBundle } from './user-data.js';
import { assembleContext, persistUserTurn, persistAssistantJson, redactForDump } from './context-builder.js';
import { generateDjScript } from './minimax.js';
import { buildPlanToday } from './scheduler.js';
import { handleAudioProxyGet } from './audio-proxy.js';
import { config } from './config.js';
import { log } from './logger.js';
import type { StreamHub } from './stream-hub.js';
import { buildTasteSummary } from './taste-mood.js';

export function buildExpressApp(queue: QueueEngine, stream: StreamHub) {
  const app = express();
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (origin === config.clientOrigin) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '512kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      if (!text.trim()) return res.status(400).json({ error: 'text required' });

      const traceId =
        typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
          ? req.body.sessionId.trim()
          : newTraceId();
      const user = loadUserBundle();
      const fragments = assembleContext({
        user,
        userText: text,
        now: new Date(),
        timezone: typeof req.headers['x-timezone'] === 'string' ? req.headers['x-timezone'] : undefined,
      });

      persistUserTurn(text, traceId);
      const { script, normalized, usedFallback } = await generateDjScript(fragments);
      if (usedFallback) {
        log.warn('/api/chat minimax degraded to mock', {
          traceId,
          meta: { minimax: 'mock_fallback', minimaxMock: config.minimaxMock },
        });
      }
      persistAssistantJson(JSON.stringify({ script, normalized, usedFallback }), traceId);

      const replaceQueue = Boolean(req.body?.replaceQueue);
      if (replaceQueue) {
        await queue.resetQueueAndEnqueueFromScript(script, traceId);
      } else {
        await queue.enqueueFromScript(script, traceId);
      }

      res.json({
        djScript: { ...script, moodTag: normalized },
        queued: true,
        traceId,
      });
    } catch (e) {
      const traceId = newTraceId();
      stream.broadcast({ type: 'error', message: String(e), traceId });
      res.status(500).json({ error: String(e), traceId });
    }
  });

  app.get('/api/audio/proxy', (req, res, next) => {
    void handleAudioProxyGet(req, res).catch(next);
  });

  app.get('/api/now', (_req, res) => {
    res.json(queue.getNow());
  });

  app.get('/api/next', (req, res) => {
    const raw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 5;
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 20) : 5;
    res.json({ items: queue.peek(limit) });
  });

  app.get('/api/taste', (_req, res) => {
    const user = loadUserBundle();
    res.json({
      taste: buildTasteSummary(user),
      moodRules: user.moodRulesMd,
      updatedAt: user.updatedAt,
    });
  });

  app.get('/api/plan/today', (req, res) => {
    const tz = typeof req.headers['x-timezone'] === 'string' ? req.headers['x-timezone'] : undefined;
    res.json(buildPlanToday(new Date(), tz));
  });

  app.post('/api/queue/skip', (_req, res) => {
    const r = queue.skip();
    stream.broadcast({ type: 'now_playing', payload: queue.getNow() });
    stream.broadcast({ type: 'queue', items: queue.peek(8) });
    res.json({ ok: r.ok, newHead: r.newHead });
  });

  if (process.env.DEBUG_CONTEXT === '1') {
    app.get('/api/debug/context-redacted', (_req, res) => {
      const user = loadUserBundle();
      const fragments = redactForDump(
        assembleContext({ user, userText: 'debug', now: new Date(), timezone: 'debug' }),
      );
      res.json(fragments);
    });
  }

  return app;
}
