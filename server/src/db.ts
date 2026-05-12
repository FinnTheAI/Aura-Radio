import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { log } from './logger.js';

let dbInstance: Database.Database | null = null;

/**
 * 兼容旧库：`offline_favorites` 早前带 `created_at NOT NULL`，新 INSERT 必须写入；
 * 另有一些库由旧 CREATE 仅有 `updated_at`，需补 `created_at` 列后再回填。
 */
function migrateOfflineFavoritesSchema(db: Database.Database): void {
  try {
    const master = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='offline_favorites'`)
      .get() as { name?: string } | undefined;
    if (!master?.name) return;

    const cols = db.prepare(`PRAGMA table_info(offline_favorites)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    if (!names.has('created_at')) {
      db.exec(`ALTER TABLE offline_favorites ADD COLUMN created_at INTEGER`);
      const now = Date.now();
      db.prepare(`UPDATE offline_favorites SET created_at = COALESCE(updated_at, ?) WHERE created_at IS NULL`).run(
        now,
      );
    }

    /* 若曾有库缺 updated_at，补一列（极少见） */
    if (!names.has('updated_at')) {
      db.exec(`ALTER TABLE offline_favorites ADD COLUMN updated_at INTEGER`);
      db.prepare(`UPDATE offline_favorites SET updated_at = ? WHERE updated_at IS NULL`).run(Date.now());
    }
  } catch (e) {
    log.warn('offline_favorites schema migrate', String(e));
  }
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dir = path.dirname(config.stateDbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(config.stateDbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      trace_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      trace_id TEXT,
      ncm_song_id TEXT,
      mood_tag TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ncm_song_id TEXT NOT NULL,
      song_name TEXT,
      artists_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT,
      source TEXT NOT NULL,
      playlist_id TEXT NOT NULL DEFAULT '',
      playlist_name TEXT,
      synced_at INTEGER NOT NULL,
      UNIQUE (ncm_song_id, source, playlist_id)
    );
    CREATE TABLE IF NOT EXISTS cloud_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ncm_song_id TEXT NOT NULL,
      song_name TEXT,
      artists_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT,
      play_ts INTEGER,
      hour_of_day INTEGER,
      source TEXT NOT NULL DEFAULT 'recent',
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cf_synced ON cloud_favorites(synced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ch_hour ON cloud_history(hour_of_day);
    CREATE INDEX IF NOT EXISTS idx_ch_synced ON cloud_history(synced_at DESC);
    CREATE TABLE IF NOT EXISTS offline_favorites (
      ncm_song_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT,
      artist TEXT,
      duration_ms INTEGER,
      filename TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_of_status ON offline_favorites(status);
  `);
  migrateOfflineFavoritesSchema(db);
  dbInstance = db;
  log.info('sqlite ready', config.stateDbPath);
  return db;
}

export function insertMessage(row: { id: string; ts: number; traceId?: string; role: string; text: string }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, ts, trace_id, role, text) VALUES (@id, @ts, @traceId, @role, @text)`,
  ).run(row);
}

export function insertPlayHistory(row: { ts: number; traceId?: string; ncmSongId?: string; moodTag: string }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO play_history (ts, trace_id, ncm_song_id, mood_tag) VALUES (@ts, @traceId, @ncmSongId, @moodTag)`,
  ).run(row);
}

export function recentMessages(limit = 20): Array<{ role: string; text: string; ts: number }> {
  const db = getDb();
  return db
    .prepare(`SELECT role, text, ts FROM messages ORDER BY ts DESC LIMIT ?`)
    .all(limit) as Array<{ role: string; text: string; ts: number }>;
}

export interface CloudFavoriteRowDb {
  ncm_song_id: string;
  song_name: string | null;
  artists_json: string;
  tags_json: string | null;
  source: string;
  playlist_id: string;
  playlist_name: string | null;
  synced_at: number;
}

export interface CloudHistoryRowDb {
  ncm_song_id: string;
  song_name: string | null;
  artists_json: string;
  tags_json: string | null;
  play_ts: number | null;
  hour_of_day: number | null;
  source: string;
  synced_at: number;
}

export function replaceCloudData(favorites: Omit<CloudFavoriteRowDb, 'synced_at'>[], history: Omit<CloudHistoryRowDb, 'synced_at'>[]) {
  const db = getDb();
  const now = Date.now();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM cloud_favorites').run();
    db.prepare('DELETE FROM cloud_history').run();
    const pf = db.prepare(`
      INSERT INTO cloud_favorites (ncm_song_id, song_name, artists_json, tags_json, source, playlist_id, playlist_name, synced_at)
      VALUES (@ncm_song_id, @song_name, @artists_json, @tags_json, @source, @playlist_id, @playlist_name, @synced_at)
    `);
    const ph = db.prepare(`
      INSERT INTO cloud_history (ncm_song_id, song_name, artists_json, tags_json, play_ts, hour_of_day, source, synced_at)
      VALUES (@ncm_song_id, @song_name, @artists_json, @tags_json, @play_ts, @hour_of_day, @source, @synced_at)
    `);
    for (const row of favorites) {
      pf.run({ ...row, synced_at: now });
    }
    for (const row of history) {
      ph.run({ ...row, synced_at: now });
    }
  });
  run();
}

export function listCloudFavorites(): CloudFavoriteRowDb[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM cloud_favorites ORDER BY synced_at DESC`).all() as CloudFavoriteRowDb[];
}

export function listCloudHistory(): CloudHistoryRowDb[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM cloud_history ORDER BY (play_ts IS NULL), play_ts DESC`).all() as CloudHistoryRowDb[];
}

// ==================== 以下函数为兼容性存根，后续实现 ====================

/** 记录 Brain Claude 会话日志 */
export function logBrainClaudeSession(_stderr: string, _stdout: string): void {
  // 待实现：记录到日志表或文件
}

/** KV 存储（song-candidates 缓存等） */
export function kvGet(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT v FROM kv WHERE k = ?`).get(key) as { v: string } | undefined;
  return row?.v;
}

export function kvSet(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(key, value);
}

/** 离线收藏：落库 + 后台下载 MP3 */
export function offlineFavoriteUpsertPending(
  ncmSongId: string,
  _songName?: string,
  _artists?: string[],
): { queuedDownload: boolean } {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare(`SELECT status FROM offline_favorites WHERE ncm_song_id = ?`)
    .get(ncmSongId) as { status: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO offline_favorites (ncm_song_id, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)`,
    ).run(ncmSongId, now, now);
    return { queuedDownload: true };
  }

  if (existing.status === 'failed') {
    db.prepare(
      `UPDATE offline_favorites SET status = 'pending', error = NULL, updated_at = ? WHERE ncm_song_id = ?`,
    ).run(now, ncmSongId);
    return { queuedDownload: true };
  }

  if (existing.status === 'downloaded') {
    return { queuedDownload: false };
  }

  return { queuedDownload: false };
}

export function offlineFavoritePickRandomDownloaded(): {
  ncm_song_id: string;
  title?: string;
  artist?: string;
  filename?: string;
  localPath?: string;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ncm_song_id, title, artist, filename FROM offline_favorites WHERE status = 'downloaded' ORDER BY RANDOM() LIMIT 1`,
    )
    .get() as
    | {
        ncm_song_id: string;
        title: string | null;
        artist: string | null;
        filename: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    ncm_song_id: row.ncm_song_id,
    title: row.title ?? undefined,
    artist: row.artist ?? undefined,
    filename: row.filename ?? undefined,
  };
}

export function offlineFavoriteGet(ncmSongId: string): {
  localPath?: string;
  status: 'pending' | 'downloaded' | 'failed';
  filename?: string;
  title?: string;
  artist?: string;
  duration_ms?: number;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT status, filename, title, artist, duration_ms FROM offline_favorites WHERE ncm_song_id = ?`,
    )
    .get(ncmSongId) as
    | {
        status: string;
        filename: string | null;
        title: string | null;
        artist: string | null;
        duration_ms: number | null;
      }
    | undefined;
  if (!row) return null;
  const st = row.status === 'downloaded' || row.status === 'pending' || row.status === 'failed' ? row.status : 'pending';
  return {
    status: st,
    filename: row.filename ?? undefined,
    title: row.title ?? undefined,
    artist: row.artist ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
  };
}

export function offlineFavoriteGetAllDownloaded(): Array<{
  ncm_song_id: string;
  title?: string;
  artist?: string;
  filename?: string;
  localPath?: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ncm_song_id, title, artist, filename FROM offline_favorites WHERE status = 'downloaded'`,
    )
    .all() as Array<{
    ncm_song_id: string;
    title: string | null;
    artist: string | null;
    filename: string | null;
  }>;
  return rows.map((r) => ({
    ncm_song_id: r.ncm_song_id,
    title: r.title ?? undefined,
    artist: r.artist ?? undefined,
    filename: r.filename ?? undefined,
  }));
}

export function offlineFavoriteCountDownloaded(): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM offline_favorites WHERE status = 'downloaded'`)
    .get() as { n: number };
  return row?.n ?? 0;
}

export function offlineFavoriteMarkDownloaded(
  ncmSongId: string,
  meta: { title?: string; artist?: string; durationMs?: number; filename?: string; localPath?: string },
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE offline_favorites SET status = 'downloaded', title = ?, artist = ?, duration_ms = ?, filename = ?, error = NULL, updated_at = ?
     WHERE ncm_song_id = ?`,
  ).run(
    meta.title ?? null,
    meta.artist ?? null,
    meta.durationMs ?? null,
    meta.filename ?? null,
    now,
    ncmSongId,
  );
}

export function offlineFavoriteMarkFailed(ncmSongId: string, error?: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE offline_favorites SET status = 'failed', error = ?, updated_at = ? WHERE ncm_song_id = ?`,
  ).run(error?.slice(0, 2000) ?? 'unknown', now, ncmSongId);
}

/** GET /api/favorites/status：汇总离线曲库行数与进度 */
export function offlineFavoritesStatusSnapshot(): {
  total: number;
  downloaded: number;
  pending: number;
  failed: number;
  /** 0–100；无可关联行时为 null */
  progressPercent: number | null;
} {
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM offline_favorites`).get() as { n: number }).n ?? 0;
  const downloaded =
    (db.prepare(`SELECT COUNT(*) AS n FROM offline_favorites WHERE status = 'downloaded'`).get() as { n: number }).n ?? 0;
  const pending =
    (db.prepare(`SELECT COUNT(*) AS n FROM offline_favorites WHERE status = 'pending'`).get() as { n: number }).n ?? 0;
  const failed =
    (db.prepare(`SELECT COUNT(*) AS n FROM offline_favorites WHERE status = 'failed'`).get() as { n: number }).n ?? 0;
  const progressPercent = total > 0 ? Math.round((100 * downloaded) / total) : null;
  return { total, downloaded, pending, failed, progressPercent };
}

/** mmx-cli gate 审计 */
export function mmxGateAuditBegin(_query: string): number {
  return Date.now();
}

export function mmxGateAuditComplete(
  _auditId: number, 
  _success: boolean, 
  _exitCode?: number, 
  _stdout?: string, 
  _stderr?: string, 
  _durationMs?: number
): void {
  // 待实现
}
