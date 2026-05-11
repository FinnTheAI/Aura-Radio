/**
 * 播放模式：仅「联网 / 离线」两种，持久化到 data/playback-mode.json。
 * 不再依赖 Brain 失败时的静默离线降级；离线需用户显式切换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type PlaybackMode = 'online' | 'offline';

const MODE_FILE = path.join(config.dataDir, 'playback-mode.json');

let mode: PlaybackMode = 'online';

function load(): void {
  try {
    if (!fs.existsSync(MODE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')) as { mode?: string };
    if (j.mode === 'offline' || j.mode === 'online') mode = j.mode;
  } catch {
    /* keep default */
  }
}

function save(): void {
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, updatedAt: Date.now() }), 'utf8');
}

load();

export function getPlaybackMode(): PlaybackMode {
  return mode;
}

export function setPlaybackMode(next: PlaybackMode): void {
  if (next !== 'online' && next !== 'offline') throw new Error('invalid playback mode');
  mode = next;
  save();
}
