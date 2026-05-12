import { config, mergeNcmCookies } from './config.js';
import { log } from './logger.js';
import { getNcmSongUrl as ytdlpGetUrl, mockNcmPlayableFallback, getNcmSongMetaFromYtDlp } from './ytdlp.js';

export interface NcmSongMeta {
  id: string;
  name: string;
  artists: string[];
  album?: string;
}

interface NcmSearchBody {
  result?: {
    songs?: Array<{ id: number; name: string; artists?: Array<{ name: string }>; ar?: Array<{ name: string }> }>;
  };
}

interface NcmUrlBody {
  data?: Array<{ id: number; url?: string; time?: number }>;
}

interface NcmLyricBody {
  lrc?: { lyric?: string };
}

const BODY_PREVIEW_LEN = 512;

function previewText(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > BODY_PREVIEW_LEN ? `${t.slice(0, BODY_PREVIEW_LEN)}…` : t;
}

function previewJsonBody(body: unknown): string {
  try {
    return previewText(JSON.stringify(body));
  } catch {
    return '[unserializable]';
  }
}

/** NCM 常把时长放在 `time`：秒（几百）或毫秒（六位以上）。 */
function durationMsFromNcmTime(time: number | undefined, fallback: number): number {
  if (typeof time !== 'number' || !Number.isFinite(time)) return fallback;
  if (time > 0 && time < 7200) return Math.round(time * 1000);
  return Math.round(time);
}

function assertNcmBizOk(path: string, fullUrl: string, parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') return;
  const code = (parsed as { code?: unknown }).code;
  if (typeof code !== 'number') return;
  if (code === 200) return;
  const msgRaw = (parsed as { message?: unknown; msg?: unknown }).message ?? (parsed as { msg?: unknown }).msg;
  const msg = typeof msgRaw === 'string' && msgRaw.trim() ? msgRaw.trim() : `业务码 ${code}`;
  log.error('[NCM]', path, 'upstream rejected', {
    url: fullUrl,
    code,
    message: msg,
    bodyPreview: previewJsonBody(parsed),
  });
  throw new Error(`NCM ${path}: ${msg}`);
}

async function fetchJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const base = config.ncmApiBaseUrl;
  const u = new URL(path.startsWith('/') ? path.slice(1) : path, base.endsWith('/') ? base : `${base}/`);
  if (params) {
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  }
  const fullUrl = u.toString();
  const headers: Record<string, string> = { Accept: 'application/json' };
  const merged = mergeNcmCookies();
  if (merged) headers.Cookie = merged;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.ncmFetchTimeoutMs);
  try {
    const res = await fetch(u, { headers, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) {
      log.error('[NCM]', path, 'HTTP error', {
        url: fullUrl,
        status: res.status,
        statusText: res.statusText,
        bodyPreview: previewText(text),
      });
      throw new Error(`NCM ${path} HTTP ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      log.error('[NCM]', path, 'invalid JSON', {
        url: fullUrl,
        bodyPreview: previewText(text),
        err: e instanceof Error ? e.message : e,
      });
      throw new Error(`NCM ${path} 响应不是 JSON`);
    }
    assertNcmBizOk(path, fullUrl, parsed);
    return parsed as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      log.error('[NCM]', path, 'timeout', { url: fullUrl, timeoutMs: config.ncmFetchTimeoutMs });
      throw new Error(`NCM ${path} 超时（${config.ncmFetchTimeoutMs}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function ncmSearch(keywords: string, limit = 5): Promise<NcmSongMeta[]> {
  if (config.ncmMock || !config.ncmApiBaseUrl) {
    return [
      { id: '29764564', name: `Mock《${keywords}》`, artists: ['Mock Artist'] },
      { id: '441491828', name: 'Mock B-side', artists: ['Mock'] },
    ].slice(0, limit);
  }
  // NeteaseCloudMusicApi：单曲云搜 type=1；若上游未挂载 /cloudsearch 则回退 /search。
  let body: NcmSearchBody;
  try {
    body = await fetchJson<NcmSearchBody>('/cloudsearch', {
      keywords,
      limit: String(limit),
      type: '1',
    });
  } catch (e) {
    log.warn('[NCM] cloudsearch failed, retry /search', { keywords, err: e instanceof Error ? e.message : e });
    body = await fetchJson<NcmSearchBody>('/search', {
      keywords,
      limit: String(limit),
      type: '1',
    });
  }
  const songs = body.result?.songs ?? [];
  return songs.map((s) => ({
    id: String(s.id),
    name: s.name,
    artists: (s.artists ?? s.ar ?? []).map((a) => a.name),
  }));
}

export async function ncmSongUrl(ncmSongId: string): Promise<{ url: string; durationMs: number }> {
  if (config.ncmMock || !config.ncmApiBaseUrl) {
    if (config.ncmMockUseYtdlp) return ytdlpGetUrl(ncmSongId);
    /** 默认跳过 yt-dlp：避免本机地理限制、「list index out of range」与排队时长刷屏。 */
    return mockNcmPlayableFallback();
  }
  try {
    const body = await fetchJson<NcmUrlBody>('/song/url/v1', { id: ncmSongId, level: 'exhigh' });
    const row = body.data?.[0];
    const url = row?.url;
    if (!url) throw new Error('empty url');
    const durationMs = durationMsFromNcmTime(row?.time, 240_000);
    return { url, durationMs };
  } catch (e) {
    log.warn('[NCM] ncmSongUrl failed, falling back to yt-dlp', {
      ncmSongId,
      err: e instanceof Error ? e.message : e,
    });
    return ytdlpGetUrl(ncmSongId);
  }
}

export async function ncmSongDetail(ncmSongId: string): Promise<NcmSongMeta> {
  if (config.ncmMock || !config.ncmApiBaseUrl) {
    return { id: ncmSongId, name: '', artists: [] };
  }
  try {
    const body = (await fetchJson<{ songs?: Array<{ id: number; name: string; ar?: Array<{ name: string }> }> }>(
      '/song/detail',
      { ids: ncmSongId },
    )) as { songs?: Array<{ id: number; name: string; ar?: Array<{ name: string }> }> };
    const s = body.songs?.[0];
    if (!s) throw new Error('no song');
    return { id: String(s.id), name: s.name, artists: (s.ar ?? []).map((a) => a.name) };
  } catch (e) {
    log.warn('[NCM] ncmSongDetail failed, trying yt-dlp metadata', { ncmSongId, err: e instanceof Error ? e.message : e });
    try {
      const ytMeta = await getNcmSongMetaFromYtDlp(ncmSongId);
      if (ytMeta?.title) {
        log.info('[NCM] yt-dlp metadata fallback success', { ncmSongId, title: ytMeta.title });
        return { id: ncmSongId, name: ytMeta.title, artists: [ytMeta.artist] };
      }
    } catch {
      /** ignore yt-dlp meta failure */
    }
    return { id: ncmSongId, name: '', artists: [] };
  }
}

export async function ncmLyric(ncmSongId: string): Promise<string> {
  if (config.ncmMock || !config.ncmApiBaseUrl) {
    return '[mock lyric] 示例歌词';
  }
  try {
    const body = await fetchJson<NcmLyricBody>('/lyric', { id: ncmSongId });
    return body.lrc?.lyric ?? '';
  } catch (e) {
    log.warn('[NCM] ncmLyric failed', { ncmSongId, err: e instanceof Error ? e.message : e });
    return '';
  }
}

export interface NcmSongDetailRich extends NcmSongMeta {
  tags: string[];
}

function arNames(ar: unknown): string[] {
  if (!Array.isArray(ar)) return [];
  const out: string[] = [];
  for (const a of ar) {
    if (a && typeof a === 'object' && typeof (a as { name?: string }).name === 'string')
      out.push((a as { name: string }).name);
  }
  return out;
}

function tagsFromSongRecord(song: Record<string, unknown>): string[] {
  const tags: string[] = [];
  const al = song.al && typeof song.al === 'object' ? (song.al as Record<string, unknown>) : null;
  if (al?.name && typeof al.name === 'string' && al.name.trim()) tags.push(`专辑:${al.name.trim()}`);
  const tg = song.tags;
  if (Array.isArray(tg)) {
    for (const t of tg) {
      if (typeof t === 'string' && t.trim()) tags.push(t.trim());
      if (t && typeof t === 'object' && typeof (t as { name?: string }).name === 'string') {
        tags.push(String((t as { name: string }).name));
      }
    }
  }
  return [...new Set(tags)];
}

/** 批量 `song/detail`（用于红心/列表补全曲目名与轻度标签）；单块 ≤120 ID。 */
export async function ncmSongDetailRichMany(ids: string[]): Promise<Map<string, NcmSongDetailRich>> {
  const map = new Map<string, NcmSongDetailRich>();
  if (config.ncmMock || !config.ncmApiBaseUrl) {
    for (const id of [...new Set(ids)]) {
      if (!/^\d+$/.test(id)) continue;
      map.set(id, { id, name: `Mock 《${id}》`, artists: ['Mock'], tags: ['mock'] });
    }
    return map;
  }
  const unique = [...new Set(ids)].filter((x) => /^\d+$/.test(x));
  for (let i = 0; i < unique.length; i += 120) {
    const idsStr = unique.slice(i, i + 120).join(',');
    try {
      const body = await fetchJson<{ songs?: Array<Record<string, unknown> & { id?: number }> }>('/song/detail', {
        ids: idsStr,
      });
      for (const s of body.songs ?? []) {
        if (typeof s.id !== 'number' && typeof s.id !== 'string') continue;
        const sid = String(s.id);
        const name = typeof s.name === 'string' ? s.name : '未知曲目';
        map.set(sid, { id: sid, name, artists: arNames(s.ar), tags: tagsFromSongRecord(s) });
      }
    } catch (e) {
      log.warn('[NCM] ncmSongDetailRichMany chunk failed', { err: String(e), idsPreview: idsStr.slice(0, 40) });
    }
  }
  return map;
}

export async function ncmResolveUserId(): Promise<string | null> {
  if (!config.ncmApiBaseUrl || config.ncmMock) {
    const u = config.neteaseUid.trim();
    return u && /^\d+$/.test(u) ? u : null;
  }
  const fixed = config.neteaseUid.trim();
  if (/^\d+$/.test(fixed)) return fixed;
  if (!mergeNcmCookies()) return null;
  try {
    const body = (await fetchJson<Record<string, unknown>>('/user/account')) as Record<string, unknown>;
    const profile = body.profile && typeof body.profile === 'object' ? (body.profile as Record<string, unknown>) : null;
    const account = body.account && typeof body.account === 'object' ? (body.account as Record<string, unknown>) : null;
    const cand = profile?.userId ?? profile?.user_id ?? account?.userId ?? account?.id ?? body.userId;
    const s =
      cand === undefined || cand === null
        ? ''
        : typeof cand === 'number'
          ? String(cand)
          : String(cand).trim();
    if (/^\d+$/.test(s)) return s;
  } catch {
    /** */
  }
  return null;
}

export async function ncmLikelistSongIds(uid: string): Promise<string[]> {
  if (config.ncmMock || !config.ncmApiBaseUrl) return [];
  try {
    const body = await fetchJson<{ ids?: number[] | string[] | unknown }>('/likelist', { uid });
    const ids = Array.isArray((body as { ids?: unknown }).ids)
      ? (body as { ids: unknown[] }).ids
      : Array.isArray((body as { data?: { ids?: unknown[] } }).data?.ids)
        ? ((body as { data: { ids: unknown[] } }).data.ids as unknown[])
        : [];
    return ids.map(String).filter((id) => /^\d+$/.test(id));
  } catch (e) {
    log.warn('[NCM] likelist failed', { uid, err: String(e) });
    return [];
  }
}

interface PlaylistBrief {
  id: string;
  name: string;
  subscribed: boolean;
}

/** 用户的歌单行；筛选 `subscribed===true` 视为「收藏的他人歌单」；自建通常 subscribed=false — 红心另走 `/likelist`。 */
export async function ncmFetchUserPlaylistSummaries(uid: string, limit = 60): Promise<PlaylistBrief[]> {
  if (config.ncmMock || !config.ncmApiBaseUrl) return [];
  try {
    const body = await fetchJson<{ playlist?: unknown[] }>('/user/playlist', {
      uid,
      limit: String(limit),
      offset: '0',
    });
    const rows = Array.isArray(body.playlist) ? body.playlist : [];
    const out: PlaylistBrief[] = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const id = o.id;
      const name = o.name;
      if ((typeof id !== 'number' && typeof id !== 'string') || typeof name !== 'string') continue;
      out.push({
        id: String(id),
        name,
        subscribed: o.subscribed === true,
      });
    }
    return out;
  } catch (e) {
    log.warn('[NCM] user/playlist failed', { uid, err: String(e) });
    return [];
  }
}

function coerceTrackSong(entry: Record<string, unknown>): Record<string, unknown> | null {
  const nested = entry.track;
  const t = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : entry;
  if (typeof t.id !== 'number' && typeof t.id !== 'string') return null;
  return t;
}

export async function ncmPlaylistTrackRows(
  playlistId: string,
  limitTracks = 200,
): Promise<Array<{ id: string; name: string; artists: string[]; tags: string[] }>> {
  if (config.ncmMock || !config.ncmApiBaseUrl) return [];
  try {
    const body = await fetchJson<{ playlist?: { tracks?: unknown[] } }>('/playlist/detail', {
      id: playlistId,
      limit: String(Math.min(limitTracks, 300)),
    });
    const tracks = Array.isArray(body.playlist?.tracks) ? body.playlist!.tracks! : [];
    const rows: Array<{ id: string; name: string; artists: string[]; tags: string[] }> = [];
    for (const tr of tracks) {
      if (!tr || typeof tr !== 'object') continue;
      const song = coerceTrackSong(tr as Record<string, unknown>);
      if (!song) continue;
      const id = String(song.id);
      const name = typeof song.name === 'string' ? song.name : id;
      rows.push({
        id,
        name,
        artists: arNames(song.ar),
        tags: tagsFromSongRecord(song),
      });
    }
    return rows;
  } catch (e) {
    log.warn('[NCM] playlist/detail failed', { playlistId, err: String(e) });
    return [];
  }
}

export interface NcmRecentPlayRow {
  id: string;
  name: string;
  artists: string[];
  tags: string[];
  playTs: number | null;
}

function normalizePlayTs(secondsOrMs: unknown): number | null {
  if (typeof secondsOrMs !== 'number') return null;
  if (!Number.isFinite(secondsOrMs)) return null;
  if (secondsOrMs > 1e12) return Math.round(secondsOrMs);
  if (secondsOrMs > 0 && secondsOrMs < 400_000_000_000) return Math.round(secondsOrMs * 1000);
  return null;
}

function parseRecentListBody(body: Record<string, unknown>): NcmRecentPlayRow[] {
  const cand: unknown[] = [];
  const d = body.data;
  if (d && typeof d === 'object') {
    const data = d as Record<string, unknown>;
    const nest = Array.isArray(data.list) ? data.list : [];
    cand.push(...nest);
  }
  if (body.list && Array.isArray(body.list)) cand.push(...body.list);

  const rows: NcmRecentPlayRow[] = [];
  for (const raw of cand) {
    if (!raw || typeof raw !== 'object') continue;
    const wrap = raw as Record<string, unknown>;
    let songObj: Record<string, unknown> | null = null;
    let fallbackTs: number | null = null;
    const dataNest = wrap.data && typeof wrap.data === 'object' ? (wrap.data as Record<string, unknown>) : null;
    if (dataNest?.song && typeof dataNest.song === 'object') songObj = dataNest.song as Record<string, unknown>;
    else if (dataNest) songObj = dataNest.id ? dataNest : null;
    else if (wrap.song && typeof wrap.song === 'object') songObj = wrap.song as Record<string, unknown>;
    else songObj = coerceTrackSong(wrap);

    fallbackTs =
      normalizePlayTs(wrap.playTime) ?? normalizePlayTs(dataNest?.playTime) ?? normalizePlayTs(wrap.pubTime ?? dataNest?.pubTime);

    if (!songObj) continue;
    if (typeof songObj.id !== 'number' && typeof songObj.id !== 'string') continue;
    rows.push({
      id: String(songObj.id),
      name: typeof songObj.name === 'string' ? songObj.name : String(songObj.id),
      artists: arNames(songObj.ar),
      tags: tagsFromSongRecord(songObj),
      playTs: fallbackTs ?? normalizePlayTs(wrap.publishTime ?? dataNest?.publishTime ?? null),
    });
  }
  return rows.filter((x) => /^\d+$/.test(x.id));
}


function parseUserRecordBody(body: Record<string, unknown>): NcmRecentPlayRow[] {
  const keys = ['allData', 'weekData'];
  let arr: unknown[] = [];
  for (const k of keys) {
    const v = body[k];
    if (Array.isArray(v)) {
      arr = v;
      break;
    }
  }
  const rows: NcmRecentPlayRow[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    let songObj: Record<string, unknown> | null = null;
    if (w.song && typeof w.song === 'object') songObj = w.song as Record<string, unknown>;
    songObj ||= coerceTrackSong(w);
    if (!songObj) continue;
    if (typeof songObj.id !== 'number' && typeof songObj.id !== 'string') continue;
    rows.push({
      id: String(songObj.id),
      name: typeof songObj.name === 'string' ? songObj.name : String(songObj.id),
      artists: arNames(songObj.ar),
      tags: tagsFromSongRecord(songObj),
      playTs:
        normalizePlayTs(w.playTime) ??
        normalizePlayTs(w.latestPlayTime) ??
        (typeof w.date === 'number' ? normalizePlayTs(w.date) : null),
    });
  }
  return rows.filter((x) => /^\d+$/.test(x.id));
}

/** 读取最近收听：依次尝试 Enhanced 常见路由与 `/user/record`。 */
export async function ncmFetchRecentSongList(limit = 200): Promise<NcmRecentPlayRow[]> {
  if (config.ncmMock || !config.ncmApiBaseUrl) return [];
  const capNum = Math.min(Math.max(limit, 1), 500);
  const lim = String(capNum);
  const paths = ['/record/recent/song/list', '/record/recent/song'];

  for (const p of paths) {
    try {
      const body = await fetchJson<Record<string, unknown>>(p, { limit: lim });
      const parsed = parseRecentListBody(body);
      if (parsed.length) return parsed.slice(0, capNum);
    } catch (e) {
      log.warn('[NCM] recent path failed', { path: p, err: String(e) });
    }
  }

  const uid = await ncmResolveUserId();
  if (uid && mergeNcmCookies()) {
    try {
      const body = await fetchJson<Record<string, unknown>>('/user/record', {
        uid,
        type: '0',
        limit: lim,
      });
      const parsed = [...parseRecentListBody(body), ...parseUserRecordBody(body)];
      if (parsed.length) return parsed.slice(0, capNum);
    } catch (e) {
      log.warn('[NCM] user/record failed', String(e));
    }
  }

  return [];
}

// ==================== 以下函数为兼容性存根，后续实现 ====================

export interface NcmArtistHotSongMeta {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  popularity?: number;
}

/** 获取艺人热门歌曲 */
export async function ncmArtistHotSongMetas(_artistId: string, _limit?: number): Promise<NcmArtistHotSongMeta[]> {
  // 待实现：调用 /artist/top/song 接口
  return [];
}

/** 搜索艺人并返回首个匹配ID */
export async function ncmSearchArtistFirstId(_artistName: string): Promise<string | null> {
  // 待实现：调用 /search 接口 type=100 (艺人)
  return null;
}

/** 获取艺人详情 */
export async function ncmArtistDetail(_artistId: string): Promise<{ id: string; name: string; picUrl?: string; briefDesc?: string } | null> {
  // 待实现：调用 /artist/detail 接口
  return null;
}
