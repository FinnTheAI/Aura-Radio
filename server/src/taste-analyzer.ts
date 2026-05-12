import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { CloudFavoriteRowDb, CloudHistoryRowDb } from './db.js';
import { listCloudFavorites, listCloudHistory } from './db.js';

export interface CloudTasteAnalysis {
  generatedAtIso: string;
  favoritesRows: number;
  historyRows: number;
  /** 红心 + 收藏歌单曲目上的艺人频次（听歌习惯主轴） */
  artistsTop10: { name: string; count: number }[];
  /** 艺人频次 Top30 */
  artistsTop30: { name: string; count: number; shareOfArtistMentions: string }[];
  /** 艺人频次 Top100 */
  artistsTop100: { name: string; count: number; shareOfArtistMentions: string }[];
  /** 近似「风格标签」快照（专辑 tags、Enhanced 可选标签、歌单来源等）；后续可再接专用曲风 API */
  genreTagDistribution: Record<string, number>;
  /** @deprecated 同 genreTagDistribution，保留兼容别名 */
  tagDistribution: Record<string, number>;
  /** hour 0–23，来自云端最近播放条目上的时间戳 */
  hourlyListening: { hour: number; count: number }[];
  /** 自动画像 Markdown（写入 taste-cloud.md） */
  markdown: string;
}

function parseArtists(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
  } catch {
    return [];
  }
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [];
  } catch {
    return [];
  }
}

function topN(map: Map<string, number>, n: number): { name: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/** 仅从 `cloud_favorites`（红心 + 收藏歌单曲目）抽取艺人频次，驱动「网易云收藏取向」叙事。 */
function artistCountsFromFavorites(rows: CloudFavoriteRowDb[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const artists = parseArtists(r.artists_json);
    for (const name of artists) {
      const k = name.trim();
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}

/** 标签分布：每条 favorite / history 的 tags_json（含专辑:、歌单:、来源:） */
function tagCounts(rows: CloudFavoriteRowDb[], history: CloudHistoryRowDb[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    for (const t of parseTags(r.tags_json)) {
      const k = t.trim();
      if (!k || k.startsWith('来源:')) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  for (const h of history) {
    for (const t of parseTags(h.tags_json)) {
      const k = t.trim();
      if (!k || k.startsWith('来源:')) continue;
      m.set(`最近:${k}`, (m.get(`最近:${k}`) ?? 0) + 1);
    }
  }
  return m;
}

function hourlyFromHistory(history: CloudHistoryRowDb[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let h = 0; h < 24; h++) m.set(h, 0);
  for (const r of history) {
    let hour =
      typeof r.hour_of_day === 'number' && r.hour_of_day >= 0 && r.hour_of_day < 24 ? r.hour_of_day : null;
    if (hour === null && typeof r.play_ts === 'number' && r.play_ts > 1e11) {
      hour = new Date(r.play_ts).getHours();
    }
    if (hour === null) continue;
    m.set(hour, (m.get(hour) ?? 0) + 1);
  }
  return m;
}

/** 聚合 SQLite 中云端快照，并可生成 Markdown 画像正文。 */
export function analyzeCloudTasteFromDb(): CloudTasteAnalysis {
  const favs = listCloudFavorites();
  const hist = listCloudHistory();
  const favCount = favs.length;
  const histCount = hist.length;

  const artistMap = artistCountsFromFavorites(favs);
  const artistMentionTotal = [...artistMap.values()].reduce((a, b) => a + b, 0);
  const artistsTop10 = topN(artistMap, 10);
  const artistsTop30 = topN(artistMap, 30).map((row) => ({
    ...row,
    shareOfArtistMentions: `${((row.count / artistMentionTotal) * 100).toFixed(1)}%`,
  }));
  const artistsTop100 = topN(artistMap, 100).map((row) => ({
    ...row,
    shareOfArtistMentions: `${((row.count / artistMentionTotal) * 100).toFixed(1)}%`,
  }));
  const tagMap = tagCounts(favs, hist);
  const tagDistribution = Object.fromEntries(topN(tagMap, 40).map((x) => [x.name, x.count]));

  const hourMap = hourlyFromHistory(hist);
  const hourlyListening = [...hourMap.entries()].map(([hour, count]) => ({ hour, count }));

  const lines: string[] = [];
  lines.push('# 网易云听歌画像（自动生成）');
  lines.push('');
  lines.push(`- 生成：${new Date().toISOString()}`);
  lines.push(`- 云端收藏条目（红心 + 收藏的他人歌单曲）：${favCount}`);
  lines.push(`- 云端最近收听样本：${histCount}`);
  lines.push('');
  lines.push('## 基于收藏的艺人 Top 10');
  if (artistsTop10.length === 0) {
    lines.push('_暂无数据——请配置 MUSIC_U / NETEASE_UID 后执行云端同步（GET /api/taste?source=cloud）。_');
  } else {
    for (const [i, row] of artistsTop10.entries()) {
      lines.push(`${i + 1}. ${row.name} · ${row.count} 首（按收藏条目计次）`);
    }
  }
  lines.push('');
  lines.push('## 标签 / 风味分布（快照）');
  const tagKeys = Object.keys(tagDistribution).slice(0, 24);
  if (!tagKeys.length) lines.push('_标签稀疏：取决于歌曲详情是否带回专辑等信息。_');
  else lines.push(tagKeys.map((k) => `- ${k}: ${tagDistribution[k]}`).join('\n'));
  lines.push('');
  lines.push('## 时段分布（按最近播放条目）');
  const peakHours = hourlyListening.filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
  if (!peakHours.length) {
    lines.push('_无时间戳或未同步最近收听。_');
  } else {
    for (const h of peakHours.slice(0, 8)) lines.push(`- ${String(h.hour).padStart(2, '0')}:xx — ${h.count} 条`);
  }
  lines.push('');

  const md = lines.join('\n');

  const nowIso = new Date().toISOString();
  return {
    generatedAtIso: nowIso,
    favoritesRows: favCount,
    historyRows: histCount,
    artistsTop10,
    artistsTop30,
    artistsTop100,
    genreTagDistribution: { ...tagDistribution },
    tagDistribution: { ...tagDistribution },
    hourlyListening,
    markdown: md,
  };
}

export function writeCloudTasteMarkdown(md: string, outPath?: string): string {
  const p = outPath ?? path.join(config.userDataDir, 'taste-cloud.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, md, 'utf8');
  return p;
}
