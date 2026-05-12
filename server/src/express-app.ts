import path from 'node:path';
import express from 'express';
import cors from 'cors';
import type { QueueEngine } from './queue-engine.js';
import { newTraceId } from './queue-engine.js';
import { loadUserBundle } from './user-data.js';
import { assembleContext, persistUserTurn, persistAssistantJson, redactForDump } from './context-builder.js';
import { generateDjScript, BrainUnavailableError } from './brain.js';
import { buildPlanToday } from './scheduler.js';
import { handleAudioProxyGet } from './audio-proxy.js';
import { config } from './config.js';
import { log } from './logger.js';
import type { StreamHub } from './stream-hub.js';
import { buildTasteSummary, normalizeMoodTag } from './taste-mood.js';
import type { DjScript } from './types.js';
import { extractPlayKeyword, searchSongHitsForPlayIntent, type CliSongHit } from './netease-cli-adapter.js';
import { analyzeCloudTasteFromDb, writeCloudTasteMarkdown } from './taste-analyzer.js';
import { neteaseCloudSyncEligible, syncNeteaseCloudToSqlite } from './netease-cloud-sync.js';
import { registerOfflineFavoriteRoutes, cleanupOfflineFavoritesOrphans } from './favorites.js';
import { buildSongCandidatesFromNCM, formatCandidatesForPrompt, resolvePlayFromDiscovery } from './song-candidates.js';
import { getPlaybackMode, setPlaybackMode } from './playback-mode.js';
import { buildOfflineFolderDjScript, registerLocalAudioFileRoute } from './offline-playback.js';

function djScriptFromCliHit(hit: CliSongHit, keyword: string): DjScript {
  return {
    schemaVersion: 1,
    say: `好，这就给你接上《${hit.name}》，音源马上来。`,
    play: [{ ncmSongId: hit.ncmSongId, reason: `点播「${keyword}」→ ncmSearch 首条` }],
    moodTag: 'neutral',
    segue: '开始播放。',
  };
}

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

  registerOfflineFavoriteRoutes(app, stream);
  registerLocalAudioFileRoute(app);

  /* 启动时清理：DB 标记已下载、但文件缺失的离线收藏行 */
  try { cleanupOfflineFavoritesOrphans(); } catch { /* */ }

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
      const skipCandidateBuild = process.env.AURA_SKIP_NCM_CANDIDATES === '1';
      const candidates = skipCandidateBuild ? [] : await buildSongCandidatesFromNCM();
      const songCandidatesPrompt = formatCandidatesForPrompt(candidates);
      const fragments = assembleContext({
        user,
        userText: text,
        now: new Date(),
        timezone: typeof req.headers['x-timezone'] === 'string' ? req.headers['x-timezone'] : undefined,
        nowPlaying: queue.getNow(),
        songCandidatesPrompt,
      });

      persistUserTurn(text, traceId);

      if (config.neteaseCliPlayEnabled) {
        const keyword = extractPlayKeyword(text);
        if (process.env.DEBUG_PLAY_INTENT === '1') {
          log.warn('hit play-intent branch', { textUtf8Preview: JSON.stringify(text.slice(0, 48)) });
          log.warn('keyword extracted', { kwJson: keyword === null ? null : JSON.stringify(keyword) });
        }
        if (keyword) {
          try {
            const hits = await searchSongHitsForPlayIntent(keyword, 8);
            if (hits.length) {
              let script = djScriptFromCliHit(hits[0], keyword);
              let { moodTag, coerced } = normalizeMoodTag(script.moodTag);
              if (coerced) log.warn('/api/chat cli play moodTag coerced');
              script = { ...script, moodTag };
              persistAssistantJson(
                JSON.stringify({
                  source: 'netease-ncma-play-intent',
                  keyword,
                  picked: hits[0],
                  script,
                }),
                traceId,
              );
              const replaceQueue = Boolean(req.body?.replaceQueue);
              if (replaceQueue) {
                await queue.resetQueueAndEnqueueFromScript(script, traceId);
              } else {
                await queue.enqueueFromScript(script, traceId);
              }
              return res.json({
                djScript: { ...script, moodTag },
                queued: true,
                traceId,
              });
            }
            log.warn('/api/chat play-intent search empty', { keyword });
          } catch (e) {
            log.warn('/api/chat play-intent failed, falling through to brain', {
              err: String(e),
              textUtf8Preview: JSON.stringify(text.slice(0, 48)),
            });
          }
        } else {
          if (process.env.DEBUG_PLAY_INTENT === '1') {
            log.warn('/api/chat play-intent: extractPlayKeyword returned null', {
              textUtf8Preview: JSON.stringify(text.slice(0, 48)),
            });
          }
        }
      }

      const { script: rawScript, normalized, usedFallback } = await generateDjScript(fragments);
      if (usedFallback) {
        log.info('/api/chat used MiniMax HTTP instead of local Claude CLI', { traceId });
      }

      // 通过 discoveryNote → NCM 搜索解析真实 ncmSongId（修复 "0" 占位）
      const resolved = await resolvePlayFromDiscovery(rawScript.play, candidates);
      const script = { ...rawScript, play: resolved };

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
      if (e instanceof BrainUnavailableError) {
        const tid =
          (typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
            ? req.body.sessionId.trim()
            : undefined) ?? newTraceId();
        stream.broadcast({ type: 'error', message: e.message, traceId: tid });
        res.status(503).json({
          error: e.message,
          code: e.code,
          hint: '仅当显式设置 BRAIN_MOCK=1 时使用占位 DJ 脚本（开发与离线验收）。',
          traceId: tid,
        });
        return;
      }
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

  app.get('/api/taste', async (req, res) => {
    try {
      const sourceRaw =
        typeof req.query.source === 'string' ? req.query.source.trim().toLowerCase() : '';
      const refreshQ = typeof req.query.refresh === 'string' ? req.query.refresh.trim().toLowerCase() : '';
      const skipRefresh = refreshQ === '0' || refreshQ === 'false';
      const forceMergedRefresh =
        refreshQ === '1' ||
        refreshQ === 'yes' ||
        refreshQ === 'true' ||
        refreshQ === 'on';

      const computeCloudSlice = async (forceSync: boolean) => {
        const withMarkdown = (
          analysis: ReturnType<typeof analyzeCloudTasteFromDb>,
        ): { markdownPath?: string; markdownRelative?: string } => {
          try {
            const markdownPath = writeCloudTasteMarkdown(analysis.markdown);
            const markdownRelative =
              path.relative(process.cwd(), markdownPath).replace(/\\/g, '/') || markdownPath;
            return { markdownPath, markdownRelative };
          } catch {
            return {};
          }
        };

        if (!neteaseCloudSyncEligible()) {
          const analysis = analyzeCloudTasteFromDb();
          return {
            configured: false,
            synced: false,
            message:
              config.ncmMock || !config.ncmApiBaseUrl
                ? '云端口味需要 NCM_API_BASE_URL（或 NCM_ALLOW_LOCAL_DEFAULT=1）且 NCM_MOCK=0'
                : '未检测到登录 Cookie，请在本地 .env 配置 MUSIC_U 或 NCM_UPSTREAM_COOKIE',
            ...analysis,
            ...withMarkdown(analysis),
          };
        }

        if (forceSync) {
          const sr = await syncNeteaseCloudToSqlite();
          if (!sr.ok) {
            const analysis = analyzeCloudTasteFromDb();
            return {
              configured: true,
              synced: false,
              syncMessage: sr.message,
              ...analysis,
              ...withMarkdown(analysis),
            };
          }
          const analysis = analyzeCloudTasteFromDb();
          return {
            configured: true,
            synced: true,
            lastPull: { favorites: sr.favorites, history: sr.history },
            ...analysis,
            ...withMarkdown(analysis),
          };
        }

        const analysis = analyzeCloudTasteFromDb();
        return {
          configured: true,
          synced: false,
          ...analysis,
          ...withMarkdown(analysis),
        };
      };

      if (sourceRaw === 'cloud') {
        const forceSync = !skipRefresh;
        const slice = await computeCloudSlice(forceSync);
        return res.json({ source: 'cloud', cloud: slice });
      }

      const user = loadUserBundle();
      const base = {
        taste: buildTasteSummary(user),
        moodRules: user.moodRulesMd,
        updatedAt: user.updatedAt,
      };

      let cloudMerged: Awaited<ReturnType<typeof computeCloudSlice>> | undefined;
      if (!sourceRaw || sourceRaw === 'merged' || sourceRaw === 'all' || sourceRaw === 'full') {
        cloudMerged = await computeCloudSlice(forceMergedRefresh || false);
      } else if (sourceRaw !== 'local') {
        return res.status(400).json({ error: `unknown taste source=${sourceRaw}` });
      }

      res.json({
        ...base,
        ...(cloudMerged ? { cloud: cloudMerged } : {}),
      });
    } catch (e) {
      log.warn('/api/taste failed', { err: String(e) });
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/plan/today', (req, res) => {
    const tz = typeof req.headers['x-timezone'] === 'string' ? req.headers['x-timezone'] : undefined;
    res.json(buildPlanToday(new Date(), tz));
  });

  app.get('/api/playback-mode', (_req, res) => {
    res.json({ mode: getPlaybackMode() });
  });

  app.post('/api/playback-mode', (req, res) => {
    const raw = req.body?.mode;
    const confirm = Boolean(req.body?.confirm);
    if (!confirm) return res.status(400).json({ error: '需二次确认（body.confirm: true）' });
    if (raw !== 'online' && raw !== 'offline') return res.status(400).json({ error: '非法 mode，仅 online / offline' });
    setPlaybackMode(raw);
    res.json({ mode: raw });
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
