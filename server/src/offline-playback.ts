/**
 * 显式「离线模式」：仅从 data/downloads 下的 .mp3 随机选曲；
 * 口播不走高成本 TTS，由服务端把文案塞进队列条的 djText，客户端文字展示。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { getDownloadsDir } from './favorites.js';
import { deriveSessionMood } from './taste-mood.js';
import type { DjScript } from './types.js';

export const LOCAL_FS_PREFIX = 'aura:localfs:';

export function listDownloadMp3Basenames(): string[] {
  const dir = getDownloadsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp3') && !f.includes('..') && f.trim() !== '');
}

export function pickRandomLocalDownload(): string | null {
  const xs = listDownloadMp3Basenames();
  if (!xs.length) return null;
  return xs[Math.floor(Math.random() * xs.length)]!;
}

/** 稳定顺序，便于「离线下一首」循环遍历 */
export function listDownloadMp3Sorted(): string[] {
  return [...listDownloadMp3Basenames()].sort((a, b) =>
    a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }),
  );
}

/** `currentBasename` 为纯文件名（含 .mp3）；若无当前曲则从列表首首开始 */
export function nextOfflineBasenameAfter(currentBasename: string | undefined): string | null {
  const sorted = listDownloadMp3Sorted();
  if (!sorted.length) return null;
  if (!currentBasename) return sorted[0]!;
  const i = sorted.indexOf(currentBasename);
  if (i < 0) return sorted[0]!;
  return sorted[(i + 1) % sorted.length]!;
}

function durationGuessFromFileSize(size: number): number {
  /** 粗估比特率 128kbps 量级，避免 json 过大；夹在 3–10 分钟 */
  const ms = Math.floor((size / (128_000 / 8)) * 1000);
  return Math.min(600_000, Math.max(180_000, ms));
}

/**
 * 解析 aura:localfs:<urlencoded basename> → 同源 HTTP URL + 展示用标题
 */
export function resolveLocalFsPlayback(discoveryNote: string): {
  url: string;
  durationMs: number;
  titleHint: string;
  artistHint: string;
} | null {
  if (!discoveryNote.startsWith(LOCAL_FS_PREFIX)) return null;
  const enc = discoveryNote.slice(LOCAL_FS_PREFIX.length);
  let base: string;
  try {
    base = decodeURIComponent(enc);
  } catch {
    return null;
  }
  if (!base || base.includes('..') || /[/\\]/.test(base)) return null;
  if (!base.toLowerCase().endsWith('.mp3')) return null;
  const dir = path.resolve(getDownloadsDir());
  const fp = path.resolve(dir, base);
  if (!fp.startsWith(dir) || !fs.existsSync(fp)) return null;
  const st = fs.statSync(fp);
  if (st.size < 2048) return null;
  return {
    url: `/api/local-audio-file/${encodeURIComponent(base)}`,
    durationMs: durationGuessFromFileSize(st.size),
    titleHint: path.basename(base, path.extname(base)),
    artistHint: '本地文件',
  };
}

export interface OfflineFolderResult {
  script: DjScript;
  /** 标在首条音乐上，供客户端大字展示（无 TTS） */
  djAnnounce: string;
}

export function buildOfflineDjScriptForBasename(basename: string, userNote: string): OfflineFolderResult {
  const allowed = listDownloadMp3Basenames();
  if (!basename || !allowed.includes(basename)) {
    throw new Error(`离线文件不可用：${basename || '(空)'}`);
  }
  const session = deriveSessionMood();
  const label = path.basename(basename, path.extname(basename));
  const note = userNote.trim() || '继续收听本地曲库。';
  const djAnnounce = `【离线模式 · 来自收藏】\n${note}\n\n即将播放：${label}`;
  const script: DjScript = {
    schemaVersion: 1,
    say: '',
    segue: '',
    play: [
      {
        ncmSongId: `local:${encodeURIComponent(basename)}`,
        reason: '离线目录曲目',
        discoveryNote: `${LOCAL_FS_PREFIX}${encodeURIComponent(basename)}`,
      },
    ],
    moodTag: session.moodTag,
  };
  return { script, djAnnounce };
}

export function buildOfflineFolderDjScript(userText: string): OfflineFolderResult {
  const file = pickRandomLocalDownload();
  if (!file) {
    throw new Error(
      '离线模式：data/downloads 下没有可用的 .mp3。请先在线收听并「收藏到离线」，或将 mp3 放入该目录。',
    );
  }
  return buildOfflineDjScriptForBasename(file, userText);
}

export function registerLocalAudioFileRoute(app: Express): void {
  app.get('/api/local-audio-file/:basename', (req, res) => {
    const raw = req.params.basename ?? '';
    let base: string;
    try {
      base = decodeURIComponent(raw);
    } catch {
      res.status(400).json({ error: 'invalid name' });
      return;
    }
    if (!base || base.includes('..') || /[/\\]/.test(base) || !base.toLowerCase().endsWith('.mp3')) {
      res.status(400).json({ error: 'invalid name' });
      return;
    }
    const dir = path.resolve(getDownloadsDir());
    const fp = path.resolve(dir, base);
    if (!fp.startsWith(dir) || !fs.existsSync(fp)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(fp);
  });
}
