import { randomUUID } from 'node:crypto';
import { applyProxiedPlaybackUrl } from './audio-proxy.js';
import { config } from './config.js';
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

  async enqueueFromScript(script: DjScript, traceId: string) {
    const items: QueueItem[] = [];

    const voiceAllowed = script.moodTag !== 'focus' && script.say.trim().length > 0;
    if (voiceAllowed) {
      items.push({
        kind: 'voice',
        title: 'Aura DJ',
        durationMs: 18_000,
        url: config.minimaxMockVoiceUrl,
        moodTag: script.moodTag,
        minimaxClipId: `clip-${traceId.slice(0, 8)}`,
        traceId,
      });
    }

    for (const p of script.play) {
      const meta = await ncmSongDetail(p.ncmSongId);
      const { url, durationMs } = await ncmSongUrl(p.ncmSongId);
      items.push({
        kind: 'music',
        title: meta.name,
        artist: meta.artists.join(' / '),
        url,
        durationMs: Math.min(durationMs, 600_000),
        ncmSongId: p.ncmSongId,
        moodTag: script.moodTag,
        traceId,
      });
    }

    if (items.length === 0) {
      items.push({
        kind: 'idle',
        durationMs: 3_000,
        moodTag: script.moodTag,
        traceId,
      });
    }

    this.pending.push(...items);
    this.emit();
    if (!this.active) this.popNext();
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
