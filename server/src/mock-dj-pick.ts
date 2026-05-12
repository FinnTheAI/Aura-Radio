import type { MoodTag } from './types.js';

/** Brain / MiniMax 离线 Mock：避免非 focus 情绪稳定落到同一首（如 441491828）。 */
const MOCK_FOCUS_IDS = ['29764564', '186016', '29732209', '4017469'] as const;

const MOCK_GENERAL_IDS = [
  '29764564',
  '186016',
  '29732209',
  '4017469',
  '482992710',
  '1398663411',
  '441491828',
] as const;

export function pickMockNcmSongId(moodTag: MoodTag): string {
  const pool = moodTag === 'focus' ? MOCK_FOCUS_IDS : MOCK_GENERAL_IDS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
