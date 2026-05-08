import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';

const PlaylistFileSchema = z.object({
  favorites: z
    .array(
      z.object({
        ncmSongId: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  work: z
    .array(
      z.object({
        ncmSongId: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
});

export type UserPlaylistFile = z.infer<typeof PlaylistFileSchema>;

export interface UserBundle {
  tasteMd: string;
  routinesMd: string;
  moodRulesMd: string;
  playlists: UserPlaylistFile;
  updatedAt: string;
}

function readUtf8(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

export function loadUserBundle(userDir = config.userDataDir): UserBundle {
  const tastePath = path.join(userDir, 'taste.md');
  const routinesPath = path.join(userDir, 'routines.md');
  const moodPath = path.join(userDir, 'mood-rules.md');
  const plPath = path.join(userDir, 'playlists.json');

  const missing = [tastePath, routinesPath, moodPath, plPath].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    throw new Error(`缺少用户画像文件：${missing.map((m) => path.relative(process.cwd(), m)).join(', ')}`);
  }

  const playlistsRaw = readUtf8(plPath);
  let playlists: UserPlaylistFile;
  try {
    playlists = PlaylistFileSchema.parse(JSON.parse(playlistsRaw));
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.flatten() : String(e);
    throw new Error(`playlists.json 校验失败：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  const stat = fs.statSync(plPath);

  return {
    tasteMd: readUtf8(tastePath),
    routinesMd: readUtf8(routinesPath),
    moodRulesMd: readUtf8(moodPath),
    playlists,
    updatedAt: stat.mtime.toISOString(),
  };
}
