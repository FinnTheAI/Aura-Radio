import { config } from './config.js';
import { log } from './logger.js';
import { getNcmSongUrl as ytdlpGetUrl, mockNcmPlayableFallback } from './ytdlp.js';

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
  if (config.ncmUpstreamCookie) headers.Cookie = config.ncmUpstreamCookie;

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
    return { id: ncmSongId, name: `Mock Track ${ncmSongId}`, artists: ['Mock'] };
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
    log.warn('[NCM] ncmSongDetail failed, mock', { ncmSongId, err: e instanceof Error ? e.message : e });
    return { id: ncmSongId, name: `Mock Track ${ncmSongId}`, artists: ['Mock'] };
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
