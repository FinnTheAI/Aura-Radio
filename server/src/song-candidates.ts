/**
 * Brain 兜底曲池：**不含** cloud_favorites；仅云端口味 Top 艺人 → NCM 热门（24h 缓存）。
 * 主线：`discoveryNote` → `resolvePlayFromDiscovery` → `ncmSearch` 落成真实 `ncmSongId`。
 */
import { kvGet, kvSet } from './db.js';
import { OFFLINE_DISCOVERY_PREFIX } from './favorites.js';
import { LOCAL_FS_PREFIX } from './offline-playback.js';
import { analyzeCloudTasteFromDb } from './taste-analyzer.js';
import { ncmArtistHotSongMetas, ncmSearch, ncmSearchArtistFirstId, ncmArtistDetail } from './ncma.js';
import { log } from './logger.js';

const KV_KEY = 'aura_brain_song_candidates_v1';
export const CANDIDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const TOP_ARTISTS_TO_FETCH = 18;
const HOT_PER_ARTIST = 6;
const TOTAL_CAP = 100;

export interface SongCandidate {
  ncmSongId: string;
  title: string;
  artists: string[];
  album?: string;
  blurb: string;
  artistGenre?: string;
  artistDescription?: string;
}

interface CacheEnvelope {
  cachedAtMs: number;
  items: SongCandidate[];
}

function uniqPush(bucket: SongCandidate[], seen: Set<string>, cand: SongCandidate | null): void {
  if (!cand || !/^\d+$/.test(cand.ncmSongId)) return;
  if (seen.has(cand.ncmSongId)) return;
  seen.add(cand.ncmSongId);
  bucket.push(cand);
}

async function rebuildCandidatesFresh(): Promise<SongCandidate[]> {
  const bucket: SongCandidate[] = [];
  const seen = new Set<string>();

  let tasteArtists: { name: string; count: number }[] = [];
  try {
    const t = analyzeCloudTasteFromDb();
    if (t.artistsTop100?.length)
      tasteArtists = t.artistsTop100.map(({ name, count }) => ({ name, count }));
    else tasteArtists = t.artistsTop30?.map(({ name, count }) => ({ name, count })) ?? [];
    if (!tasteArtists.length) tasteArtists = t.artistsTop10.map(({ name, count }) => ({ name, count }));
  } catch {
    /** */
  }

  const names = [...new Set(tasteArtists.map((a) => a.name.trim()))].slice(0, TOP_ARTISTS_TO_FETCH);
  for (const nm of names) {
    if (bucket.length >= TOTAL_CAP) break;
    let gotHot = 0;
    try {
      const ar = await ncmSearchArtistFirstId(nm);
      if (ar?.id) {
        const hot = await ncmArtistHotSongMetas(ar.id, HOT_PER_ARTIST);
        for (const h of hot) {
          let artistGenre: string | undefined;
          let artistDesc: string | undefined;
          try {
            const ad = await ncmArtistDetail(ar.id);
            artistGenre = ad.genre.slice(0, 3).join('/');
            artistDesc = ad.description.slice(0, 300);
          } catch { /** */ }
          uniqPush(bucket, seen, {
            ncmSongId: h.id,
            title: h.name,
            artists: h.artists.length ? h.artists : [ar.name],
            album: h.album,
            blurb: `艺人「${ar.name}」热门（Artist TopSong）。`,
            artistGenre,
            artistDescription: artistDesc,
          });
          gotHot += 1;
          if (bucket.length >= TOTAL_CAP) break;
        }
      }
    } catch (e) {
      log.warn('[song-candidates] artist hot pipeline', { nm, err: String(e) });
    }
    if (gotHot === 0 && bucket.length < TOTAL_CAP) {
      try {
        const songs = await ncmSearch(nm, 6);
        for (const s of songs) {
          uniqPush(bucket, seen, {
            ncmSongId: s.id,
            title: s.name,
            artists: s.artists,
            album: undefined,
            blurb: `关键词「${nm}」云搜单曲（兜底）。`,
          });
          if (bucket.length >= TOTAL_CAP) break;
        }
      } catch {
        /** */
      }
    }
  }

  return bucket.slice(0, TOTAL_CAP);
}

export function formatCandidatesForPrompt(items: SongCandidate[]): string {
  const head = [
    '## `# songCandidates`（仅兜底，非主推荐源）',
    '',
    '- **主线**：你已用 **`# mmxCliGate`** 通过 **mmx-cli search**；**单次 Brain 至多 1 次 search**，`play` 当前固定 **1 首歌**；播完再起下一轮自动接续。**每项**须含 **`discoveryNote`**。',
    '- **禁止**从 `cloud_favorites`（用户网易云收藏同步）中选歌或直接抄其单曲 ID。',
    '- `ncmSongId` Brain 可先写占位；服务端会用 `discoveryNote` 调网易云搜索落成真实 ID。**禁止凭想象编造网易云 ID**。',
    '- 下列 JSON 仅在「无 discoveryNote / NCM 搜索失败」时作 **fallback**，优先选池中曲目并说明原因。',
    '',
  ];

  if (!items.length) {
    return (
      head.join('\n') +
      [
        '当前兜底池为空（口味艺人 NCM 拉取失败或尚未缓存）。',
        '',
        '**仍须输出 1 条 `play`**：`ncmSongId` 可写 `"0"`；**`discoveryNote` 必填**，内容为可交给网易云搜索的中英文关键词（服务端单次只解析一条；下一轮在用户播完后触发）。',
        '**禁止**输出空数组 `play: []`（除非用户明确要求不播歌）。',
      ].join('\n')
    );
  }

  const payload = items.map((c) => ({
    ncmSongId: c.ncmSongId,
    title: c.title,
    artists: c.artists,
    album: c.album ?? null,
    blurb: c.blurb,
    artistGenre: c.artistGenre ?? null,
    artistDescription: c.artistDescription ?? null,
  }));

  const lines = [
    ...head,
    '兜底候选（每行 JSON）：',
    '',
    payload.map((row) => JSON.stringify(row)).join('\n'),
  ];
  return lines.join('\n');
}

/**
 * 构建曲池并读/写 SQLite 缓存（默认 TTL 24h）。
 * `_cloudTaste` 占位与口味文档对齐（当前直接从 DB `analyzeCloudTasteFromDb` 取 Top 艺人）。
 */
export async function buildSongCandidatesFromNCM(_cloudTaste?: string): Promise<SongCandidate[]> {
  const raw = kvGet(KV_KEY);
  if (raw) {
    try {
      const env = JSON.parse(raw) as CacheEnvelope;
      if (env.cachedAtMs && Date.now() - env.cachedAtMs < CANDIDATE_CACHE_TTL_MS && Array.isArray(env.items) && env.items.length) {
        return env.items;
      }
    } catch {
      /** */
    }
  }

  log.info('[song-candidates] rebuilding cache…');
  const items = await rebuildCandidatesFresh();
  try {
    kvSet(KV_KEY, JSON.stringify({ cachedAtMs: Date.now(), items } satisfies CacheEnvelope));
  } catch (e) {
    log.warn('[song-candidates] kv write failed', String(e));
  }
  return items;
}

/**
 * 根据 Brain 输出的 discoveryNote 搜索解析为真实 ncmSongId。
 * 若失败才走候选池 fallback（保持向后兼容）。
 */
export async function resolvePlayFromDiscovery(
  play: Array<{ ncmSongId: string; reason: string; discoveryNote?: string }>,
  candidates: SongCandidate[],
): Promise<Array<{ ncmSongId: string; reason: string; discoveryNote?: string }>> {
  const resolved: Array<{ ncmSongId: string; reason: string; discoveryNote?: string }> = [];

  for (const p of play) {
    if (p.discoveryNote?.startsWith(OFFLINE_DISCOVERY_PREFIX)) {
      resolved.push({
        ncmSongId: p.ncmSongId,
        reason: p.reason,
        discoveryNote: p.discoveryNote,
      });
      continue;
    }

    if (p.discoveryNote?.startsWith(LOCAL_FS_PREFIX)) {
      resolved.push({
        ncmSongId: p.ncmSongId,
        reason: p.reason,
        discoveryNote: p.discoveryNote,
      });
      continue;
    }

    if (p.discoveryNote) {
      // 从 discoveryNote 提取关键词搜索 NCM
      try {
        const songs = await ncmSearch(p.discoveryNote, 3);
        if (songs.length > 0) {
          resolved.push({ ncmSongId: songs[0]!.id, reason: p.reason });
          continue;
        }
      } catch { /** */ }
    }

    // fallback：检查预建候选池
    const allowed = new Set(candidates.map(c => c.ncmSongId));
    if (allowed.has(p.ncmSongId)) {
      resolved.push({ ncmSongId: p.ncmSongId, reason: p.reason });
    } else if (candidates.length > 0) {
      const first = candidates[0]!;
      resolved.push({
        ncmSongId: first.ncmSongId,
        reason: `[候选修正] ${p.ncmSongId} 不可用，fallback《${first.title}》- ${first.artists.join('/')}`,
      });
    }
  }

  return resolved;
}
