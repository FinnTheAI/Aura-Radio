import { mountAuraScene } from './visual';

interface NowPlaying {
  type: 'music' | 'voice' | 'idle';
  title?: string;
  artist?: string;
  moodTag?: string;
  traceId?: string;
  url?: string;
  /** 外链经服务端同源代理后的地址；优先喂给 `<audio>` 以便 Web Audio Analyser。 */
  proxiedUrl?: string;
}

const metaEl = document.querySelector('#meta') as HTMLElement;
const bootBtn = document.querySelector('#boot') as HTMLButtonElement;
const newSegmentBtn = document.querySelector('#new-segment') as HTMLButtonElement;
const forcePlayBtn = document.querySelector('#force-play') as HTMLButtonElement;
const sceneEl = document.querySelector('#scene') as HTMLElement;
const audioEl = document.querySelector('#player') as HTMLAudioElement;
const chatInput = document.querySelector('#chat-input') as HTMLInputElement;
const chatSendBtn = document.querySelector('#chat-send') as HTMLButtonElement;
const djSpeakingEl = document.querySelector('#dj-speaking') as HTMLElement;

/** `/api/chat` 返回的 DJ 脚本片段（仅需客户端播报 `say`）。 */
interface ChatDjScript {
  schemaVersion?: number;
  say?: string;
  moodTag?: string;
  play?: unknown[];
  segue?: string;
}

/** 播报期间忽略 WS `now_playing`，避免音乐先于口播 hydrate。 */
let suppressWsNowPlaying = 0;

function setDjSpeakingVisible(on: boolean) {
  djSpeakingEl.hidden = !on;
}

/** 极短静音 WAV（data URL），用于在用户点击的同一同步栈里触发一次合法 play，降低后续被策略拦截的概率。 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';

/** 外链经 `/api/audio/proxy` 同源后，可安全走 MediaElementSource + Analyser。 */
const ENABLE_MEDIA_ELEMENT_ANALYSER = true;

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let freqBin = new Uint8Array(0);
/** 仅在同源可分析音频且已安全接线时为 true。 */
let webAudioGraphOk = false;
let mediaElementSourceTapped = false;
let ambientOnly = false;
let lastPlayedKey = '';
let synthPhase = 0;
/** 未经过用户点击前，忽略 WS 推送，避免无手势 play / 错误状态污染界面。 */
let userAllowedPlayback = false;
let lastReportedAudioError: number | null = null;
/** 静音片手势只需做一次；再次点「唤醒」若重写 src 会破坏当前在播的 MP3。 */
let didSilentGesturePrime = false;

/** 隐藏的预加载音频元素（仅调用 .load()，不调用 .play()）。 */
const preloadEl = document.createElement('audio');
preloadEl.id = 'preload-audio';
preloadEl.style.display = 'none';
document.body.appendChild(preloadEl);

/** 当前预加载目标：歌曲项 + 绝对 URL；undefined 表示无有效目标。 */
let preloadInfo: { item: unknown; absUrl: string } | undefined;

/**
 * WS `queue` 的 items：有在播条目时服务端 `peek` 会把当前项放在首位，应从 1 起找下一首音乐；idle 时整段即为待播队列，从 0 起找。
 */
let queueMusicScanStartIndex = 0;

function normalizeUrl(u?: string) {
  if (!u) return '';
  try {
    if (u.startsWith('http://') || u.startsWith('https://')) return u;
    return new URL(u, window.location.href).href;
  } catch {
    return '';
  }
}

/** 从队列中找出第一个音乐项（kind='music'）及其可用 URL。 */
function findNextMusicItem(
  items: unknown[],
  startIndex = 0,
): { item: unknown; absUrl: string } | undefined {
  for (let i = Math.max(0, startIndex); i < items.length; i++) {
    const raw = items[i];
    const it = raw as { kind?: string; proxiedUrl?: string; url?: string };
    if (it.kind === 'music') {
      const absUrl = normalizeUrl(it.proxiedUrl ?? it.url);
      if (absUrl) return { item: raw, absUrl };
    }
  }
  return undefined;
}

/** 对给定 URL 发起预加载（仅 .load()，不 .play()）。 */
function preloadTrack(absUrl: string | undefined) {
  if (!absUrl) {
    preloadInfo = undefined;
    preloadEl.removeAttribute('src');
    preloadEl.load();
    return;
  }
  preloadInfo = { item: undefined, absUrl };
  preloadEl.src = absUrl;
  preloadEl.load();
}

function mediaUrlIsSameOriginForAnalyser(absUrl: string): boolean {
  try {
    const u = new URL(absUrl, window.location.href);
    if (u.protocol === 'blob:') return true;
    return u.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** 在已知 URL 后尝试接线；外链或未开启开关时绝不接线，避免「短促一声」。 */
function tryAttachAnalyserForUrl(absUrl: string) {
  if (!ENABLE_MEDIA_ELEMENT_ANALYSER || mediaElementSourceTapped) return;
  if (!mediaUrlIsSameOriginForAnalyser(absUrl)) {
    webAudioGraphOk = false;
    return;
  }
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(audioEl);
    const gain = audioCtx.createGain();
    gain.gain.value = 1;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.76;
    freqBin = new Uint8Array(analyser.frequencyBinCount);
    src.connect(gain);
    gain.connect(analyser);
    analyser.connect(audioCtx.destination);
    mediaElementSourceTapped = true;
    webAudioGraphOk = true;
  } catch {
    webAudioGraphOk = false;
    analyser = null;
  }
}

function setForcePlayVisible(v: boolean) {
  forcePlayBtn.hidden = !v;
}

function resetAudioElement() {
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  lastReportedAudioError = null;
}

async function hydrateFromNow(np: NowPlaying) {
  queueMusicScanStartIndex = np.type === 'idle' ? 0 : 1;

  const playRaw = np.proxiedUrl ?? np.url;
  const key = `${np.traceId}:${np.title}:${normalizeUrl(playRaw)}`;
  if (!playRaw) {
    metaEl.textContent =
      `${np.type} · ${np.moodTag ?? ''}` + (np.title ? ` · ${np.title}` : '') + '\n暂无可播放音频 URL。';
    setForcePlayVisible(false);
    return;
  }

  metaEl.textContent =
    `${np.type} · ${np.moodTag ?? ''}${np.title ? ` · ${np.title}` : ''}${np.artist ? ` — ${np.artist}` : ''}` +
    `\ntrace:${np.traceId ?? '—'}`;

  const absUrl = normalizeUrl(playRaw);
  const sameKey = key === lastPlayedKey;
  const stuckOnSilentPrime = audioEl.src.startsWith('data:');
  if (sameKey && !stuckOnSilentPrime && !audioEl.error) {
    if (audioEl.ended) {
      try {
        audioEl.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
    if (audioEl.paused || audioEl.ended) {
      audioEl.muted = false;
      try {
        await audioEl.play();
        setForcePlayVisible(false);
      } catch (e) {
        metaEl.textContent += '\n浏览器拦截了自动播放：请点「点此出声」。';
        setForcePlayVisible(true);
        console.warn('[aura] audio.play() rejected (same track)', e);
      }
    }
    return;
  }

  lastPlayedKey = key;
  resetAudioElement();
  tryAttachAnalyserForUrl(absUrl);
  audioEl.src = absUrl;
  audioEl.volume = np.type === 'voice' ? 0.95 : 0.92;
  audioEl.muted = false;
  try {
    await audioEl.play();
    setForcePlayVisible(false);
  } catch (e) {
    metaEl.textContent += '\n浏览器拦截了自动播放：请点「点此出声」。';
    setForcePlayVisible(true);
    /** 便于你在控制台看到真实原因 */
    console.warn('[aura] audio.play() rejected', e);
  }

  // Hydration 完成后立即更新预加载目标（下次 now_playing + queue 会再次更新，以 queue 为准）
  if (preloadInfo && preloadInfo.absUrl !== absUrl) {
    preloadInfo = undefined;
  }
}

async function resumeAudioContextIfAny() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
}

function bandsFromAnalyser(): { low: number; high: number } {
  if (!analyser) return { low: 0.02, high: 0.02 };
  analyser.getByteFrequencyData(freqBin);
  let lowSum = 0;
  let highSum = 0;
  const n = freqBin.length;
  const split = Math.floor(n * 0.12);
  for (let i = 0; i < split; i++) lowSum += freqBin[i]!;
  for (let i = split; i < n; i++) highSum += freqBin[i]!;
  const rawLow = lowSum / (255 * Math.max(1, split));
  const rawHigh = highSum / (255 * Math.max(1, n - split));
  /** 提升可视动态范围：轻度 gamma + 增益（仍钳制到 1） */
  const low = Math.min(1, Math.pow(Math.min(1, rawLow * 2.05), 0.88));
  const high = Math.min(1, Math.pow(Math.min(1, rawHigh * 2.35), 0.9));
  return { low, high };
}

function bandsAmbient(): { low: number; high: number } {
  synthPhase += 0.022;
  const low = (Math.sin(synthPhase * 1.35) + 1) * 0.35;
  const high = (Math.sin(synthPhase * 3.85 + 2.7) + 1) * 0.28;
  return { low, high };
}

mountAuraScene(
  sceneEl,
  () => (ambientOnly || !webAudioGraphOk || !analyser ? bandsAmbient() : bandsFromAnalyser()),
  () => ambientOnly,
);

async function pullNowAndPlay(chatTraceId?: string) {
  const res = await fetch('/api/now');
  if (!res.ok) return;
  const np = (await res.json()) as NowPlaying;
  await hydrateFromNow(np);
  if (chatTraceId && chatTraceId !== np.traceId) {
    metaEl.textContent =
      `${metaEl.textContent ?? ''}\n本次请求 trace:${chatTraceId}（与当前播放项 trace 不同，多为连续点了两次「唤醒」）`.trim();
  }
}

function runSilentGesturePrimeOnce() {
  if (!didSilentGesturePrime) {
    didSilentGesturePrime = true;
    try {
      audioEl.muted = true;
      audioEl.src = SILENT_WAV;
      void audioEl.play();
    } catch {
      /* ignore */
    }
  }
}

async function postDjChat(
  text: string,
  replaceQueue: boolean,
): Promise<{ traceId: string; djScript?: ChatDjScript }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone },
    body: JSON.stringify({ text, replaceQueue }),
  });
  const body = (await res.json()) as { error?: string; traceId?: string; djScript?: ChatDjScript };
  if (!res.ok) throw new Error(body.error ?? String(res.status));
  return { traceId: body.traceId as string, djScript: body.djScript };
}

function pickZhSpeechVoice(): SpeechSynthesisVoice | null {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  const voices = synth.getVoices();
  const cn = voices.find((v) => (v.lang ?? '').toLowerCase().startsWith('zh-cn'));
  if (cn) return cn;
  const tw = voices.find((v) => (v.lang ?? '').toLowerCase().startsWith('zh-tw'));
  if (tw) return tw;
  return voices.find((v) => /^zh/i.test(v.lang ?? '')) ?? null;
}

function ensureSpeechVoicesLoaded(): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve();
  }
  if (window.speechSynthesis.getVoices().length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const done = () => {
      synth.removeEventListener('voiceschanged', onVc);
      resolve();
    };
    const onVc = () => done();
    synth.addEventListener('voiceschanged', onVc);
    window.setTimeout(done, 900);
  });
}

/**
 * 用户手势链内朗读 `say`；失败或未支持时静默跳过（不向控制台抛 speech 错误）。
 * 解析完成后 resolve，便于再接 `/api/now` 播音乐。
 */
async function speakDjScriptSay(_say: string | undefined): Promise<void> {
  // 已废弃：口播内容现在由服务端 TTS 生成 MP3，通过队列 voice 项目播放
  // 不再使用浏览器 Web Speech API（会产生重复声音）
  return;
}

/** 先朗读 `djScript.say`（若有），再拉当前播放态，避免音乐抢先盖过口播。 */
async function djSpeechThenPullNow(traceId: string | undefined, djScript: ChatDjScript | undefined) {
  suppressWsNowPlaying++;
  try {
    await speakDjScriptSay(djScript?.say);
    await pullNowAndPlay(traceId);
  } finally {
    suppressWsNowPlaying--;
  }
}

/** 当前 <audio> 是否已指向真实媒资（非 data: 手势片）。 */
function hasRenderableAudioSrc(): boolean {
  const s = audioEl.currentSrc || audioEl.src || '';
  return Boolean(s) && !s.startsWith('data:');
}

bootBtn.addEventListener('click', async () => {
  userAllowedPlayback = true;

  /** 已有在播/可续播的媒资时：主按钮在「暂停 ⟷ 继续」之间切换，不再重复请求 /api/chat。 */
  if (hasRenderableAudioSrc() && !audioEl.paused && !audioEl.ended) {
    audioEl.pause();
    bootBtn.textContent = '已暂停 — 点此继续播放';
    return;
  }

  if (hasRenderableAudioSrc() && audioEl.paused && !audioEl.ended) {
    try {
      audioEl.muted = false;
      await audioEl.play();
      bootBtn.textContent = '已唤醒 — 悬停此处可显示指令';
    } catch (e) {
      metaEl.textContent += `\n继续播放失败：${String(e)}`;
      setForcePlayVisible(true);
    }
    return;
  }

  runSilentGesturePrimeOnce();

  await resumeAudioContextIfAny();
  bootBtn.textContent = '已唤醒 — 悬停此处可显示指令';
  try {
    const body = await postDjChat('初次见面，帮我开始一段轻柔的电台。', false);
    /** 先客户端播报 `say`，再拉队列头音乐（与无 voice 队列段对齐）。 */
    await djSpeechThenPullNow(body.traceId, body.djScript);
    window.setTimeout(() => {
      if (audioEl.paused && audioEl.src && !audioEl.ended) {
        setForcePlayVisible(true);
        metaEl.textContent += '\n若仍无声，请点「点此出声」。';
      }
    }, 400);
  } catch (e) {
    metaEl.textContent = `首包失败（请确认后端在 8080 运行）：${String(e)}`;
  }
});

newSegmentBtn.addEventListener('click', async () => {
  userAllowedPlayback = true;
  runSilentGesturePrimeOnce();
  await resumeAudioContextIfAny();
  try {
    const body = await postDjChat(
      '换一段：与刚刚明显不同的选曲与口播（可短），避免重复上一段的立意。',
      true,
    );
    /** 服务端已清空队列；客户端也丢弃「同一 key」短路，确保立刻拉新头。 */
    lastPlayedKey = '';
    await djSpeechThenPullNow(body.traceId, body.djScript);
    metaEl.textContent += '\n换段：队列已重置，正在播放新片段。';
  } catch (e) {
    metaEl.textContent = `换一段失败：${String(e)}`;
  }
});

forcePlayBtn.addEventListener('click', async () => {
  userAllowedPlayback = true;
  await pullNowAndPlay();
  try {
    audioEl.muted = false;
    await audioEl.play();
    setForcePlayVisible(false);
  } catch (e) {
    metaEl.textContent += `\n点此出声仍失败：${String(e)}`;
  }
});

chatSendBtn.addEventListener('click', async () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  userAllowedPlayback = true;
  await resumeAudioContextIfAny();
  try {
    const body = await postDjChat(text, false);
    await djSpeechThenPullNow(body.traceId, body.djScript);
  } catch (e) {
    metaEl.textContent = `发送失败：${String(e)}`;
  }
});

chatInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') chatSendBtn.click();
});

window.addEventListener('keydown', async (ev) => {
  if (ev.code !== 'Space') return;
  ev.preventDefault();
  await fetch('/api/queue/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'KeyB') {
    ambientOnly = !ambientOnly;
    metaEl.textContent =
      (metaEl.textContent ?? '') + `\n环境呼吸 ${ambientOnly ? '开' : '关'}（按 B 切换）`;
  }
});

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/stream`);

ws.addEventListener('message', async (ev) => {
  if (!userAllowedPlayback) return;
  if (suppressWsNowPlaying > 0) return;
  try {
    const msg = JSON.parse(String(ev.data)) as { type?: string; payload?: unknown; items?: unknown[] };
    const npRaw = msg.payload as NowPlaying | undefined;
    if (msg.type === 'now_playing' && npRaw?.type) {
      const np = npRaw;
      await hydrateFromNow(np);
    } else if (msg.type === 'queue' && Array.isArray(msg.items)) {
      const next = findNextMusicItem(msg.items, queueMusicScanStartIndex);
      preloadTrack(next?.absUrl);
    }
  } catch {
    /** ignore */
  }
});

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'ping', schemaVersion: 1 }));
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

/** 预热语音列表（Chrome 等异步加载 voices）。 */
if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
}

audioEl.addEventListener('error', () => {
  const err = audioEl.error;
  const code = err?.code ?? null;
  if (code !== null && code === lastReportedAudioError) return;
  lastReportedAudioError = code;
  /** 允许「点此出声」对同一曲重新 load + play */
  lastPlayedKey = '';
  const hint =
    code === 4
      ? '（code=4：多为格式/解码或错误的跨域策略；已去掉 crossOrigin，请硬刷新后再试）'
      : '（多为网络或跨域限制）';
  metaEl.textContent += `\n<audio> 加载失败 code=${code ?? '?'}${hint}`;
  setForcePlayVisible(true);
});
