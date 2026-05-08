export type MoodTag = 'neutral' | 'calm' | 'focus' | 'uplift' | 'nostalgic';

export type QueueKind = 'music' | 'voice' | 'idle';

export interface PlayInstruction {
  ncmSongId: string;
  reason: string;
}

export interface DjScript {
  schemaVersion: number;
  say: string;
  play: PlayInstruction[];
  moodTag: MoodTag;
  segue: string;
  telemetry?: { confidence?: number };
}

export interface QueueItem {
  kind: QueueKind;
  title?: string;
  artist?: string;
  url?: string;
  /** 外链同源代理播放地址（与 CONTRACT `/api/audio/proxy` 对应）；存在时 Client 应优先用于 `<audio>`。 */
  proxiedUrl?: string;
  durationMs: number;
  ncmSongId?: string;
  minimaxClipId?: string;
  moodTag: MoodTag;
  traceId?: string;
}

export interface NowPlaying {
  type: QueueKind;
  title?: string;
  artist?: string;
  url?: string;
  /** 外链经同源代理后的播放 URL；优先于 `url` 写入 `<audio>` 以便 MediaElementSource。 */
  proxiedUrl?: string;
  positionMs: number;
  durationMs?: number;
  moodTag: MoodTag;
  minimaxClipId?: string;
  ncmSongId?: string;
  traceId?: string;
}
