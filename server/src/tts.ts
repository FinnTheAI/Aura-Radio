import { config } from './config.js';
import { log } from './logger.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TtsResult {
  url: string;
  localPath?: string;
  durationMs: number;
  voiceId: string;
}

// 本地缓存目录（与 `/api/tts/audio`、express-app 一致）
const TTS_CACHE_DIR = join(config.dataDir, 'tts-cache');

function ensureCacheDir() {
  if (!existsSync(TTS_CACHE_DIR)) {
    mkdirSync(TTS_CACHE_DIR, { recursive: true });
  }
}

/** 
 * 调用 MiniMax TTS API 生成语音
 * 文档: https://platform.minimax.io/docs/guides/speech-generation
 */
export async function generateTtsAudio(text: string, options?: {
  voiceId?: string;
  withBgm?: boolean;
  bgmUrl?: string;
  /** 与文本一并参与缓存键，避免不同 trace/段落因文案相似命中同一 TTS 文件 */
  cacheKeySuffix?: string;
}): Promise<TtsResult> {
  ensureCacheDir();
  
  const voiceId = options?.voiceId ?? config.minimaxTtsVoiceId ?? 'female-aipai';
  const withBgm = options?.withBgm ?? config.minimaxTtsBgmEnabled ?? true;
  const suffix = options?.cacheKeySuffix?.trim() ?? '';
  
  // 生成缓存文件名（文本 + 后缀，防错位复用）
  const hash = Buffer.from(`${text}\0${suffix}`).toString('base64url').slice(0, 24);
  const filename = `tts-${voiceId}-${hash}.mp3`;
  const localPath = join(TTS_CACHE_DIR, filename);
  
  // 检查缓存
  if (existsSync(localPath)) {
    log.debug('TTS cache hit', { filename });
    return {
      url: `/api/tts/audio/${filename}`,
      localPath,
      durationMs: estimateDurationMs(text),
      voiceId,
    };
  }
  
  // MiniMax TTS API endpoint (t2a_v2 = text to audio v2)
  const endpoint = config.minimaxApiUrl
    ? `${config.minimaxApiUrl.replace(/\/v1$/, '')}/v1/t2a_v2`
    : 'https://api.minimax.chat/v1/t2a_v2';

  const body = {
    model: 'speech-2.8-hd',
    text,
    voice_setting: {
      voice_id: voiceId,
    },
    audio_setting: {
      sample_rate: 24000,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
    },
    // 如果支持背景音乐混音
    ...(withBgm && {
      background_music: {
        url: options?.bgmUrl ?? config.minimaxTtsBgmUrl,
        vol: 0.3, // 背景音乐音量 30%
      },
    }),
  };
  
  try {
    log.debug('TTS request', { endpoint, voiceId, textLength: text.length });
    
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.minimaxApiKey.trim()}`,
      },
      body: JSON.stringify(body),
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`MiniMax TTS HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    
    const data = await res.json() as {
      data?: { audio?: string }; // base64
      base_resp?: { status_code: number; status_msg: string };
    };
    
    if (data.base_resp?.status_code !== 0 && data.base_resp?.status_code !== undefined) {
      throw new Error(`MiniMax TTS error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
    }
    
    const audioHex = data.data?.audio;
    if (!audioHex) {
      throw new Error('MiniMax TTS returned empty audio');
    }

    // MiniMax TTS API 返回的是 hex 编码字符串，不是 base64
    const audioBuffer = Buffer.from(audioHex, 'hex');
    writeFileSync(localPath, audioBuffer);
    
    log.info('TTS generated', { filename, size: audioBuffer.length });
    
    return {
      url: `/api/tts/audio/${filename}`,
      localPath,
      durationMs: estimateDurationMs(text),
      voiceId,
    };
  } catch (e) {
    log.error('TTS generation failed', { err: e });
    // 降级：返回静音占位 URL
    return {
      url: config.minimaxMockVoiceUrl,
      durationMs: 3000,
      voiceId: 'fallback',
    };
  }
}

/** 估算语音时长（中文约 4-5 字/秒） */
function estimateDurationMs(text: string): number {
  const charCount = text.length;
  // 中文字符约 4 字/秒，英文单词约 3 词/秒
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const otherChars = charCount - chineseChars;
  const seconds = chineseChars / 4 + otherChars / 8;
  return Math.max(3000, Math.min(30000, Math.ceil(seconds * 1000)));
}

/** 预生成下一段口播（后台任务） */
export function prefetchNextVoice(sayText: string, segueText: string): void {
  if (!config.minimaxTtsEnabled) return;
  
  const fullText = `${sayText} ${segueText}`.trim();
  if (!fullText) return;
  
  // 异步预生成，不阻塞
  void (async () => {
    try {
      await generateTtsAudio(fullText);
      log.debug('TTS prefetch success');
    } catch (e) {
      log.warn('TTS prefetch failed', { err: e });
    }
  })();
}

/** 批量预生成多段口播 */
export function prefetchVoiceBatch(texts: string[]): void {
  if (!config.minimaxTtsEnabled) return;
  
  for (const text of texts) {
    if (text?.trim()) {
      prefetchNextVoice(text, '');
    }
  }
}
