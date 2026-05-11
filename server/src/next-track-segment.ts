/**
 * 单曲 natural 播完且队列用尽时：再跑一轮 Brain（每轮至多 1x mmx search）追加下一曲。
 */
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';
import { loadUserBundle } from './user-data.js';
import {
  assembleContext,
  persistAssistantJson,
  persistUserTurn,
} from './context-builder.js';
import { generateDjScript } from './brain.js';
import {
  buildSongCandidatesFromNCM,
  formatCandidatesForPrompt,
  resolvePlayFromDiscovery,
} from './song-candidates.js';
import type { PlaybackDrainedMusicMeta, QueueEngine } from './queue-engine.js';
import { getPlaybackMode } from './playback-mode.js';
import { buildOfflineFolderDjScript } from './offline-playback.js';
import { normalizeMoodTag } from './taste-mood.js';

let inFlight = false;
let lastRunAt = 0;

export function scheduleNextTrackDiscovery(queue: QueueEngine, prev: PlaybackDrainedMusicMeta): void {
  if (getPlaybackMode() === 'offline') {
    const now = Date.now();
    if (now - lastRunAt < config.nextTrackDiscoveryCooldownMs) {
      log.debug('offline next-track cooldown', { ms: config.nextTrackDiscoveryCooldownMs });
      return;
    }
    if (inFlight) {
      log.debug('offline next-track in flight');
      return;
    }
    inFlight = true;
    lastRunAt = now;
    void (async () => {
      const traceId = randomUUID();
      try {
        const { script, djAnnounce } = buildOfflineFolderDjScript(
          '上一曲已播毕，续播本地目录中的下一首。',
        );
        persistUserTurn('(系统自动：离线续播)', traceId);
        const { moodTag: normalized } = normalizeMoodTag(script.moodTag);
        persistAssistantJson(
          JSON.stringify({ script, normalized, source: 'offline-next-track' }),
          traceId,
        );
        await queue.enqueueFromScript(script, traceId, { skipLeadingVoice: true, djAnnounce });
        log.info('offline next-track enqueued', { traceId });
      } catch (e) {
        log.warn('offline next-track failed', { err: String(e) });
      } finally {
        inFlight = false;
      }
    })();
    return;
  }

  if (config.brainMock) return;
  if (!prev.ncmSongId?.trim()) {
    log.debug('next-track discovery skip: missing ncmSongId');
    return;
  }
  const now = Date.now();
  if (now - lastRunAt < config.nextTrackDiscoveryCooldownMs) {
    log.debug('next-track discovery cooldown', { ms: config.nextTrackDiscoveryCooldownMs });
    return;
  }
  if (inFlight) {
    log.debug('next-track discovery in flight');
    return;
  }

  inFlight = true;
  lastRunAt = now;

  void (async () => {
    const traceId = randomUUID();
    try {
      const user = loadUserBundle();
      const candidates = await buildSongCandidatesFromNCM();
      const songCandidatesPrompt = formatCandidatesForPrompt(candidates);

      persistUserTurn('(系统自动：一曲播毕接下一曲)', traceId);

      const fragments = assembleContext({
        user,
        userText: `刚播毕《${prev.title ?? '?'}》（${prev.artist ?? '?'}）；请接上情绪递进的下一首单曲，口吻简洁。`,
        now: new Date(),
        nowPlaying: queue.getNow(),
        includeCloudTaste: true,
        songCandidatesPrompt,
        segmentNextTrack: true,
        lastFinishedSong: {
          title: prev.title,
          artist: prev.artist,
          ncmSongId: prev.ncmSongId,
          moodTag: prev.moodTag,
        },
      });

      const { script: rawScript, normalized, usedFallback } = await generateDjScript(fragments, {
        mmxInvocationId: traceId,
      });
      const script = { ...rawScript, play: await resolvePlayFromDiscovery(rawScript.play, candidates) };

      persistAssistantJson(
        JSON.stringify({ script, normalized, usedFallback, source: 'next-track-discovery' }),
        traceId,
      );

      /** 一曲播毕自动接歌：不再插入一整段前置口播（易与上一段立意重复，且拉长空档）。 */
      await queue.enqueueFromScript(script, traceId, { skipLeadingVoice: true });
      log.info('next-track discovery enqueued', { traceId, usedFallback });
    } catch (e) {
      log.warn('next-track discovery failed', { err: String(e) });
    } finally {
      inFlight = false;
    }
  })();
}
