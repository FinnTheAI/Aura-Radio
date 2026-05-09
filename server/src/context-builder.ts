import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MoodTag, NowPlaying } from './types.js';
import { insertMessage, insertPlayHistory, recentMessages } from './db.js';
import { deriveSessionMood } from './taste-mood.js';
import type { UserBundle } from './user-data.js';
import { config } from './config.js';

export interface ContextFragments {
  systemPrompt: string;
  userCorpus: string;
  environment: string;
  listeningNow: string;
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
}): ContextFragments {
  const now = input.now ?? new Date();
  const traceSeed = randomUUID();
  return {
    systemPrompt: loadDjPersona(),
    userCorpus: buildUserCorpus(input.user),
    environment: buildEnvironment(now, { timezone: input.timezone }),
    listeningNow: input.nowPlaying
      ? buildListeningNow(input.nowPlaying)
      : 'listeningNow：未挂载队列快照（仅本条请求）；say 仍需结合 userInput / environment / memory 写本回合口语，禁用万能模板。',
    memory: buildMemory(input.userText, traceSeed),
    userInput: [
      `用户原文：${input.userText}`,
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
