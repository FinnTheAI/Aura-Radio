/**
 * 用户点击「收藏」：落库 offline_favorites，异步下载到 data/downloads/{ncmSongId}.mp3。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { Express } from 'express';
import { config } from './config.js';
import { log } from './logger.js';
import type { ContextFragments } from './context-builder.js';
import type { DjScript } from './types.js';
import { deriveSessionMood } from './taste-mood.js';
import {
  offlineFavoriteUpsertPending,
  offlineFavoritePickRandomDownloaded,
  offlineFavoriteGet,
  offlineFavoriteGetAllDownloaded,
  offlineFavoriteCountDownloaded,
  offlineFavoriteMarkDownloaded,
  offlineFavoriteMarkFailed,
  getDb,
} from './db.js';
import { ncmSongDetail, ncmSongUrl } from './ncma.js';

export const OFFLINE_DISCOVERY_PREFIX = 'aura:offline';

/** 纯数字网易云单曲 id */
export function sanitizeNcmSongId(raw: string): string | null {
  const s = raw.replace(/\s/g, '');
  return /^\d{5,20}$/.test(s) ? s : null;
}

export function getDownloadsDir(): string {
  return path.join(config.dataDir, 'downloads');
}

export function getOfflineMp3Path(ncmSongId: string, title?: string, artist?: string): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  if (title && artist) {
    return path.join(getDownloadsDir(), `${safe(title)} - ${safe(artist)}.mp3`);
  }
  return path.join(getDownloadsDir(), `${ncmSongId}.mp3`);
}

export function getOfflineMp3PathByFilename(filename: string): string {
  return path.join(getDownloadsDir(), filename);
}

/** 迁移：旧版数字文件名 → 歌名+歌手名；需要时调用一次即可。 */
export function migrateDownloadFilenames(): void {
  const rows = offlineFavoriteGetAllDownloaded();
  for (const row of rows) {
    if (!row.filename) continue;
    const oldPath = getOfflineMp3PathByFilename(row.filename);
    if (!fs.existsSync(oldPath)) continue;
    const newPath = getOfflineMp3Path(row.ncm_song_id, row.title ?? undefined, row.artist ?? undefined);
    if (oldPath === newPath) continue;
    try {
      fs.renameSync(oldPath, newPath);
      log.info('offline filename migrated', { from: row.filename, to: path.basename(newPath) });
    } catch (e) {
      log.warn('offline filename migration failed', { from: row.filename, err: String(e) });
    }
  }
}

export function ensureDownloadsDir(): void {
  fs.mkdirSync(getDownloadsDir(), { recursive: true });
}

async function fetchToFile(downloadUrl: string, destFsPath: string): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.ncmFetchTimeoutMs);
  let res: Response;
  try {
    res = await fetch(downloadUrl, { redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok || !res.body) {
    throw new Error(`upstream HTTP ${res.status}`);
  }

  ensureDownloadsDir();
  const tmpPath = `${destFsPath}.part`;
  try {
    const nodeBody = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>);
    await pipeline(nodeBody, createWriteStream(tmpPath));
    fs.renameSync(tmpPath, destFsPath);
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /** */
    }
    throw e;
  }
}

async function downloadOfflineFavorite(ncmSongId: string): Promise<void> {
  ensureDownloadsDir();
  const meta = await ncmSongDetail(ncmSongId).catch(() => ({ name: '', artists: [] as string[] }));
  const songName = meta.name ?? '';
  const artistStr = (meta.artists ?? []).join(' / ');
  const destPath = getOfflineMp3Path(ncmSongId, songName, artistStr);

  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 10_000) {
    /** 已有可读文件则不重复下载 */
    const row = offlineFavoriteGet(ncmSongId);
    if (row?.status !== 'downloaded') {
      offlineFavoriteMarkDownloaded(ncmSongId, {
        title: songName || '网易云',
        artist: artistStr || '',
        filename: path.basename(destPath),
      });
    }
    return;
  }

  try {
    const { url } = await ncmSongUrl(ncmSongId);
    if (!url) throw new Error('empty ncmSongUrl');

    await fetchToFile(url, destPath);

    /** 时长占位：网易云 URL 常为流式分段，无法用 Content-Length；使用保守默认 */
    offlineFavoriteMarkDownloaded(ncmSongId, {
      title: songName || '网易云',
      artist: artistStr || '',
      durationMs: 240_000,
      filename: path.basename(destPath),
    });

    log.info('offline favorite downloaded', { ncmSongId, path: destPath });
  } catch (e) {
    const msg = String(e);
    offlineFavoriteMarkFailed(ncmSongId, msg.slice(0, 2000));
    log.warn('offline favorite download failed', { ncmSongId, err: msg.slice(0, 200) });
  }
}

export function scheduleOfflineDownload(ncmSongId: string): void {
  void downloadOfflineFavorite(ncmSongId).catch((err) =>
    log.error('offline download unexpected', { ncmSongId, err: String(err) }),
  );
}

/** 移除 DB 中已标记下载、但文件缺失的收藏行，避免离线池指向坏链 */
export function cleanupOfflineFavoritesOrphans(): number {
  const rows = offlineFavoriteGetAllDownloaded();
  const db = getDb();
  let n = 0;
  for (const row of rows) {
    const fp = row.filename
      ? path.join(getDownloadsDir(), row.filename)
      : path.join(getDownloadsDir(), `${row.ncm_song_id}.mp3`);
    try {
      if (!fs.existsSync(fp) || fs.statSync(fp).size < 1024) {
        db.prepare(`DELETE FROM offline_favorites WHERE ncm_song_id = ?`).run(row.ncm_song_id);
        n++;
      }
    } catch {
      db.prepare(`DELETE FROM offline_favorites WHERE ncm_song_id = ?`).run(row.ncm_song_id);
      n++;
    }
  }
  if (n) log.info('offline_favorites orphan rows removed', { count: n });
  return n;
}

/** 提供给 queue-engine：离线播放同源 URL（无需代理外链） */
export function localAudioHttpPath(ncmSongId: string): string {
  return `/api/local-audio/${ncmSongId}.mp3`;
}

export function getOfflinePlaybackMeta(
  ncmSongId: string,
): { title: string; artist: string; durationMs: number } | null {
  const row = offlineFavoriteGet(ncmSongId);
  if (!row || row.status !== 'downloaded') return null;
  const fp = row.filename
    ? path.join(getDownloadsDir(), row.filename)
    : path.join(getDownloadsDir(), `${ncmSongId}.mp3`);
  if (!fs.existsSync(fp) || fs.statSync(fp).size < 1024) return null;
  return {
    title: row.title?.trim() || `网易云 ${ncmSongId}`,
    artist: (row.artist ?? '').trim(),
    durationMs: row.duration_ms ?? 240_000,
  };
}

/** Brain 兜底：早于 mockScript，仅从已下载离线池随机一首 */
export function tryOfflineFallbackDjScript(_fragments: ContextFragments): DjScript | null {
  if (offlineFavoriteCountDownloaded() < 1) return null;
  const row = offlineFavoritePickRandomDownloaded();
  if (!row) return null;
  const fp = getOfflineMp3Path(row.ncm_song_id);
  if (!fs.existsSync(fp) || fs.statSync(fp).size < 1024) return null;

  const session = deriveSessionMood();
  const songLabel = row.title?.trim() || `收藏 ${row.ncm_song_id}`;
  return {
    schemaVersion: 1,
    say: `网络大脑暂时不可用，我从你的离线曲库里接了一首《${songLabel}》。`,
    play: [
      {
        ncmSongId: row.ncm_song_id,
        reason: '离线收藏保底',
        discoveryNote: `${OFFLINE_DISCOVERY_PREFIX}:fallback`,
      },
    ],
    moodTag: session.moodTag,
    segue: '先听这首，我们再想办法连线。',
  };
}

export function registerOfflineFavoriteRoutes(app: Express): void {
  app.post('/api/favorite', (req, res) => {
    const raw = typeof req.body?.ncmSongId === 'string' ? req.body.ncmSongId : '';
    const id = sanitizeNcmSongId(raw);
    if (!id) {
      res.status(400).json({ ok: false, error: 'invalid ncmSongId' });
      return;
    }
    const { queuedDownload } = offlineFavoriteUpsertPending(id);
    if (queuedDownload) scheduleOfflineDownload(id);

    const row = offlineFavoriteGet(id);
    let message = '已加入离线曲库（后台下载中）';
    if (!queuedDownload) {
      if (row?.status === 'downloaded') message = '已在离线曲库';
      else if (row?.status === 'pending') message = '已在离线队列，下载完成后即可离线播放';
      else if (row?.status === 'failed') message = '已重新排队下载这首歌';
      else message = '已更新离线收藏';
    }

    res.json({
      ok: true,
      ncmSongId: id,
      queuedDownload,
      status: row?.status ?? 'pending',
      message,
    });
  });

  app.get('/api/local-audio/:songId', (req, res) => {
    const songId = req.params.songId?.replace(/\.mp3$/i, '') ?? '';
    if (!/^\d+$/.test(songId)) {
      res.status(400).json({ error: 'invalid song id' });
      return;
    }
    const base = path.resolve(getDownloadsDir());
    // 优先用 filename 列找文件，兜底用数字 id
    const row = offlineFavoriteGet(songId);
    let fp: string;
    if (row?.filename) {
      fp = path.resolve(base, row.filename);
    } else {
      fp = path.resolve(base, `${songId}.mp3`);
    }
    if (!fp.startsWith(base) || !fs.existsSync(fp)) {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(fp);
  });
}
