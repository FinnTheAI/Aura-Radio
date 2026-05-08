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
