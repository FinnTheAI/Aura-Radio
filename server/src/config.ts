import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, '..', '..', '.env') });
loadEnv({ path: path.join(__dirname, '..', '.env') });

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * `NCM_API_BASE_URL` 只需在 `.env` 里写一次即长期生效。
 * 若留空且设 `NCM_ALLOW_LOCAL_DEFAULT=1`，开发机假定代理跑在 `127.0.0.1:3000`（可用 `NCM_LOCAL_FALLBACK_PORT` 覆盖）。
 */
function resolveNcmApiBase(): string {
  const fromEnv = (process.env.NCM_API_BASE_URL ?? '').replace(/\/$/, '').trim();
  if (fromEnv) return fromEnv;
  if (parseBool(process.env.NCM_ALLOW_LOCAL_DEFAULT, false)) {
    const p = Number(process.env.NCM_LOCAL_FALLBACK_PORT ?? 3000);
    const port = Number.isFinite(p) && p > 0 && p < 65536 ? Math.floor(p) : 3000;
    return `http://127.0.0.1:${port}`;
  }
  return '';
}

const resolvedNcmApiBase = resolveNcmApiBase();

/** 拼接代理请求 Cookie：`NCM_UPSTREAM_COOKIE` + 可选 `MUSIC_U`。勿提交真实值。 */
export function mergeNcmCookies(): string {
  const upstream = (process.env.NCM_UPSTREAM_COOKIE ?? '').trim();
  const rawU = (process.env.MUSIC_U ?? '').trim();
  if (!rawU) return upstream;
  const token = rawU.includes('=') ? rawU : `MUSIC_U=${rawU}`;
  if (/MUSIC_U\s*=/.test(upstream)) return upstream;
  return upstream ? `${upstream}; ${token}` : token;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  dataDir: process.env.DATA_DIR ? path.resolve(process.cwd(), process.env.DATA_DIR) : path.join(repoRoot, 'data'),
  userDataDir: process.env.USER_DATA_DIR
    ? path.resolve(process.cwd(), process.env.USER_DATA_DIR)
    : path.join(repoRoot, 'data', 'user'),
  promptsDir: process.env.PROMPTS_DIR
    ? path.resolve(process.cwd(), process.env.PROMPTS_DIR)
    : path.join(repoRoot, 'prompts'),
  stateDbPath: process.env.STATE_DB_PATH
    ? path.resolve(process.cwd(), process.env.STATE_DB_PATH)
    : path.join(repoRoot, 'data', 'state.db'),
  ncmApiBaseUrl: resolvedNcmApiBase,
  /** 解析后非空且无显式关闭时等价于「可走真实 NCM HTTP」；见 `resolveNcmApiBase`。 */
  ncmMock: parseBool(process.env.NCM_MOCK, !resolvedNcmApiBase),
  /**
   * When `ncmMock` is true (no NeteaseCloudMusicApi URL): by default use fast placeholder audio only.
   * Set `NCM_MOCK_USE_YTDLP=1` to experimentally resolve real URLs via yt-dlp (slow / geo-sensitive).
   */
  ncmMockUseYtdlp: parseBool(process.env.NCM_MOCK_USE_YTDLP, false),
  /** Upstream NeteaseCloudMusicApi request timeout (ms). */
  ncmFetchTimeoutMs: Math.max(1000, Number(process.env.NCM_FETCH_TIMEOUT_MS ?? 20_000) || 20_000),
  /**
   * Optional Cookie header sent to `NCM_API_BASE_URL` only (e.g. local proxy needs login state).
   * Never commit real cookie values.
   */
  ncmUpstreamCookie: (process.env.NCM_UPSTREAM_COOKIE ?? '').trim(),
  /**
   * 网易云登录态 Cookie 片段（常为 `MUSIC_U=...`，也可写成完整片段）。会与 `NCM_UPSTREAM_COOKIE` 合并发往代理。
   * 实际账号 UID 仍可设 `NETEASE_UID`，否则服务端用 `/user/account` 推断。
   */
  neteaseUid: (process.env.NETEASE_UID ?? '').trim(),
  /** MiniMax API 基座 URL */
  minimaxApiUrl: (process.env.MINIMAX_API_URL ?? '').replace(/\/$/, ''),
  /** MiniMax API Key，勿提交仓库 */
  minimaxApiKey: process.env.MINIMAX_API_KEY ?? '',
  /** MiniMax 模型 ID */
  minimaxModel: (process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7').trim() || 'MiniMax-M2.7',
  minimaxMock: parseBool(process.env.MINIMAX_MOCK, !process.env.MINIMAX_API_KEY),
  /** MiniMax 请求超时（毫秒）。 */
  minimaxFetchTimeoutMs: Math.max(3000, Number(process.env.MINIMAX_FETCH_TIMEOUT_MS ?? 60_000) || 60_000),
  minimaxMockVoiceUrl:
    process.env.MINIMAX_MOCK_VOICE_URL ||
    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  /**
   *（可选）本机点播抢答：**默认关闭**。产品以 MiniMax Brain 产出 `play[]` 为主；仅调试或遥控器场景设 `NETEASE_CLI_ENABLED=1`。
   */
  neteaseCliPlayEnabled: parseBool(process.env.NETEASE_CLI_ENABLED, false),

  // Brain 配置
  /**
   * 显式启用 Brain 占位脚本（与真实 Claude/MiniMax 解耦）。
   * **未启用**时，两级调用均失败将 **不再静默 Mock**，HTTP 返回 503（见 `BrainUnavailableError`）。
   */
  brainMock: parseBool(process.env.BRAIN_MOCK, false),
  brainForceHttp: parseBool(process.env.BRAIN_FORCE_HTTP, false),

  // TTS 配置
  minimaxTtsEnabled: parseBool(process.env.MINIMAX_TTS_ENABLED, true),
  minimaxTtsVoiceId: process.env.MINIMAX_TTS_VOICE_ID ?? 'male-qn-qingse',
  minimaxTtsBgmEnabled: parseBool(process.env.MINIMAX_TTS_BGM_ENABLED, true),
  minimaxTtsBgmUrl: process.env.MINIMAX_TTS_BGM_URL || 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',

  // mmx-cli gate 配置
  mmxCliGateJsPath: process.env.MMX_CLI_GATE_JS_PATH ?? './tools/mmx-cli-gate.js',
  mmxMaxSearchPerInvocation: Number(process.env.MMX_MAX_SEARCH_PER_INVOCATION ?? 3),

  // 下一首发现冷却时间
  nextTrackDiscoveryCooldownMs: Number(process.env.NEXT_TRACK_DISCOVERY_COOLDOWN_MS ?? 30_000),
};
