/**
 * Brain 兜底曲池：**不含** cloud_favorites；仅云端口味 Top 艺人 → NCM 热门（24h 缓存）。
 * 主线：`discoveryNote` → `resolvePlayFromDiscovery` → `ncmSearch` 落成真实 `ncmSongId`。
 */
import { kvGet, kvSet } from './db.js';
import { OFFLINE_DISCOVERY_PREFIX } from './favorites.js';
import { LOCAL_FS_PREFIX } from './offline-playback.js';
import { config, mergeNcmCookies } from './config.js';
import { analyzeCloudTasteFromDb } from './taste-analyzer.js';
import { deriveSessionMood } from './taste-mood.js';
import {
  ncmArtistHotSongMetas,
  ncmSearch,
  ncmSearchArtistFirstId,
  ncmArtistDetail,
  ncmSongHasPlayableUrl,
} from './ncma.js';
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

/**
 * 供 B 侧 mmx-cli gate **并行 search** 的结构化行（与 `SongCandidate` 一一对应）。
 * `mmxSearchQueries`：短检索词数组，覆盖 **艺人 + 风格/氛围 + 时段/收听场景**，可映射为多路 `mmx-cli search query "…"`.
 */
export interface MmxGateCandidateRow {
  ncmSongId: string;
  title: string;
  artists: string[];
  blurb: string;
  /** 多条可并行发起的检索词（建议每条 ≤ 80 字） */
  mmxSearchQueries: string[];
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

function hourSlotLabelCN(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 9) return '清晨';
  if (h >= 9 && h < 12) return '上午';
  if (h >= 12 && h < 14) return '午间';
  if (h >= 14 && h < 18) return '下午';
  if (h >= 18 && h < 22) return '晚间';
  return '深夜';
}

function firstStyleToken(genre?: string): string {
  if (!genre?.trim()) return '';
  const t = genre.split(/[，,、；;\n]/)[0]?.trim() ?? '';
  return t.slice(0, 40);
}

/**
 * 构造与 mmx-cli / 网易云搜索对齐的多条关键词：**艺人 + 风格 + 时段收听场景**。
 * B 侧可对每条发起并行 `mmx-cli search query "…"`，再与 `ncmSongId` 交叉验证。
 */
export function buildMmxSearchQueriesForCandidate(c: SongCandidate, now = new Date()): string[] {
  const primaryArtist = (c.artists[0] ?? '').trim() || '独立音乐';
  const style = firstStyleToken(c.artistGenre) || '氛围感';
  const slot = hourSlotLabelCN(now);
  const session = deriveSessionMood(now);
  const title = (c.title ?? '').trim();
  const mood = session.moodTag;
  const qs = new Set<string>();
  qs.add(`${primaryArtist} ${style} 冷门 推荐`.replace(/\s+/g, ' ').trim());
  if (title) qs.add(`${primaryArtist} ${title}`.slice(0, 96));
  qs.add(`${slot}听 ${primaryArtist} ${mood}`.replace(/\s+/g, ' ').trim());
  qs.add(`${primaryArtist} 相似风格 华语`.replace(/\s+/g, ' ').trim());
  qs.add(`${session.explain.slice(0, 64)} ${primaryArtist}`.replace(/\s+/g, ' ').trim());
  return [...qs].filter(Boolean).slice(0, 5);
}

export function buildMmxGateCandidateRows(items: SongCandidate[], now = new Date()): MmxGateCandidateRow[] {
  return items.map((c) => ({
    ncmSongId: c.ncmSongId,
    title: c.title,
    artists: c.artists,
    blurb: c.blurb,
    mmxSearchQueries: buildMmxSearchQueriesForCandidate(c, now),
  }));
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
      const arId = await ncmSearchArtistFirstId(nm);
      if (arId) {
        const hot = await ncmArtistHotSongMetas(arId, HOT_PER_ARTIST);
        for (const h of hot) {
          let artistGenre: string | undefined;
          let artistDesc: string | undefined;
          try {
            const ad = await ncmArtistDetail(arId);
            artistGenre = ad?.briefDesc?.slice(0, 100);
            artistDesc = ad?.briefDesc?.slice(0, 300);
          } catch { /** */ }
          uniqPush(bucket, seen, {
            ncmSongId: h.id,
            title: h.name,
            artists: h.artists.length ? h.artists : [nm],
            album: h.album,
            blurb: `艺人「${nm}」热门（Artist TopSong）。`,
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

/** cloudsearch 命中列表：按需逐个探测 `/song/url`，否则随机一首（旧行为）。 */
async function pickPlayableSongIdFromMetas(metas: Array<{ id: string }>): Promise<string | null> {
  const list = metas.filter((m) => /^\d+$/.test(m.id));
  if (list.length === 0) return null;
  const probe = config.ncmDiscoveryProbePlayable && !config.ncmMock && Boolean(config.ncmApiBaseUrl);
  if (!probe) {
    return list[Math.floor(Math.random() * list.length)]!.id;
  }
  for (const m of list) {
    if (await ncmSongHasPlayableUrl(m.id)) return m.id;
  }
  return null;
}

/**
 * NCM 搜索/代理全失败时的最后一首：`song/url` 可能不可用但 yt-dlp 仍可尝试 163 页面；
 * 多 ID 轮换，避免永远卡在单曲（历史上固定为 4017469）。
 */
const ULTIMATE_FALLBACK_NCM_IDS = ['4017469', '29764564', '441491828', '186016', '29732209'] as const;

function pickUltimateFallbackNcmId(
  exclude: Set<string>,
  diag: {
    emergencyKeyword: string;
    brainNcmSongId: string;
    candidatePoolSize: number;
  },
): string {
  const pool = ULTIMATE_FALLBACK_NCM_IDS.filter((id) => !exclude.has(id));
  const pickFrom = pool.length > 0 ? pool : [...ULTIMATE_FALLBACK_NCM_IDS];
  const id = pickFrom[Math.floor(Math.random() * pickFrom.length)]!;
  const cookiePresent = Boolean(mergeNcmCookies().trim());
  log.warn('[song-candidates] ultimate_fallback_pick', {
    event: 'ultimate_fallback_pick',
    pickedNcmSongId: id,
    ncmMock: config.ncmMock,
    ncmApiConfigured: Boolean(config.ncmApiBaseUrl),
    ncmCookiePresent: cookiePresent,
    auraSkipNcmCandidates: process.env.AURA_SKIP_NCM_CANDIDATES === '1',
    ncmDiscoveryProbePlayable: config.ncmDiscoveryProbePlayable,
    emergencyKeywordPreview: diag.emergencyKeyword.slice(0, 160),
    brainNcmSongId: diag.brainNcmSongId,
    candidatePoolSize: diag.candidatePoolSize,
    remediation:
      '频繁出现则说明 cloudsearch/song/url 或 Brain 解析经常失败：请确认 NCM 代理常驻、NCM_API_BASE_URL 正确，并配置 MUSIC_U 或 NCM_UPSTREAM_COOKIE（见 docs/NCM_UPSTREAM.md）。',
  });
  return id;
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
        '',
        '## `# mmxGateCandidateHints`（结构化 JSON；候选为空时供 B 仅依赖会话画像构造并行 search）',
        '',
        JSON.stringify({ schemaVersion: 1, document: 'mmxGateCandidateHints-v1', candidates: [] }, null, 2),
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

  const mmxPack = {
    schemaVersion: 1,
    document: 'mmxGateCandidateHints-v1',
    generatedAt: new Date().toISOString(),
    /** 与上方兜底行按 ncmSongId 一一对应；mmxSearchQueries 供 B 并行检索 */
    candidates: buildMmxGateCandidateRows(items, new Date()),
  };

  const lines = [
    ...head,
    '兜底候选（每行 JSON）：',
    '',
    payload.map((row) => JSON.stringify(row)).join('\n'),
    '',
    '## `# mmxGateCandidateHints`（结构化 JSON，供 B **并行** mmx-cli search；与上行 **ncmSongId** 对齐）',
    '',
    '每条 `mmxSearchQueries` 为独立短检索词：**艺人名 + 风格/氛围 token + 当前时段收听场景**；可拆成多路 `search query` 并发。',
    '',
    JSON.stringify(mmxPack, null, 2),
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

export type ResolvedPlayEntry = { ncmSongId: string; reason: string; discoveryNote?: string };

export interface ResolvePlayFromDiscoveryResult {
  play: ResolvedPlayEntry[];
  /** 需在界面展示的提示（例如命中内置兜底） */
  playbackHints: string[];
}

/**
 * 根据 Brain 输出的 discoveryNote 搜索解析为真实 ncmSongId。
 * 若失败才走候选池 fallback（保持向后兼容）。
 */
export async function resolvePlayFromDiscovery(
  play: Array<{ ncmSongId: string; reason: string; discoveryNote?: string }>,
  candidates: SongCandidate[],
  excludeIds?: string[],
): Promise<ResolvePlayFromDiscoveryResult> {
  const playbackHints: string[] = [];
  const resolved: ResolvedPlayEntry[] = [];
  const exclude = new Set(excludeIds?.filter(id => id && /^\d+$/.test(id)) ?? []);

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
      try {
        // 请求多取几条，避开排除项后仍能落到有效结果
        const fetchCount = exclude.size > 0 ? Math.max(10, exclude.size + 5) : 5;
        const songs = await ncmSearch(p.discoveryNote, fetchCount);
        const pool = songs.filter(s => !exclude.has(s.id));
        const ordered = pool.length > 0 ? pool : songs.filter(s => !exclude.has(s.id));
        const pickId = await pickPlayableSongIdFromMetas(ordered);
        if (pickId) {
          resolved.push({ ncmSongId: pickId, reason: p.reason });
          continue;
        }
        if (ordered.length > 0) {
          log.warn('[song-candidates] discoveryNote_no_playable_hit', {
            discoveryNotePreview: p.discoveryNote.slice(0, 160),
            searchHitCount: ordered.length,
            ncmMock: config.ncmMock,
            ncmApiConfigured: Boolean(config.ncmApiBaseUrl),
            hint: '云搜有结果但 song/url 均不可用：检查 VIP 曲 Cookie、代理健康与 NCM_DISCOVERY_PROBE_PLAYABLE。',
          });
        } else {
          log.warn('[song-candidates] discoveryNote_empty_search', {
            discoveryNotePreview: p.discoveryNote.slice(0, 160),
            ncmMock: config.ncmMock,
            ncmApiConfigured: Boolean(config.ncmApiBaseUrl),
          });
        }
      } catch (e) {
        log.warn('[song-candidates] discoveryNote_ncm_search_failed', {
          discoveryNotePreview: p.discoveryNote?.slice(0, 160),
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    /**
     * Brain 给出的网易云数字曲 ID 可直接入队，不要求出现在「当日候选池」白名单里；
     * 否则会误判为空队列 → `/api/now` 长期 idle、前端无音频。
     */
    if (/^\d+$/.test(p.ncmSongId) && p.ncmSongId !== '0' && !exclude.has(p.ncmSongId)) {
      const probe = config.ncmDiscoveryProbePlayable && !config.ncmMock && Boolean(config.ncmApiBaseUrl);
      if (!probe || (await ncmSongHasPlayableUrl(p.ncmSongId))) {
        resolved.push({ ncmSongId: p.ncmSongId, reason: p.reason });
        continue;
      }
      log.warn('[song-candidates] brain_ncm_id_unplayable_after_probe', {
        ncmSongId: p.ncmSongId,
        ncmCookiePresent: Boolean(mergeNcmCookies().trim()),
        hint: 'Brain 给出的单曲 ID 在当前登录/代理下无可用 url，将尝试候选池或后续降级。',
      });
      /** 探测不可播则落入候选池 / 紧急搜索 */
    }

    // fallback：检查预建候选池
    const allowed = new Set(candidates.map(c => c.ncmSongId));
    if (allowed.has(p.ncmSongId) && !exclude.has(p.ncmSongId)) {
      resolved.push({ ncmSongId: p.ncmSongId, reason: p.reason });
    } else if (candidates.length > 0) {
      const pool = candidates.filter(c => !exclude.has(c.ncmSongId));
      const fallback =
        pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : candidates[Math.floor(Math.random() * candidates.length)]!;
      resolved.push({
        ncmSongId: fallback.ncmSongId,
        reason: `[候选修正] ${p.ncmSongId} 不可用，fallback《${fallback.title}》- ${fallback.artists.join('/')}`,
      });
      log.warn('[song-candidates] candidate_pool_fallback_pick', {
        originalNcmSongId: p.ncmSongId,
        pickedNcmSongId: fallback.ncmSongId,
        candidatePoolSize: candidates.length,
        hint: '主解析失败，已从当日候选池随机替换；若与 ultimate_fallback_pick 一并频繁出现请优先修稳 NCM 与 Cookie。',
      });
    }
  }

  /** discoveryNote / Brain ID 均不可用且候选池为空时的最后一道防线 */
  let emergencyKeywordForDiag = '';
  if (resolved.length === 0 && play.length > 0) {
    const p0 = play[0]!;
    emergencyKeywordForDiag =
      (p0.discoveryNote ?? '').trim().slice(0, 120) ||
      (p0.reason ?? '').trim().slice(0, 120) ||
      'ambient instrumental calm';
    try {
      const songs = await ncmSearch(emergencyKeywordForDiag, 12);
      const scoped = songs.filter(s => !exclude.has(s.id));
      const pickId = await pickPlayableSongIdFromMetas(scoped.length ? scoped : songs);
      if (pickId) {
        resolved.push({
          ncmSongId: pickId,
          reason: `[紧急搜索] ${p0.reason}`,
        });
        log.info('[song-candidates] emergency_search_pick', {
          pickedNcmSongId: pickId,
          keywordPreview: emergencyKeywordForDiag.slice(0, 120),
        });
      } else if ((scoped.length ? scoped : songs).length > 0) {
        log.warn('[song-candidates] emergency_search_no_playable_hit', {
          keywordPreview: emergencyKeywordForDiag.slice(0, 120),
          searchHitCount: (scoped.length ? scoped : songs).length,
        });
      }
    } catch (e) {
      log.warn('[song-candidates] emergency_ncm_search_failed', {
        keywordPreview: emergencyKeywordForDiag.slice(0, 120),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (resolved.length === 0 && play.length > 0) {
    const p0 = play[0]!;
    const id = pickUltimateFallbackNcmId(exclude, {
      emergencyKeyword: emergencyKeywordForDiag,
      brainNcmSongId: p0.ncmSongId,
      candidatePoolSize: candidates.length,
    });
    resolved.push({
      ncmSongId: id,
      reason: `[内置兜底] 解析与搜索均失败时的占位曲（id=${id}，请检查 NCM 代理）`,
    });
    playbackHints.push(
      '【选曲兜底】discoveryNote 云搜索、Brain 给出的单曲 ID 与当日候选池均未落成可播曲目，已改用内置占位曲继续播放。请在下方检查：① NCM_API_BASE_URL 与 Cookie（MUSIC_U / NCM_UPSTREAM_COOKIE）；② Brain 输出是否含有效 discoveryNote；③ 是否误设 AURA_SKIP_NCM_CANDIDATES=1 导致候选池为空。',
    );
  }

  return { play: resolved, playbackHints };
}
