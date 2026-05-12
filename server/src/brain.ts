import { z } from 'zod';
import { spawn } from 'node:child_process';
import { log } from './logger.js';
import type { DjScript, MoodTag } from './types.js';
import { deriveSessionMood, normalizeMoodTag } from './taste-mood.js';
import type { ContextFragments } from './context-builder.js';
import { config } from './config.js';
import { logBrainClaudeSession } from './db.js';

/**
 * Brain 在 **未** 设置 `BRAIN_MOCK=1` 时，不会在 Claude/MiniMax 失败后静默换用占位脚本；
 * 抛出本错误，由 HTTP 层返回 503。
 */
export class BrainUnavailableError extends Error {
  readonly code = 'BRAIN_UNAVAILABLE' as const;
  constructor(
    message: string,
    public readonly lastError?: unknown,
  ) {
    super(message);
    this.name = 'BrainUnavailableError';
  }
}

// ==================== 缓存机制 ====================
interface CacheEntry {
  script: DjScript;
  normalized: MoodTag;
  coercedTag: boolean;
  timestamp: number;
}

// 简单的内存缓存（基于 taste-cloud.md hash + 时段）
const recommendationCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟缓存
const MAX_CACHE_SIZE = 50; // 最大缓存条目

/** 生成缓存键：基于用户画像hash + 时段 + mood */
function generateCacheKey(fragments: ContextFragments): string {
  // 提取 taste-cloud.md 的关键特征（前200字符）作为用户画像指纹
  const tasteFingerprint = fragments.userCorpus.slice(0, 200).replace(/\s+/g, '');
  const hour = new Date().getHours();
  const mood = deriveSessionMood().moodTag;
  return `${tasteFingerprint.slice(0, 50)}_${hour}_${mood}`;
}

/** 清理过期缓存 */
function cleanupCache(): void {
  const now = Date.now();
  for (const [key, entry] of recommendationCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      recommendationCache.delete(key);
    }
  }
  // LRU：如果缓存过大，删除最旧的
  if (recommendationCache.size > MAX_CACHE_SIZE) {
    const sorted = [...recommendationCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = sorted.slice(0, sorted.length - MAX_CACHE_SIZE);
    for (const [key] of toDelete) {
      recommendationCache.delete(key);
    }
  }
}

// ==================== Claude CLI 预热 ====================
let claudeCliReady = false;

/** 预热 Claude CLI：启动时执行一次简单调用，减少首次用户请求的延迟 */
export async function warmupClaudeCli(): Promise<void> {
  if (!config.brainMock && !config.brainForceHttp) {
    log.info('Warming up Claude CLI...');
    const start = Date.now();
    try {
      // 执行一次简单预热调用
      const result = await spawnClaudeForWarmup();
      claudeCliReady = true;
      log.info('Claude CLI warmup successful', { durationMs: Date.now() - start });
    } catch (e) {
      log.warn('Claude CLI warmup failed (will retry on first request)', { err: e });
      // 预热失败不阻塞启动，首次请求时会重试
    }
  }
}

/** 预热专用：执行简单 prompt */
async function spawnClaudeForWarmup(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--print', '--input-format', 'text', '--permission-mode', 'bypassPermissions'],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf-8'); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8'); });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Warmup exit ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    // 发送简单预热 prompt
    child.stdin.write('Say "ready" in 1 word.', () => {
      child.stdin.end();
    });
  });
}

/** 避免 `z.coerce.string()` 把缺失字段变成字面量 "undefined" / "null" */
function cleanDjText(v: unknown, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  if (!s) return fallback;
  const low = s.toLowerCase();
  if (low === 'undefined' || low === 'null' || low === 'nan') return fallback;
  return s;
}

const DjScriptSchema = z
  .object({
    schemaVersion: z.preprocess((v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(1, Math.trunc(v));
      const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (t === 'nan' || t === 'undefined' || t === 'null' || t === '') return 1;
      const n = Number(v);
      if (!Number.isFinite(n) || Number.isNaN(n)) return 1;
      return Math.max(1, Math.trunc(n));
    }, z.number().int()),
    say: z.preprocess((v) => cleanDjText(v), z.string()),
    play: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(
      z.object({
        ncmSongId: z.preprocess((x) => cleanDjText(x, '0'), z.string()),
        reason: z.preprocess((x) => cleanDjText(x, '推荐'), z.string()),
        discoveryNote: z.preprocess((x) => cleanDjText(x), z.string().optional()),
      }),
    )),
    moodTag: z.preprocess((v) => cleanDjText(v, 'neutral'), z.string()),
    segue: z.preprocess((v) => cleanDjText(v, '我们继续。'), z.string()),
    telemetry: z.object({ confidence: z.number().optional() }).optional(),
  })
  .superRefine((data, ctx) => {
    for (let i = 0; i < data.play.length; i++) {
      const p = data.play[i];
      if (!p || !String(p.discoveryNote ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['play', i, 'discoveryNote'],
          message: '每项 play 必须含非空 discoveryNote（mmx 搜索驱动）',
        });
      }
    }
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

  // Claude CLI / Claude Code：`result` 可能是裸 JSON、` ```json {...} ``` `、或其它包装
  if (typeof o.result === 'string') {
    let inner = o.result.trim();
    if (inner.startsWith('```')) {
      inner = inner.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    }
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object') return unwrapDjPayload(parsed);
      } catch {
        /** */
      }
    }
  }

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

/** 容错：unwrap 后对顶层字段做小修，避免模型输出 `"NaN"` / 缺 play 导致整段降级 Mock。 */
function sanitizeDjPayloadTopLevel(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const o = payload as Record<string, unknown>;
  const next = { ...o };

  next.say = cleanDjText(next.say, '');
  next.segue = cleanDjText(next.segue, '我们继续听下去。');
  next.moodTag = cleanDjText(next.moodTag, 'neutral');

  if (!Array.isArray(next.play)) next.play = [];

  const sv = next.schemaVersion;
  if (
    sv === undefined ||
    sv === null ||
    (typeof sv === 'string' && ['nan', 'null', 'undefined', ''].includes(String(sv).trim().toLowerCase()))
  ) {
    next.schemaVersion = 1;
  } else if (typeof sv === 'string') {
    // Fix "NaN"/"Infinity" strings that can come from JSON.stringify of invalid values
    const lower = sv.trim().toLowerCase();
    if (lower === 'nan' || lower === 'infinity' || lower === '-infinity') {
      next.schemaVersion = 1;
    }
  }

  next.play = (next.play as unknown[]).map((row, i) => {
    if (!row || typeof row !== 'object')
      return {
        ncmSongId: `0_${i}`,
        reason: '推荐曲目',
        discoveryNote: '（模型缺省条目；服务端按 NCM 兜底）',
      };
    const r = row as Record<string, unknown>;
    const rawNote = cleanDjText(r.discoveryNote);
    const rawReason = cleanDjText(r.reason, '推荐');
    return {
      ncmSongId: r.ncmSongId != null ? String(r.ncmSongId) : '0',
      reason: rawReason,
      discoveryNote:
        rawNote ||
        `（无 discoveryNote）${rawReason} ${cleanDjText(r.ncmSongId, '')}`.slice(0, 200),
    };
  });

  return next;
}

function parseDjJson(text: string): DjScript {
  const trimmed = text.trim();

  /** 优先整段解析 Claude Code `--output-format json` 外层包，再走 unwrap（支持 result 内 ```json） */
  if (trimmed.startsWith('{')) {
    try {
      const root = JSON.parse(trimmed) as unknown;
      const unwrapped = unwrapDjPayload(root);
      if (
        unwrapped &&
        typeof unwrapped === 'object' &&
        ('schemaVersion' in unwrapped || 'play' in unwrapped)
      ) {
        const payload = sanitizeDjPayloadTopLevel(unwrapped);
        return DjScriptSchema.parse(payload) as DjScript;
      }
    } catch {
      /** 回退到「截取首个对象」路径 */
    }
  }

  let jsonStr = extractJsonObjectSlice(text);
  jsonStr = jsonStr.replace(/"NaN"/g, '"1"').replace(/"Infinity"/g, '"1"').replace(/"-Infinity"/g, '"1"');
  const obj = JSON.parse(jsonStr) as unknown;
  const payload = sanitizeDjPayloadTopLevel(unwrapDjPayload(obj));
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
        discoveryNote: 'brainMock：无 mmx 编排',
      },
    ],
    moodTag: session.moodTag,
    segue: '我们轻轻进入下一段。',
    telemetry: { confidence: 0.5 },
  };
}

/** 组装完整 prompt：dj-persona.md + 七片段（含 `# songCandidates`） */
function assembleFullPrompt(fragments: ContextFragments): string {
  return [
    fragments.systemPrompt,
    '',
    '---',
    '',
    '# userCorpus',
    fragments.userCorpus,
    '',
    '# environment',
    fragments.environment,
    '',
    '# listeningNow',
    fragments.listeningNow,
    '',
    '# songCandidates',
    fragments.songCandidates,
    '',
    '# memory',
    fragments.memory,
    '',
    '# userInput',
    fragments.userInput,
    '',
    '# executionTrace',
    fragments.executionTrace,
    '',
    '# mmxCliGate',
    [
      `唯一允许的联网检索：MiniMax **mmx-cli**（经由 gate 校验与审计）。**禁止** WebSearch / Brave / MCP。`,
      `请用 Bash 仅执行下列形式之一（MINIMAX_API_KEY 勿写入仓库，可用环境变量注入）：`,
      `  node "${config.mmxCliGateJsPath.replace(/\\/g, '\\\\')}" search query "<检索词>" --output json`,
      `  node "${config.mmxCliGateJsPath.replace(/\\/g, '\\\\')}" text chat "<提示>" （必要时）`,
      `gate 内等价命令须匹配：^npx\\\\s+(-y\\\\s+)?mmx-cli\\\\s+(search|text\\\\s+chat|chat)\\\\b`,
      `拿到 mmx-cli 返回的歌名/艺人线索后写入 discoveryNote；最终 JSON 的 play 每项含 discoveryNote（必填）。`,
    ].join('\n'),
    '',
    '---',
    '',
    '硬性输出约束：',
    '- `say` / `segue` / `moodTag` 必须是**自然人话字符串**，禁止使用 JSON 字面量 null、禁止使用英文单词 undefined/null 当作字符串内容。',
    '- `play` 须含 **3–4 首**（Focus 可调少但仍须非空时每条均有 discoveryNote）；`discoveryNote` 写「用于网易云搜索的中文或英文短语」，可与 mmx 结果合并；若 mmx 仅词典释义，则用「日文氛围民谣」「类似 XX 艺人的冷门曲」这类**可拿去云搜的关键词**填满 discoveryNote。',
    '',
    '请严格输出单一 JSON 对象（不要 Markdown 围栏），包含 schemaVersion、say、play、 moodTag、segue、telemetry 字段。',
  ].join('\n');
}

/** 子进程调用本地 Claude CLI */
async function callLocalClaude(fragments: ContextFragments): Promise<string> {
  const prompt = assembleFullPrompt(fragments);

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--print', '--input-format', 'text', '--permission-mode', 'bypassPermissions'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf-8'); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8'); });

    child.on('error', (err) => {
      reject(new Error(`Claude CLI spawn failed: ${err.message}`));
    });

    child.on('close', (code) => {
      try {
        logBrainClaudeSession(stderr, stdout);
      } catch { /* */ }
      if (code !== 0) {
        reject(new Error(`Claude CLI exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error('Claude CLI returned empty stdout'));
        return;
      }
      resolve(stdout);
    });

    // 通过 stdin 传入 prompt，避免命令行参数长度超限（ENAMETOOLONG）
    child.stdin.write(prompt, () => {
      child.stdin.end();
    });
  });
}

/** 备用：HTTP 调用 MiniMax（仅当本地 Claude/mm 编排不可用；**不**使用 Brave/MCP，亦非 mmx-cli 的替代搜索通道）。 */
async function callMiniMaxHttp(fragments: ContextFragments): Promise<string> {
  const endpoint = config.minimaxApiUrl
    ? `${config.minimaxApiUrl}/text/chatcompletion_v2`
    : 'https://api.minimax.chat/v1/text/chatcompletion_v2';

  const userContent = [
    '以下为完整上下文分片，请严格输出 JSON（无 Markdown、无代码围栏）。',
    '若你能看到 #mmxCliGate：联网发现应已在主流程由 mmx-cli 完成；本条为降级通道，仍须输出带 discoveryNote 的 play（无搜索时可写「降级：无 mmx」）。',
    '# userCorpus\n' + fragments.userCorpus,
    '# environment\n' + fragments.environment,
    '# listeningNow\n' + fragments.listeningNow,
    '# songCandidates\n' + fragments.songCandidates,
    '# memory\n' + fragments.memory,
    '# userInput\n' + fragments.userInput,
    '# executionTrace\n' + fragments.executionTrace,
  ].join('\n\n');

  const body = {
    model: config.minimaxModel || 'MiniMax-M2.7',
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

  const ac = AbortSignal.timeout(config.minimaxFetchTimeoutMs || 60000);
  log.debug('brain fallback to MiniMax HTTP', { endpoint, model: body.model });

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

  const data = JSON.parse(textBody) as { choices?: Array<{ message?: { content?: string } }>; base_resp?: { status_code?: number; status_msg?: string } };
  
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax base_resp ${data.base_resp.status_code}: ${data.base_resp.status_msg ?? ''}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error('MiniMax empty content');
  return content;
}

/** Brain Adapter：优先本地 Claude，失败则 MiniMax HTTP。失败时 **不** 自动 Mock；仅 `BRAIN_MOCK=1` 可走占位脚本。 */
export async function generateDjScript(
  fragments: ContextFragments,
  options?: { mmxInvocationId?: string }
): Promise<{
  script: DjScript;
  normalized: MoodTag;
  coercedTag: boolean;
  modelRaw?: string;
  usedFallback: boolean;
}> {
  // 如果显式启用 Mock 模式，直接返回
  if (config.brainMock) {
    const script = mockScript(fragments);
    const { moodTag, coerced } = normalizeMoodTag(script.moodTag);
    return { script: { ...script, moodTag }, normalized: moodTag, coercedTag: coerced, usedFallback: false };
  }

  // ==================== 缓存检查 ====================
  cleanupCache();
  const cacheKey = generateCacheKey(fragments) + (options?.mmxInvocationId ? `_${options.mmxInvocationId.slice(0, 8)}` : '');
  const cached = recommendationCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.info('Using cached recommendation', { cacheKey: cacheKey.slice(0, 20) + '...' });
    return {
      script: cached.script,
      normalized: cached.normalized,
      coercedTag: cached.coercedTag,
      usedFallback: false,
    };
  }

  let raw: string | undefined;
  let lastErr: unknown;
  let usedLocalClaude = false;

  // 尝试 1：本地 Claude CLI（至多 3 次短重试）；BRAIN_FORCE_HTTP=1 时跳过
  if (!config.brainForceHttp) {
    for (let i = 0; i < 3; i++) {
      try {
        raw = await callLocalClaude(fragments);
        usedLocalClaude = true;
        log.info('brain local Claude success', { attempt: i });
        break;
      } catch (e) {
        lastErr = e;
        log.warn('brain local Claude attempt failed', { attempt: i, err: e });
        if (i < 2) await sleep(800);
      }
    }
  } else {
    log.info('brain BRAIN_FORCE_HTTP=1 skipping local Claude');
  }

  // 尝试 2：MiniMax HTTP（如果本地 Claude 失败）
  if (!raw && config.minimaxApiKey.trim()) {
    try {
      raw = await callMiniMaxHttp(fragments);
      log.info('brain MiniMax HTTP fallback success');
    } catch (e) {
      lastErr = e;
      log.warn('brain MiniMax HTTP fallback failed', { err: e });
    }
  }

  // 尝试解析 JSON
  if (raw) {
    try {
      const parsed = parseDjJson(raw);
      let { moodTag, coerced } = normalizeMoodTag(parsed.moodTag);
      if (coerced) log.warn('moodTag coerced to neutral');
      let script = { ...parsed, moodTag };

      /** Focus「留白」：抑制过长话术（仍保留结构化 JSON）。 */
      if (moodTag === 'focus' && script.say.trim().length > 0) {
        script = { ...script, say: '' };
      }

      // ==================== 缓存成功的结果 ====================
      if (!config.brainMock) {
        recommendationCache.set(cacheKey, {
          script,
          normalized: moodTag,
          coercedTag: coerced,
          timestamp: Date.now(),
        });
        log.debug('Recommendation cached', { cacheKey: cacheKey.slice(0, 20) + '...', cacheSize: recommendationCache.size });
      }

      return { 
        script, 
        normalized: moodTag, 
        coercedTag: coerced, 
        modelRaw: raw, 
        usedFallback: !usedLocalClaude 
      };
    } catch (e) {
      lastErr = e;
      log.warn('brain JSON parse failed', { err: e });
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : lastErr != null ? String(lastErr) : '';
  const noMinimax = !config.minimaxApiKey.trim();
  log.error('brain unavailable (automatic mock disabled)', { err: lastErr, noMinimax });
  throw new BrainUnavailableError(
    [
      'Brain 不可用：本地 Claude 未返回可解析结果，且 MiniMax HTTP 失败或不可用。',
      noMinimax ? '未配置 MINIMAX_API_KEY，无法走 HTTP 降级。' : '',
      detail ? `详情：${detail.slice(0, 400)}` : '',
      '若仅需占位开发/测试，请显式设置环境变量 BRAIN_MOCK=1。',
    ]
      .filter(Boolean)
      .join(' '),
    lastErr,
  );
}
