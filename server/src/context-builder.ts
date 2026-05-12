import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MoodTag, NowPlaying } from './types.js';
import { insertMessage, insertPlayHistory, recentMessages, listCloudFavorites, listCloudHistory } from './db.js';
import { deriveSessionMood } from './taste-mood.js';
import type { UserBundle } from './user-data.js';
import { config } from './config.js';

export interface ContextFragments {
  systemPrompt: string;
  userCorpus: string;
  environment: string;
  listeningNow: string;
  /** NCM + 收藏聚合的合法曲池（含硬性规则），Brain 仅能从中取 id */
  songCandidates: string;
  memory: string;
  userInput: string;
  executionTrace: string;
}

/** 队列当前态，约束模型按「这一刻在听什么」写 say，而非万能模板 */
export function buildListeningNow(np: NowPlaying): string {
  if (np.type === 'idle') {
    return 'listeningNow：空闲（无刻度音轨）。用户可能刚进线或刚切段，say 可当欢迎/接在场情绪。';
  }
  if (np.type === 'voice') {
    return 'listeningNow：DJ 口播段进行中。say 应与这一氛围顺接（换题、递进、轻描反应），勿写与收听现场无关的长串套话。';
  }
  const title = np.title ?? '未知';
  const who = np.artist ? ` / ${np.artist}` : '';
  const sid = np.ncmSongId ? ` ncmSongId=${np.ncmSongId}` : '';
  const pace =
    np.durationMs && np.durationMs > 0
      ? `约进度 ${Math.min(99, Math.round((np.positionMs / np.durationMs) * 100))}%`
      : '';
  return `listeningNow：音乐「${title}」${who}${sid}${pace ? `，${pace}` : ''}。say 必须把「用户本条话 + 这首正在发生的事」合在一起即兴组织（接引 / 点名动机 / 轻吐槽均可），禁用与此刻无关的固定开场。`;
}

export function loadDjPersona(): string {
  const p = path.join(config.promptsDir, 'dj-persona.md');
  if (!fs.existsSync(p)) {
    throw new Error(`缺失 prompts/dj-persona.md — 期望路径 ${p}`);
  }
  return fs.readFileSync(p, 'utf8');
}

export function buildUserCorpus(user: UserBundle): string {
  return [
    '## taste.md',
    user.tasteMd,
    '## routines.md',
    user.routinesMd,
    '## mood-rules.md',
    user.moodRulesMd,
    '## playlists.json (摘要)',
    JSON.stringify(user.playlists, null, 2),
  ].join('\n');
}

/** 云端口味画像：艺人 Top10、风格分布、播放时段偏好 */
/** 优先读取已生成的 taste-cloud.md 品味画像文件。 */
function readTasteCloudMd(): string {
  const tasteCloudPath = path.join(config.userDataDir, 'taste-cloud.md');
  try {
    if (fs.existsSync(tasteCloudPath)) {
      const content = fs.readFileSync(tasteCloudPath, 'utf8');
      // 有真实收藏数据即为有效画像（文件生成时已含 9485 条口味数据）
      if (content.includes('收藏总条目') || content.includes('网易云听歌画像')) {
        return content;
      }
    }
  } catch { /* ignore */ }
  return '';
}

export function buildCloudTaste(): string {
  const md = readTasteCloudMd();
  if (md) return md;

  // 兜底：空数据时从数据库读（已基本废弃）
  const favorites = listCloudFavorites();
  const history = listCloudHistory();
  const artistCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const hourCounts = new Map<number, number>();

  for (const f of favorites) {
    try {
      const artists = JSON.parse(f.artists_json) as string[];
      for (const a of artists) artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
      if (f.tags_json) {
        const tags = JSON.parse(f.tags_json) as string[];
        for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    } catch { /* ignore */ }
  }

  for (const h of history) {
    if (h.hour_of_day !== null) hourCounts.set(h.hour_of_day, (hourCounts.get(h.hour_of_day) ?? 0) + 1);
  }

  const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n}(${c})`);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, c]) => `${t}(${c})`);
  const morning = [6, 7, 8, 9, 10, 11].reduce((s, h) => s + (hourCounts.get(h) ?? 0), 0);
  const afternoon = [12, 13, 14, 15, 16, 17].reduce((s, h) => s + (hourCounts.get(h) ?? 0), 0);
  const evening = [18, 19, 20, 21, 22].reduce((s, h) => s + (hourCounts.get(h) ?? 0), 0);
  const night = [23, 0, 1, 2, 3, 4, 5].reduce((s, h) => s + (hourCounts.get(h) ?? 0), 0);
  const totalPlay = morning + afternoon + evening + night || 1;

  return [
    '## 云端口味画像（cloud_favorites + cloud_history 聚合）',
    `- 收藏总数: ${favorites.length}`,
    `- 播放历史: ${history.length} 首`,
    `- 艺人 Top10: ${topArtists.join(', ') || '（暂无数据）'}`,
    `- 风格分布: ${topTags.join(', ') || '（暂无数据）'}`,
    `- 时段偏好: 早${morning}午${afternoon}晚${evening}夜${night}（占比 ${(morning / totalPlay * 100).toFixed(0)}%/${(afternoon / totalPlay * 100).toFixed(0)}%/${(evening / totalPlay * 100).toFixed(0)}%/${(night / totalPlay * 100).toFixed(0)}%）`,
    '',
    '选曲策略建议：',
    '1. 冷门佳作优先：70% 比例从低曝光、冷门但高质量的曲目中选取，避免只推热门',
    '2. 不依赖收藏量高的数据：分析用户的隐性偏好（风格/氛围/情绪），而非简单选收藏多的歌',
    '3. 风格分布决定 moodTag，避免连续同风格疲劳',
    '4. 时段偏好校验：若当前时段与历史偏好差异大，可提示「今晚尝试点不一样的？」',
  ].join('\n');
}

export function buildEnvironment(now: Date, extra?: { timezone?: string; weatherHint?: string }): string {
  const tzNote = extra?.timezone ? `客户端时区头: ${extra.timezone}` : '未提供时区头，采用服务器本地时区推断。';
  const weatherNote = extra?.weatherHint ?? '天气：未接入（可后续对接）。';
  return [
    `- ISO 时间：${now.toISOString()}`,
    `- ${tzNote}`,
    `- ${weatherNote}`,
    `- deriveSessionMood：${deriveSessionMood(now).moodTag} — ${deriveSessionMood(now).explain}`,
  ].join('\n');
}

export function buildMemory(userInput: string, traceSeed: string): string {
  const rows = recentMessages(12).reverse();
  const lines = rows.map((r) => `[${new Date(r.ts).toISOString()}] ${r.role}: ${r.text}`);
  return ['最近消息（倒序截断）：', ...lines, `当前用户输入 ID：${traceSeed}`, `用户输入摘要：${userInput.slice(0, 200)}`].join('\n');
}

export function buildExecutionTraceStub(): string {
  return '调度器：当前为轻量 stub；后续可注入 webhook / cron 轨迹。';
}

export function assembleContext(input: {
  user: UserBundle;
  userText: string;
  toolResults?: string;
  now?: Date;
  timezone?: string;
  /** 通常为 `queue.getNow()`：供 say 对齐实时收听画面 */
  nowPlaying?: NowPlaying;
  /** 是否包含云端口味画像（主动推荐模式） */
  includeCloudTaste?: boolean;
  /** 由 song-candidates 模块格式化的 `# songCandidates` 正文（建议始终注入） */
  songCandidatesPrompt?: string;
  /** 是否为下一首自动接续模式（一曲播毕后自动接歌） */
  segmentNextTrack?: boolean;
  /** 上一首完成的歌曲信息（用于衔接口播） */
  lastFinishedSong?: {
    title?: string;
    artist?: string;
    ncmSongId?: string;
    moodTag?: string;
  };
}): ContextFragments {
  const now = input.now ?? new Date();
  const traceSeed = randomUUID();
  
  // 基础 userCorpus
  let userCorpus = buildUserCorpus(input.user);
  
  // 主动推荐模式：注入云端口味画像
  if (input.includeCloudTaste ?? true) {
    const cloudTaste = buildCloudTaste();
    userCorpus = `${userCorpus}\n\n${cloudTaste}`;
  }
  
  return {
    systemPrompt: loadDjPersona(),
    userCorpus,
    environment: buildEnvironment(now, { timezone: input.timezone }),
    listeningNow: input.nowPlaying
      ? buildListeningNow(input.nowPlaying)
      : 'listeningNow：未挂载队列快照（仅本条请求）；say 仍需结合 userInput / environment / memory 写本回合口语，禁用万能模板。',
    songCandidates:
      input.songCandidatesPrompt ??
      '（未注入兜底曲池。必须用 `# mmxCliGate` / mmx-cli search；每项 play 含 discoveryNote；禁止直接用 cloud_favorites。）',
    memory: buildMemory(input.userText, traceSeed),
    userInput: [
      `用户原文：${input.userText || '（DJ 主动推荐）'}`,
      input.toolResults ? `工具结果：\n${input.toolResults}` : '工具结果：（无）',
    ].join('\n'),
    executionTrace: buildExecutionTraceStub(),
  };
}

export function redactForDump(fragments: ContextFragments): ContextFragments {
  return {
    ...fragments,
    memory: fragments.memory.replace(/sk-[a-zA-Z0-9]{10,}/g, 'sk-***'),
    userInput: fragments.userInput.replace(/sk-[a-zA-Z0-9]{10,}/g, 'sk-***'),
  };
}

export function persistUserTurn(text: string, traceId: string) {
  insertMessage({
    id: randomUUID(),
    ts: Date.now(),
    traceId,
    role: 'user',
    text,
  });
}

export function persistAssistantJson(json: string, traceId: string) {
  insertMessage({
    id: randomUUID(),
    ts: Date.now(),
    traceId,
    role: 'assistant',
    text: json,
  });
}

export function persistPlay(ncmSongId: string | undefined, moodTag: MoodTag, traceId: string) {
  insertPlayHistory({ ts: Date.now(), traceId, ncmSongId, moodTag });
}
