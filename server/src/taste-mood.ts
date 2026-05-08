import type { MoodTag } from './types.js';

export const MOOD_WHITELIST: ReadonlySet<string> = new Set(['neutral', 'calm', 'focus', 'uplift', 'nostalgic']);

export function normalizeMoodTag(raw: string | undefined): { moodTag: MoodTag; coerced: boolean } {
  const v = (raw ?? 'neutral').toLowerCase();
  if (MOOD_WHITELIST.has(v)) return { moodTag: v as MoodTag, coerced: false };
  return { moodTag: 'neutral', coerced: true };
}

/** 由本地时间小时 + 可读规则给出的「会话情绪」基线（非模型输出）。 */
export function deriveSessionMood(now = new Date()): { moodTag: MoodTag; explain: string } {
  const h = now.getHours();
  if (h >= 9 && h < 12) {
    return { moodTag: 'focus', explain: '作息规则：09:30–12:30 深度工作块，默认 focus。' };
  }
  if (h >= 7 && h < 9) {
    return { moodTag: 'uplift', explain: '作息规则：早晨苏醒块，偏 uplift。' };
  }
  if (h >= 12 && h < 14) {
    return { moodTag: 'calm', explain: '作息规则：午间 calm。' };
  }
  if (h >= 22 || h < 6) {
    return { moodTag: 'nostalgic', explain: '作息规则：深夜 nostalgic / calm 倾向。' };
  }
  return { moodTag: 'neutral', explain: '无强时段规则命中，使用 neutral 基线。' };
}

export function buildTasteSummary(user: {
  tasteMd: string;
  playlists: { favorites?: { ncmSongId: string }[]; work?: { ncmSongId: string }[] };
}): Record<string, unknown> {
  return {
    tasteExcerpt: user.tasteMd.slice(0, 400),
    playlistStats: {
      favorites: user.playlists.favorites?.length ?? 0,
      work: user.playlists.work?.length ?? 0,
    },
  };
}
