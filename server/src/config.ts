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
  ncmApiBaseUrl: (process.env.NCM_API_BASE_URL ?? '').replace(/\/$/, ''),
  ncmMock: parseBool(process.env.NCM_MOCK, !process.env.NCM_API_BASE_URL),
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
   * 「播放 xxx」点播：服务端用 `ncmSearch`（`NCM_API_BASE_URL`/mock），**不使用** `@music163/ncm-cli` 的 search
   *（公开发行版暂无该命令）。CLI 仍可本机 Skills / TUI 使用。
   */
  neteaseCliPlayEnabled: parseBool(process.env.NETEASE_CLI_ENABLED, false),
};
