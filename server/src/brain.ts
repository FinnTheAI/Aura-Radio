import { z } from 'zod';
import { config } from './config.js';
import { log } from './logger.js';
import type { DjScript, MoodTag } from './types.js';
import { deriveSessionMood, normalizeMoodTag } from './taste-mood.js';
import type { ContextFragments } from './context-builder.js';

const DjScriptSchema = z.object({
  schemaVersion: z.coerce.number(),
  say: z.coerce.string(),
  play: z.array(
    z.object({
      ncmSongId: z.coerce.string(),
      reason: z.coerce.string(),
    }),
  ),
  moodTag: z.coerce.string(),
  segue: z.coerce.string(),
  telemetry: z.object({ confidence: z.number().optional() }).optional(),
});

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 从模型输出中截取第一个 `{ ... }` 块（容忍前言/后记夹杂文本）。 */
function extractJsonObjectSlice(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('响应中未找到 JSON 对象');
  return t.slice(start, end + 1);
}

function unwrapDjPayload(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const o = obj as Record<string, unknown>;
  if (
    typeof o.schemaVersion !== 'undefined' &&
    Array.isArray(o.play) &&
    typeof o.moodTag === 'string' &&
    typeof o.segue === 'string'
  ) {
    return o;
  }
  for (const key of ['djScript', 'script', 'data', 'result', 'payload'] as const) {
    const inner = o[key];
    if (inner && typeof inner === 'object') {
      const u = unwrapDjPayload(inner);
      if (u && typeof u === 'object') return u;
    }
  }
  return obj;
}

function parseDjJson(text: string): DjScript {
  const jsonStr = extractJsonObjectSlice(text);
  const obj = JSON.parse(jsonStr) as unknown;
  const payload = unwrapDjPayload(obj);
  return DjScriptSchema.parse(payload) as DjScript;
}

function mockScript(fragments: ContextFragments): DjScript {
  const session = deriveSessionMood();
  const pick = session.moodTag === 'focus' ? '29764564' : '441491828';
  return {
    schemaVersion: 1,
    say: session.moodTag === 'focus' ? '' : '离线 Mock：给你一首刚刚好的背景乐。',
    play: [
      {
        ncmSongId: pick,
        reason: `与「${session.explain}」一致的占位选曲。`,
      },
    ],
    moodTag: session.moodTag,
    segue: '我们轻轻进入下一段。',
    telemetry: { confidence: 0.5 },
  };
}

/** 官方路径：https://api.minimax.chat/v1/text/chatcompletion_v2 */
function minimaxChatCompletionEndpoint(baseFromEnv: string): string | null {
  const raw = baseFromEnv.trim().replace(/\/$/, '');
  if (!raw) return null;
  if (/\/text\/chatcompletion_v2$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/text/chatcompletion_v2`;
  return `${raw}/v1/text/chatcompletion_v2`;
}

function resolveMinimaxEndpoint(): string | null {
  const fromEnv = minimaxChatCompletionEndpoint(config.minimaxApiUrl);
  if (fromEnv) return fromEnv;
  if (!config.minimaxMock && config.minimaxApiKey.trim())
    return minimaxChatCompletionEndpoint('https://api.minimax.chat/v1');
  return null;
}

interface MiniMaxChatCompletionJson {
  choices?: Array<{ message?: { content?: unknown } & Record<string, unknown> }>;
  base_resp?: { status_code?: number; status_msg?: string };
}

function messageContentToString(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const c = message.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) {
    const joined = c
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && 'text' in x) return String((x as { text?: unknown }).text ?? '');
        return '';
      })
      .join('');
    return joined.trim() ? joined : null;
  }
  return null;
}

function choiceAssistantText(choice: Record<string, unknown> | undefined): string | null {
  if (!choice) return null;
  const msg = choice.message as Record<string, unknown> | undefined;
  const fromMsg = messageContentToString(msg);
  if (fromMsg) return fromMsg;
  for (const key of ['content', 'text', 'output_text'] as const) {
    const v = choice[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

async function callMiniMaxModel(fragments: ContextFragments, endpoint: string): Promise<string> {
  const userContent = [
    '以下为完整上下文分片，请严格输出 JSON（无 Markdown、无代码围栏）：',
    '# userCorpus\n' + fragments.userCorpus,
    '# environment\n' + fragments.environment,
    '# listeningNow\n' + fragments.listeningNow,
    '# memory\n' + fragments.memory,
    '# userInput\n' + fragments.userInput,
    '# executionTrace\n' + fragments.executionTrace,
  ].join('\n\n');

  const body = {
    model: config.minimaxModel,
    messages: [
      { role: 'system' as const, name: 'Aura DJ', content: fragments.systemPrompt },
      { role: 'user' as const, name: 'User', content: userContent },
    ],
    temperature: 0.7,
    top_p: 0.95,
    max_completion_tokens: 2048,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.minimaxApiKey.trim()}`,
  };

  const ac = AbortSignal.timeout(config.minimaxFetchTimeoutMs);
  log.debug('brain request', { endpoint, model: body.model, keyPrefix: config.minimaxApiKey.slice(0, 8) });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: ac,
  });

  const textBody = await res.text();
  if (!res.ok) {
    throw new Error(`MiniMax HTTP ${res.status}: ${textBody.slice(0, 500)}`);
  }

  let data: MiniMaxChatCompletionJson;
  try {
    data = JSON.parse(textBody) as MiniMaxChatCompletionJson;
  } catch {
    throw new Error('MiniMax response JSON parse failed');
  }

  const code = data.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    throw new Error(`MiniMax base_resp ${code}: ${data.base_resp?.status_msg ?? ''}`);
  }

  const choice = data.choices?.[0] as Record<string, unknown> | undefined;
  const content = choiceAssistantText(choice);
  if (!content?.trim()) throw new Error('MiniMax empty content');
  return content;
}

/** Brain Adapter：Claude Code 架构的大脑适配器接口，内部调用 MiniMax */
export async function generateDjScript(fragments: ContextFragments): Promise<{
  script: DjScript;
  normalized: MoodTag;
  coercedTag: boolean;
  modelRaw?: string;
  usedFallback: boolean;
}> {
  const endpoint = resolveMinimaxEndpoint();
  if (config.minimaxMock || !config.minimaxApiKey.trim() || !endpoint) {
    const script = mockScript(fragments);
    const { moodTag, coerced } = normalizeMoodTag(script.moodTag);
    return { script: { ...script, moodTag }, normalized: moodTag, coercedTag: coerced, usedFallback: false };
  }

  let raw: string | undefined;
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      raw = await callMiniMaxModel(fragments, endpoint);
      const parsed = parseDjJson(raw);
      let { moodTag, coerced } = normalizeMoodTag(parsed.moodTag);
      if (coerced) log.warn('moodTag coerced to neutral');
      let script = { ...parsed, moodTag };

      /** Focus「留白」：抑制过长话术（仍保留结构化 JSON）。 */
      if (moodTag === 'focus' && script.say.trim().length > 0) {
        script = { ...script, say: '' };
      }

      return { script, normalized: moodTag, coercedTag: coerced, modelRaw: raw, usedFallback: false };
    } catch (e) {
      lastErr = e;
      log.warn('brain attempt failed', { attempt: i, err: e });
      await sleep(120 * (i + 1));
    }
  }

  log.warn('brain exhausted, using mockScript fallback', { err: lastErr });
  const script = mockScript(fragments);
  const { moodTag, coerced } = normalizeMoodTag(script.moodTag);
  return { script: { ...script, moodTag }, normalized: moodTag, coercedTag: coerced, usedFallback: true };
}
