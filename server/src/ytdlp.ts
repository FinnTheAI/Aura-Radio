/**
 * @deprecated 长期方案应迁移至 NeteaseCloudMusicApi；本模块为开发/本机 fallback
 */
import { spawn } from 'node:child_process';
import { log } from './logger.js';

interface YtdlpFormat {
  url?: string;
  vcodec?: string;
  abr?: number;
}

interface YtdlpResult {
  id?: string | number;
  title?: string;
  creator?: string;
  album_artist?: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
  formats?: YtdlpFormat[];
}

interface YtdlpOptions {
  timeoutMs?: number;
}

async function execYtDlp(args: string[], opts: YtdlpOptions = {}): Promise<YtdlpResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`yt-dlp JSON parse failed: ${stdout.slice(0, 200)}`));
        }
      } else {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function extractFirstUrl(formats: YtdlpFormat[] | undefined): string | null {
  if (!formats || !Array.isArray(formats)) return null;
  // Prefer higher quality audio (sort by abr descending)
  const sorted = [...formats].sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));
  for (const f of sorted) {
    if (f.vcodec === 'none' && f.url) {
      return f.url;
    }
  }
  return null;
}

/**
 * Fetch playable URL for a NetEase Music song via yt-dlp.
 * Falls back to mock URL if yt-dlp fails or times out.
 *
 * Note: This is a development/experimental fallback. For production,
 * prefer using NeteaseCloudMusicApi (NCM_API_BASE_URL) for stability.
 */
export async function getNcmSongUrl(ncmSongId: string): Promise<{ url: string; durationMs: number }> {
  try {
    const data = await execYtDlp(['-J', '--', `https://music.163.com/song?id=${ncmSongId}`], {
      timeoutMs: 15_000,
    });
    const playUrl = extractFirstUrl(data.formats);

    if (!playUrl) {
      log.warn('[ytdlp] no playable URL found, using mock');
      return getMockUrl();
    }

    const durationSec = typeof data.duration === 'number' ? data.duration : 240;
    return { url: playUrl, durationMs: Math.round(durationSec * 1000) };
  } catch (err) {
    log.warn('[ytdlp] failed, using mock fallback', { err });
    return getMockUrl();
  }
}

function getMockUrl(): { url: string; durationMs: number } {
  return {
    url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    durationMs: 420_000,
  };
}
