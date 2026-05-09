import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { log } from './logger.js';

let dbInstance: Database.Database | null = null;

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
  `);
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
