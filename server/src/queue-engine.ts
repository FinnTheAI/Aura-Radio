import { randomUUID } from 'node:crypto';
import { applyProxiedPlaybackUrl } from './audio-proxy.js';
import { config } from './config.js';
import { persistPlay } from './context-builder.js';
import { log } from './logger.js';
import { ncmSongDetail, ncmSongUrl } from './ncma.js';
import type { DjScript, MoodTag, NowPlaying, QueueItem } from './types.js';
import type { StreamHub } from './stream-hub.js';
import { generateTtsAudio } from './tts.js';

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

export class QueueEngine {
  private pending: QueueItem[] = [];
  private active: Active | null = null;
  private lastMood: MoodTag = 'neutral';
  private timer: NodeJS.Timeout | null = null;
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
    if (elapsed >= this.active.item.durationMs) {
      this.advance();
    }
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
    options?: { skipLeadingVoice?: boolean; djAnnounce?: boolean | string }
  ) {
    if (script.play.length === 0) return;

    const skipLeadingVoice = options?.skipLeadingVoice ?? false;
    const [first, ...rest] = script.play;

    // 生成 TTS 口播（若未跳过且有 say 文本）
    if (!skipLeadingVoice && script.say?.trim()) {
      try {
        const sayText = `${script.say} ${script.segue ?? ''}`.trim();
        const tts = await generateTtsAudio(sayText, { cacheKeySuffix: traceId });
        this.pending.push({
          kind: 'voice',
          title: 'DJ 口播',
          url: tts.url,
          durationMs: tts.durationMs,
          moodTag: script.moodTag,
          traceId,
          sayText: script.say,
        });
        log.info('TTS voice enqueued', { traceId, durMs: tts.durationMs });
      } catch (e) {
        log.warn('TTS voice generation failed, continuing without voice', { err: String(e) });
      }
    }

    const { url, durationMs } = await ncmSongUrl(first.ncmSongId);

    this.pending.push({
      kind: 'music',
      title: `ncm:${first.ncmSongId}`,
      artist: '加载中…',
      url,
      durationMs: Math.min(durationMs, 600_000),
      ncmSongId: first.ncmSongId,
      moodTag: script.moodTag,
      traceId,
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
      const items: QueueItem[] = await Promise.all(
        rest.map(async (p) => {
          const meta = await ncmSongDetail(p.ncmSongId);
          const { url: u, durationMs: d } = await ncmSongUrl(p.ncmSongId);
          return {
            kind: 'music' as const,
            title: meta.name,
            artist: meta.artists.join(' / '),
            url: u,
            durationMs: Math.min(d, 600_000),
            ncmSongId: p.ncmSongId,
            moodTag,
            traceId,
          };
        }),
      );
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

  /** 丢弃当前与排队项，立即按新脚本重建队列（用于「换一段」）。 */
  async resetQueueAndEnqueueFromScript(script: DjScript, traceId: string) {
    this.pending.length = 0;
    this.active = null;
    await this.enqueueFromScript(script, traceId);
  }
}

export function newTraceId() {
  return randomUUID();
}
