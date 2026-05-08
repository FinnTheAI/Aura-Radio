import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MoodTag } from './types.js';
import { insertMessage, insertPlayHistory, recentMessages } from './db.js';
import { deriveSessionMood } from './taste-mood.js';
import type { UserBundle } from './user-data.js';
import { config } from './config.js';

export interface ContextFragments {
  systemPrompt: string;
  userCorpus: string;
  environment: string;
  memory: string;
  userInput: string;
  executionTrace: string;
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
}): ContextFragments {
  const now = input.now ?? new Date();
  const traceSeed = randomUUID();
  return {
    systemPrompt: loadDjPersona(),
    userCorpus: buildUserCorpus(input.user),
    environment: buildEnvironment(now, { timezone: input.timezone }),
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
