import { randomUUID } from 'node:crypto';
import { applyProxiedPlaybackUrl } from './audio-proxy.js';
import { persistPlay } from './context-builder.js';
import { log } from './logger.js';
import { ncmSongDetail, ncmSongUrl } from './ncma.js';
import type { DjScript, MoodTag, NowPlaying, QueueItem } from './types.js';
import type { StreamHub } from './stream-hub.js';

interface Active {
  item: QueueItem;
  startedAt: number;
  traceId?: string;
}

/** 上一首音乐播放完成时的元数据 */
export interface PlaybackDrainedMusicMeta {
  ncmSongId?: string;
  title?: string;
  artist?: string;
  moodTag: MoodTag;
  durationMs: number;
  traceId?: string;
}

export class PlayableAudioUnavailableError extends Error {
  readonly code = 'PLAYABLE_AUDIO_UNAVAILABLE' as const;
  constructor(message?: string) {
    super(message ?? '暂无可播放音源（请检查 NCM、登录 Cookie，或稍后重试）');
    this.name = 'PlayableAudioUnavailableError';
  }
}

export class QueueEngine {
  private pending: QueueItem[] = [];
  private active: Active | null = null;
  private lastMood: MoodTag = 'neutral';
  private timer: NodeJS.Timeout | null = null;
  /** 浏览器 `<audio ended>` 与远端 tick 可能紧邻触发；防抖避免跳两段 */
  private lastClientEndedAt = 0;
  private lastClientEndedTrace = '';
  private readonly stream: StreamHub;

  constructor(stream: StreamHub) {
    this.stream = stream;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 清空当前播放与排队项（切换在线/离线模式等）；下一轮曲目由此模式的接口重新入队 */
  clearAll(): void {
    this.pending.length = 0;
    this.active = null;
    this.emit();
  }

  private emit() {
    this.stream.broadcast({ type: 'now_playing', payload: this.getNow() });
    this.stream.broadcast({ type: 'queue', items: this.peek(8) });
  }

  private advance() {
    const prev = this.active;
    if (prev?.item.kind === 'music' && prev.item.ncmSongId) {
      persistPlay(prev.item.ncmSongId, prev.item.moodTag, prev.traceId ?? 'unknown');
    }
    this.active = null;
    this.popNext();
  }

  private popNext() {
    if (this.pending.length === 0) {
      this.emit();
      return;
    }
    const item = this.pending.shift()!;
    this.active = { item, startedAt: Date.now(), traceId: item.traceId };
    this.lastMood = item.moodTag;
    log.info('now playing', item.kind, item.title ?? item.url);
    this.emit();
  }

  tick() {
    if (!this.active) {
      if (this.pending.length) this.popNext();
      return;
    }
    const elapsed = Date.now() - this.active.startedAt;
    const softMs = Math.max(1500, this.active.item.durationMs);
    /** 不以服务端估算时长为准切换（口播 / URL duration 常偏短）；仅卡死恢复 */
    const hardMs = Math.max(softMs * 8, softMs + 240_000, 720_000);
    if (elapsed >= hardMs) {
      log.warn('queue advance: stuck recovery (hard timeout)', {
        kind: this.active.item.kind,
        elapsedMs: elapsed,
        durationMs: this.active.item.durationMs,
      });
      this.advance();
    }
  }

  /** 客户端播放 natural ended → 与队列对齐前进一格（voice/music）。 */
  reportPlaybackEnded(clientTraceId?: string): { ok: boolean; reason?: string } {
    if (!this.active) {
      if (this.pending.length) this.popNext();
      return { ok: false, reason: 'no_active' };
    }
    const curTrace = this.active.traceId;
    if (clientTraceId && curTrace && clientTraceId !== curTrace) {
      return { ok: false, reason: 'trace_mismatch' };
    }
    const now = Date.now();
    if (curTrace && curTrace === this.lastClientEndedTrace && now - this.lastClientEndedAt < 450) {
      return { ok: false, reason: 'debounced' };
    }
    this.lastClientEndedAt = now;
    this.lastClientEndedTrace = curTrace ?? '';
    this.advance();
    return { ok: true };
  }

  peek(limit: number): QueueItem[] {
    const head = this.active ? [this.active.item, ...this.pending] : [...this.pending];
    return head.slice(0, limit).map((item) => applyProxiedPlaybackUrl(item));
  }

  getNow(): NowPlaying {
    if (!this.active) {
      return {
        type: 'idle',
        positionMs: 0,
        durationMs: 0,
        moodTag: this.lastMood,
      };
    }
    const { item, startedAt, traceId } = this.active;
    const positionMs = Math.min(Date.now() - startedAt, item.durationMs);
    return applyProxiedPlaybackUrl({
      type: item.kind,
      title: item.title,
      artist: item.artist,
      url: item.url,
      positionMs,
      durationMs: item.durationMs,
      moodTag: item.moodTag,
      minimaxClipId: item.minimaxClipId,
      ncmSongId: item.ncmSongId,
      traceId,
      sayText: item.sayText,
      djText: item.djText,
    });
  }

  skip(): { ok: boolean; newHead: QueueItem | null } {
    const hadSomething = this.active !== null || this.pending.length > 0;
    this.active = null;
    this.popNext();
    const head: Active | null = this.active as Active | null;
    const raw = head?.item ?? null;
    return { ok: hadSomething, newHead: raw ? applyProxiedPlaybackUrl(raw) : null };
  }

  async enqueueFromScript(
    script: DjScript,
    traceId: string,
    options?: { djAnnounce?: boolean | string },
  ) {
    if (script.play.length === 0) return;

    const ann =
      typeof options?.djAnnounce === 'string' && options.djAnnounce.trim()
        ? options.djAnnounce.trim()
        : '';
    const saySeg = [script.say?.trim(), script.segue?.trim()].filter(Boolean).join('\n\n');
    const djTextMerged = [ann, saySeg].filter(Boolean).join('\n\n') || undefined;

    let chosenIdx = -1;
    let url = '';
    let durationMs = 240_000;
    for (let i = 0; i < script.play.length; i++) {
      const p = script.play[i]!;
      try {
        const r = await ncmSongUrl(p.ncmSongId);
        if (r.url?.trim()) {
          chosenIdx = i;
          url = r.url;
          durationMs = r.durationMs;
          break;
        }
      } catch (e) {
        log.warn('[queue] skip unplayable play[] entry', {
          ncmSongId: p.ncmSongId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (chosenIdx < 0) {
      throw new PlayableAudioUnavailableError();
    }

    const first = script.play[chosenIdx]!;
    const rest = script.play.slice(chosenIdx + 1);

    this.pending.push({
      kind: 'music',
      title: `ncm:${first.ncmSongId}`,
      artist: '加载中…',
      url,
      durationMs: Math.min(durationMs, 600_000),
      ncmSongId: first.ncmSongId,
      moodTag: script.moodTag,
      traceId,
      djText: djTextMerged,
      sayText: script.say?.trim() || undefined,
    });
    this.emit();
    if (!this.active) this.popNext();

    /** 后台补 metadata + 预载 rest（若有）。 */
    void this.loadRestAsNeeded(rest, script.moodTag, traceId, first.ncmSongId);
  }

  private async loadRestAsNeeded(
    rest: DjScript['play'],
    moodTag: MoodTag,
    traceId: string,
    firstSongId: string,
  ) {
    if (rest.length === 0) {
      /** 仅一首时仍异步补全第一首元数据，避免出现长期「ncm:id + 加载中…」 */
      void this.hydratePlayingTitle(firstSongId, moodTag, traceId);
      return;
    }
    try {
      const items: QueueItem[] = [];
      for (const p of rest) {
        try {
          const meta = await ncmSongDetail(p.ncmSongId);
          const { url: u, durationMs: d } = await ncmSongUrl(p.ncmSongId);
          if (!u?.trim()) continue;
          items.push({
            kind: 'music' as const,
            title: meta.name,
            artist: meta.artists.join(' / '),
            url: u,
            durationMs: Math.min(d, 600_000),
            ncmSongId: p.ncmSongId,
            moodTag,
            traceId,
          });
        } catch (e) {
          log.warn('loadRestAsNeeded skip entry', {
            ncmSongId: p.ncmSongId,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
      this.pending.push(...items);
      this.emit();
      if (!this.active) this.popNext();
    } catch (e) {
      log.warn('loadRestAsNeeded failed', { err: String(e) });
    }
    void this.hydratePlayingTitle(firstSongId, moodTag, traceId);
  }

  /** 用 `song/detail` 覆盖当前正在播放条目的占位标题（若仍是首条）。 */
  private async hydratePlayingTitle(ncmSongId: string, moodTag: MoodTag, traceId: string) {
    if (ncmSongId.startsWith('local:')) {
      try {
        const base = decodeURIComponent(ncmSongId.slice('local:'.length));
        const label = base.replace(/\.mp3$/i, '');
        const cur = this.active;
        if (
          !cur ||
          cur.traceId !== traceId ||
          cur.item.kind !== 'music' ||
          cur.item.ncmSongId !== ncmSongId
        ) {
          return;
        }
        cur.item.title = label;
        cur.item.artist = '本地收藏';
        this.emit();
      } catch {
        /** ignore */
      }
      return;
    }
    try {
      const meta = await ncmSongDetail(ncmSongId);
      const cur = this.active;
      if (
        !cur ||
        cur.traceId !== traceId ||
        cur.item.kind !== 'music' ||
        cur.item.ncmSongId !== ncmSongId
      ) {
        return;
      }
      cur.item.title = meta.name;
      cur.item.artist = meta.artists.join(' / ');
      this.emit();
    } catch (e) {
      log.warn('hydratePlayingTitle failed', { ncmSongId, err: String(e) });
    }
  }

  /** 丢弃当前与排队项，立即按新脚本重建队列（用于「下一首」等）。 */
  async resetQueueAndEnqueueFromScript(
    script: DjScript,
    traceId: string,
    options?: { djAnnounce?: boolean | string },
  ) {
    this.pending.length = 0;
    this.active = null;
    await this.enqueueFromScript(script, traceId, options);
  }
}

export function newTraceId() {
  return randomUUID();
}
