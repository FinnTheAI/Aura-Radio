import { z } from 'zod';
import { config } from './config.js';
import { log } from './logger.js';
import type { DjScript, MoodTag } from './types.js';
import { deriveSessionMood, normalizeMoodTag } from './taste-mood.js';
import type { ContextFragments } from './context-builder.js';
import { pickMockNcmSongId } from './mock-dj-pick.js';

const DjScriptSchema = z.object({
  schemaVersion: z.number(),
  say: z.string(),
  play: z.array(
    z.object({
      ncmSongId: z.string(),
      reason: z.string(),
    }),
  ),
  moodTag: z.string(),
  segue: z.string(),
  telemetry: z.object({ confidence: z.number().optional() }).optional(),
});

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 官方路径：`https://api.minimax.io/v1/text/chatcompletion_v2`（MINIMAX_API_URL 可为带或不带 `/v1` 的基座）。 */
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
    return minimaxChatCompletionEndpoint('https://api.minimax.io/v1');
  return null;
}

interface MiniMaxChatCompletionJson {
  choices?: Array<{ message?: { content?: string } }>;
  base_resp?: { status_code?: number; status_msg?: string };
}

function mockScript(fragments: ContextFragments): DjScript {
  const session = deriveSessionMood();
  const pick = pickMockNcmSongId(session.moodTag);
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

function parseDjJson(text: string): DjScript {
  const trimmed = text.trim();
  const jsonStr = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
    : trimmed;
  const obj = JSON.parse(jsonStr) as unknown;
  return DjScriptSchema.parse(obj) as DjScript;
}

async function callMiniMaxModel(fragments: ContextFragments, endpoint: string): Promise<string> {
  const userContent = [
    '以下为完整上下文分片，请严格输出 JSON（无 Markdown、无代码围栏）：',
    '# userCorpus\n' + fragments.userCorpus,
    '# environment\n' + fragments.environment,
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
  log.debug('minimax request', { endpoint, model: body.model, keyPrefix: config.minimaxApiKey.slice(0, 8) });
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
  const content = data.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) throw new Error('MiniMax empty content');
  return String(content);
}

/** 请求 MiniMax（或 Mock），失败时返回安全降级脚本。 */
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
      log.warn('minimax attempt failed', { attempt: i, err: e });
      await sleep(120 * (i + 1));
    }
  }

  log.warn('minimax exhausted, using mockScript fallback', { err: lastErr });
  const script = mockScript(fragments);
  const { moodTag, coerced } = normalizeMoodTag(script.moodTag);
  return { script: { ...script, moodTag }, normalized: moodTag, coercedTag: coerced, usedFallback: true };
}
