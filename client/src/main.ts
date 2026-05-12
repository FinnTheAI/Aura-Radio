import { mountAuraScene } from './visual';

interface NowPlaying {
  type: 'music' | 'voice' | 'idle';
  title?: string;
  artist?: string;
  moodTag?: string;
  traceId?: string;
  url?: string;
  proxiedUrl?: string;
  djText?: string;
  sayText?: string;
  ncmSongId?: string;
  durationMs?: number;
}

type PlaybackMode = 'online' | 'offline';

const metaEl = document.querySelector('#meta') as HTMLElement;
const bootBtn = document.querySelector('#boot') as HTMLButtonElement;
const nextTrackBtn = document.querySelector('#next-track') as HTMLButtonElement;
const forcePlayBtn = document.querySelector('#force-play') as HTMLButtonElement;
const sceneEl = document.querySelector('#scene') as HTMLElement;
const audioEl = document.querySelector('#player') as HTMLAudioElement;
const chatInput = document.querySelector('#chat-input') as HTMLInputElement;
const chatSendBtn = document.querySelector('#chat-send') as HTMLButtonElement;
const pipelineStatusEl = document.querySelector('#pipeline-status') as HTMLElement;
const djAnnounceEl = document.querySelector('#dj-announce') as HTMLElement;
const modeStatusEl = document.querySelector('#mode-status') as HTMLElement;
const modeToggleBtn = document.querySelector('#mode-toggle') as HTMLButtonElement;
const favoriteBtn = document.querySelector('#favorite-btn') as HTMLButtonElement;
const chatToggleBtn = document.querySelector('#chat-toggle') as HTMLButtonElement;
const chatPanelEl = document.querySelector('#chat-panel') as HTMLElement;
const bootLabelEl = document.querySelector('.boot-label') as HTMLElement;

function setBootLabel(text: string) {
  bootLabelEl.textContent = text;
  bootBtn.setAttribute('aria-label', text);
  bootBtn.title = text;
}

function setFavoriteChrome(label: string) {
  favoriteBtn.title = label;
  favoriteBtn.setAttribute('aria-label', label);
}

function syncChatSendGlow() {
  chatSendBtn.classList.toggle('chat-send-active', chatInput.value.trim().length > 0);
}

async function applyRandomStageBackground() {
  const el = document.getElementById('bg-layer');
  if (!el) return;
  try {
    const res = await fetch('/api/background/random');
    if (!res.ok) return;
    const data = (await res.json()) as { url?: string };
    if (data.url) el.style.backgroundImage = `url("${data.url}")`;
  } catch {
    /** 无目录或无图时保持纯色底 */
  }
}

interface ChatDjScript {
  schemaVersion?: number;
  say?: string;
  moodTag?: string;
  play?: unknown[];
  segue?: string;
}

/** 联网「下一首」：replaceQueue + Brain；say 为导语，须与所选新歌气质一致 */
const ONLINE_NEXT_TRACK_PROMPT =
  '下一首：先选定一首与电台氛围相称的新歌，写两三句诗意导语作为对它的介绍与引子（要与所选歌曲气质一致），然后给出这首歌（勿重复上一首）。';

const PIPELINE_BUSY_HINT = '暂时禁用：缓冲或等待开播完成后可再切歌 / 发送';
const PIPELINE_SAFETY_TIMEOUT_MS = 180_000;

let suppressWsNowPlaying = 0;
let pipelineAwaitingMusic = false;
let pipelineExpectedTraceId: string | undefined;
let pipelineSafetyTimer: ReturnType<typeof setTimeout> | undefined;
let playbackMode: PlaybackMode = 'online';

const SILENT_WAV =
  'data:audio/wav;base64,UklGRiIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';

const ENABLE_MEDIA_ELEMENT_ANALYSER = true;

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let freqBin = new Uint8Array(0);
let webAudioGraphOk = false;
let mediaElementSourceTapped = false;
let ambientOnly = false;
let lastPlayedKey = '';
let synthPhase = 0;
let userAllowedPlayback = false;
let lastReportedAudioError: number | null = null;
let didSilentGesturePrime = false;
let currentNcmSongId: string | undefined;

const preloadEl = document.createElement('audio');
preloadEl.id = 'preload-audio';
preloadEl.style.display = 'none';
document.body.appendChild(preloadEl);

let preloadInfo: { item: unknown; absUrl: string } | undefined;
let queueMusicScanStartIndex = 0;

/* ========== 流水线状态 ========== */

function setPipelineStatus(text: string) {
  pipelineStatusEl.textContent = text;
  pipelineStatusEl.hidden = !text;
}

function setButtonsBusy(busy: boolean) {
  nextTrackBtn.disabled = busy;
  chatSendBtn.disabled = busy;
  chatToggleBtn.disabled = busy;
  if (busy) {
    nextTrackBtn.title = PIPELINE_BUSY_HINT;
    chatSendBtn.title = PIPELINE_BUSY_HINT;
    chatToggleBtn.title = PIPELINE_BUSY_HINT;
  } else {
    nextTrackBtn.title = '下一首';
    chatSendBtn.title = '发送';
    chatToggleBtn.title = '对话';
  }
}

function beginDjPipeline(firstStage: string) {
  pipelineAwaitingMusic = true;
  pipelineExpectedTraceId = undefined;
  clearPipelineSafetyTimer();
  setButtonsBusy(true);
  setPipelineStatus(firstStage);
  pipelineSafetyTimer = setTimeout(() => {
    if (pipelineAwaitingMusic) {
      abortDjPipelineOnError();
      metaEl.textContent += '\n缓冲超时，请重试。';
    }
  }, PIPELINE_SAFETY_TIMEOUT_MS);
}

function noteDjPipelineStage(stage: string) {
  if (pipelineAwaitingMusic) setPipelineStatus(stage);
}

function abortDjPipelineOnError() {
  pipelineAwaitingMusic = false;
  pipelineExpectedTraceId = undefined;
  clearPipelineSafetyTimer();
  setButtonsBusy(false);
  setPipelineStatus('');
}

function clearPipelineSafetyTimer() {
  if (pipelineSafetyTimer) {
    clearTimeout(pipelineSafetyTimer);
    pipelineSafetyTimer = undefined;
  }
}

function armPipelineExpectedTrace(traceId: string | undefined) {
  pipelineExpectedTraceId = traceId;
}

function tryNotifyPipelineOurSegmentPlaying(np: NowPlaying): void {
  if (!pipelineAwaitingMusic) return;
  /** 文案在 music.djText；voice 轨在 hydrate 开头已 skip，不会走到此处 */
  if (np.type !== 'music') return;
  if (pipelineExpectedTraceId && np.traceId !== pipelineExpectedTraceId) return;
  pipelineAwaitingMusic = false;
  pipelineExpectedTraceId = undefined;
  clearPipelineSafetyTimer();
  setButtonsBusy(false);
  setPipelineStatus('');
}

function finishPipelineIfHeadIsNotOurRequest(requestTraceId: string | undefined, np: NowPlaying | undefined) {
  if (!pipelineAwaitingMusic || !requestTraceId) return;
  if (!np || np.type === 'idle' || !np.traceId || np.traceId === requestTraceId) return;
  pipelineAwaitingMusic = false;
  pipelineExpectedTraceId = undefined;
  clearPipelineSafetyTimer();
  setButtonsBusy(false);
  setPipelineStatus('');
  metaEl.textContent += '\n新对话已排队，当前曲目结束后会自动接上新的 DJ 文案与新歌。';
}

/* ========== 播放模式 ========== */

async function refreshPlaybackMode() {
  try {
    const res = await fetch('/api/playback-mode');
    if (res.ok) {
      const data = (await res.json()) as { mode: PlaybackMode };
      playbackMode = data.mode ?? 'online';
    }
  } catch { /* */ }
  modeStatusEl.textContent = `播放模式：${playbackMode === 'offline' ? '离线' : '联网'}`;
}

/* ========== DJ 文字播报 ========== */

function updateDjAnnouncePanel(text: string | undefined): void {
  const t = text?.trim();
  if (!t) {
    djAnnounceEl.hidden = true;
    djAnnounceEl.textContent = '';
    return;
  }
  djAnnounceEl.textContent = t;
  djAnnounceEl.hidden = false;
}

/** 服务端 discovery 解析兜底时在页面底部 meta 区追加说明 */
function appendPlaybackHints(hints: string[] | undefined): void {
  if (!hints?.length) return;
  metaEl.textContent += `\n\n${hints.join('\n')}`;
}

/* ========== 音频工具 ========== */

function normalizeUrl(u?: string) {
  if (!u) return '';
  try {
    if (u.startsWith('http://') || u.startsWith('https://')) return u;
    return new URL(u, window.location.href).href;
  } catch {
    return '';
  }
}

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

/* ========== Hydrate ========== */

async function hydrateFromNow(np: NowPlaying) {
  queueMusicScanStartIndex = np.type === 'idle' ? 0 : 1;

  delete audioEl.dataset.auraTrace;
  delete audioEl.dataset.auraKind;

  if (np.type === 'idle') {
    updateDjAnnouncePanel(undefined);
    resetAudioElement();
    metaEl.textContent = 'idle · 队列暂无曲目';
    setForcePlayVisible(false);
    favoriteBtn.hidden = true;
    currentNcmSongId = undefined;
    if (pipelineAwaitingMusic) abortDjPipelineOnError();
    return;
  }

  /** 产品路径：口播仅为大字 djText，不应再播放 TTS voice 轨（否则会卡在「正在缓冲音频」） */
  if (np.type === 'voice') {
    noteDjPipelineStage('正在跳过口播轨…');
    try {
      const res = await fetch('/api/queue/skip', { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      await pullNowAndPlay();
    } catch (e) {
      abortDjPipelineOnError();
      metaEl.textContent += `\n跳过口播失败：${String(e)}`;
    }
    return;
  }

  const djCopy = np.djText?.trim() || np.sayText?.trim();
  if (djCopy) updateDjAnnouncePanel(djCopy);
  else updateDjAnnouncePanel(undefined);

  const playRaw = np.proxiedUrl ?? np.url;
  const key = `${np.traceId}:${np.title}:${normalizeUrl(playRaw)}`;
  if (!playRaw) {
    metaEl.textContent =
      `${np.type} · ${np.moodTag ?? ''}` + (np.title ? ` · ${np.title}` : '') + '\n暂无可播放音频 URL。';
    setForcePlayVisible(false);
    if (pipelineAwaitingMusic) abortDjPipelineOnError();
    return;
  }

  metaEl.textContent =
    `${np.type} · ${np.moodTag ?? ''}${np.title ? ` · ${np.title}` : ''}${np.artist ? ` — ${np.artist}` : ''}` +
    (np.ncmSongId ? ` · ncm:${np.ncmSongId}` : '') +
    `\ntrace:${np.traceId ?? '—'}`;
  if (np.type === 'music') {
    tryNotifyPipelineOurSegmentPlaying(np);
  }

  audioEl.dataset.auraKind = np.type;
  if (np.traceId) audioEl.dataset.auraTrace = np.traceId;

  // 收藏按钮：仅在播放 music 且有有效 ncmSongId 时显示
  if (np.type === 'music' && np.ncmSongId && /^\d+$/.test(np.ncmSongId)) {
    currentNcmSongId = np.ncmSongId;
    favoriteBtn.hidden = false;
    favoriteBtn.disabled = false;
    setFavoriteChrome(`收藏 · ${np.title ?? np.ncmSongId}`);
  } else {
    currentNcmSongId = undefined;
    favoriteBtn.hidden = true;
    favoriteBtn.disabled = false;
  }

  const absUrl = normalizeUrl(playRaw);
  const sameKey = key === lastPlayedKey;
  const stuckOnSilentPrime = audioEl.src.startsWith('data:');
  if (sameKey && !stuckOnSilentPrime && !audioEl.error) {
    if (audioEl.ended) {
      try { audioEl.currentTime = 0; } catch { /* */ }
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
  audioEl.volume = 0.92;
  audioEl.muted = false;
  try {
    await audioEl.play();
    setForcePlayVisible(false);
  } catch (e) {
    metaEl.textContent += '\n浏览器拦截了自动播放：请点「点此出声」。';
    setForcePlayVisible(true);
    console.warn('[aura] audio.play() rejected', e);
  }

  if (preloadInfo && preloadInfo.absUrl !== absUrl) {
    preloadInfo = undefined;
  }
}

/* ========== 串行 Hydrate 队列 ========== */

let hydrateQueue: Array<() => Promise<void>> = [];
let hydrating = false;

async function enqueueHydrateFromNow(np: NowPlaying): Promise<void> {
  return new Promise((resolve) => {
    hydrateQueue.push(async () => {
      try { await hydrateFromNow(np); } catch { /* */ }
      resolve();
    });
    if (!hydrating) drainHydrateQueue();
  });
}

async function drainHydrateQueue() {
  hydrating = true;
  while (hydrateQueue.length) {
    const fn = hydrateQueue.shift()!;
    try { await fn(); } catch { /* */ }
  }
  hydrating = false;
}

/* ========== API ========== */

async function pullNowAndPlay(): Promise<NowPlaying | undefined> {
  const res = await fetch('/api/now');
  if (!res.ok) return;
  const np = (await res.json()) as NowPlaying;
  await enqueueHydrateFromNow(np);
  return np;
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

function runSilentGesturePrimeOnce() {
  if (!didSilentGesturePrime) {
    didSilentGesturePrime = true;
    try {
      delete audioEl.dataset.auraTrace;
      delete audioEl.dataset.auraKind;
      audioEl.muted = true;
      audioEl.src = SILENT_WAV;
      void audioEl.play();
    } catch { /* */ }
  }
}

async function postDjChat(
  text: string,
  replaceQueue: boolean,
): Promise<{ traceId: string; djScript?: ChatDjScript; playbackHints?: string[] }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone },
    body: JSON.stringify({ text, replaceQueue }),
  });
  const body = (await res.json()) as {
    error?: string;
    traceId?: string;
    djScript?: ChatDjScript;
    playbackHints?: string[];
  };
  if (!res.ok) throw new Error(body.error ?? String(res.status));
  return { traceId: body.traceId as string, djScript: body.djScript, playbackHints: body.playbackHints };
}

function hasRenderableAudioSrc(): boolean {
  const s = audioEl.currentSrc || audioEl.src || '';
  return Boolean(s) && !s.startsWith('data:');
}

async function djSpeechThenPullNow(
  traceId: string | undefined,
  _djScript: ChatDjScript | undefined,
) {
  suppressWsNowPlaying++;
  try {
    const np = await pullNowAndPlay();
    finishPipelineIfHeadIsNotOurRequest(traceId, np);
  } finally {
    suppressWsNowPlaying--;
  }
}

/* ========== 事件绑定 ========== */

bootBtn.addEventListener('click', async () => {
  userAllowedPlayback = true;

  if (hasRenderableAudioSrc() && !audioEl.paused && !audioEl.ended) {
    audioEl.pause();
    setBootLabel('已暂停 — 点此继续播放');
    return;
  }

  if (hasRenderableAudioSrc() && audioEl.paused && !audioEl.ended) {
    try {
      audioEl.muted = false;
      await audioEl.play();
      setBootLabel('已唤醒 — 悬停此处可显示指令');
    } catch (e) {
      metaEl.textContent += `\n继续播放失败：${String(e)}`;
      setForcePlayVisible(true);
    }
    return;
  }

  runSilentGesturePrimeOnce();
  await resumeAudioContextIfAny();
  setBootLabel('已唤醒 — 悬停此处可显示指令');
  try {
    beginDjPipeline('正在请求 DJ…');
    const body = await postDjChat('初次见面，帮我开始一段轻柔的电台。', true);
    appendPlaybackHints(body.playbackHints);
    noteDjPipelineStage('正在生成 DJ 文案与选曲…');
    armPipelineExpectedTrace(body.traceId);
    lastPlayedKey = '';
    await djSpeechThenPullNow(body.traceId, body.djScript);
    if (pipelineAwaitingMusic) noteDjPipelineStage('正在缓冲音频…');
    window.setTimeout(() => {
      if (audioEl.paused && audioEl.src && !audioEl.ended) {
        setForcePlayVisible(true);
        metaEl.textContent += '\n若仍无声，请点「点此出声」。';
      }
    }, 400);
  } catch (e) {
    abortDjPipelineOnError();
    metaEl.textContent = `首包失败（请确认后端在 8080 运行）：${String(e)}`;
  }
});

nextTrackBtn.addEventListener('click', async () => {
  userAllowedPlayback = true;
  runSilentGesturePrimeOnce();
  await resumeAudioContextIfAny();
  await refreshPlaybackMode();
  try {
    if (playbackMode === 'offline') {
      beginDjPipeline('正在切换离线下一首…');
      const res = await fetch('/api/playback/next-offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json()) as { error?: string; traceId?: string; djScript?: ChatDjScript };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      noteDjPipelineStage('正在加载本地曲目…');
      armPipelineExpectedTrace(body.traceId);
      lastPlayedKey = '';
      await djSpeechThenPullNow(body.traceId, body.djScript);
      if (pipelineAwaitingMusic) noteDjPipelineStage('正在缓冲音频…');
      metaEl.textContent += '\n已切换到离线列表下一首。';
      return;
    }

    beginDjPipeline('正在请求 DJ…');
    const body = await postDjChat(ONLINE_NEXT_TRACK_PROMPT, true);
    appendPlaybackHints(body.playbackHints);
    noteDjPipelineStage('正在生成 DJ 文案与选曲…');
    armPipelineExpectedTrace(body.traceId);
    lastPlayedKey = '';
    await djSpeechThenPullNow(body.traceId, body.djScript);
    if (pipelineAwaitingMusic) noteDjPipelineStage('正在缓冲音频…');
    metaEl.textContent += '\n下一首：已开始播放新片段。';
  } catch (e) {
    abortDjPipelineOnError();
    metaEl.textContent += `\n下一首失败：${String(e)}`;
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
  runSilentGesturePrimeOnce();
  await resumeAudioContextIfAny();
  try {
    beginDjPipeline('正在请求 DJ…');
    /** replaceQueue：立即重置队列并按本条对话选曲（否则会排到当前曲之后，易被误判为「聊天无效」） */
    const body = await postDjChat(text, true);
    appendPlaybackHints(body.playbackHints);
    noteDjPipelineStage('正在生成 DJ 文案与选曲…');
    armPipelineExpectedTrace(body.traceId);
    await djSpeechThenPullNow(body.traceId, body.djScript);
    if (pipelineAwaitingMusic) noteDjPipelineStage('正在缓冲音频…');
  } catch (e) {
    abortDjPipelineOnError();
    metaEl.textContent = `发送失败：${String(e)}`;
  }
});

chatInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') chatSendBtn.click();
});
chatInput.addEventListener('input', syncChatSendGlow);

chatToggleBtn.addEventListener('click', () => {
  const opening = chatPanelEl.hidden;
  chatPanelEl.hidden = !opening;
  chatToggleBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  if (opening) {
    chatInput.focus();
    syncChatSendGlow();
  }
});

/* ========== 收藏到离线 ========== */

favoriteBtn.addEventListener('click', async () => {
  const id = currentNcmSongId;
  if (!id) return;
  favoriteBtn.disabled = true;
  setFavoriteChrome('收藏中…');
  try {
    const res = await fetch('/api/favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ncmSongId: id }),
    });
    const data = (await res.json()) as { ok?: boolean; message?: string; status?: string };
    if (res.ok && data.ok) {
      metaEl.textContent += `\n${data.message ?? '已收藏'}`;
      setFavoriteChrome(`已收藏 · ${data.status === 'downloaded' ? '可离线播放' : '下载中'}`);
    } else {
      metaEl.textContent += `\n收藏失败：${(data as { error?: string }).error ?? '未知错误'}`;
      setFavoriteChrome('收藏');
    }
  } catch (e) {
    metaEl.textContent += `\n收藏失败：${String(e)}`;
    setFavoriteChrome('收藏');
  } finally {
    favoriteBtn.disabled = false;
  }
});

/* ========== 播放模式切换 ========== */

modeToggleBtn.addEventListener('click', async () => {
  const next: PlaybackMode = playbackMode === 'online' ? 'offline' : 'online';
  const label = next === 'offline' ? '离线' : '联网';
  if (!confirm(`确认切换到「${label}」模式？`)) return;
  try {
    const res = await fetch('/api/playback-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next, confirm: true }),
    });
    if (res.ok) {
      playbackMode = next;
      modeStatusEl.textContent = `播放模式：${label}`;
      metaEl.textContent += `\n已切换至${label}模式（已清空播放队列，请点「下一首」或发送对话开始）。`;
      lastPlayedKey = '';
      userAllowedPlayback = true;
      await pullNowAndPlay();
    }
  } catch {
    metaEl.textContent += '\n模式切换失败。';
  }
});

/* ========== 键盘事件 ========== */

// 已移除全局 Space → skip（与聊天输入冲突）；切歌通过 UI 按钮

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'KeyB') {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    const editable =
      tag === 'input' || tag === 'textarea' || tag === 'select' ||
      (document.activeElement as HTMLElement)?.isContentEditable;
    if (!editable) {
      ambientOnly = !ambientOnly;
      metaEl.textContent =
        (metaEl.textContent ?? '') + `\n环境呼吸 ${ambientOnly ? '开' : '关'}（按 B 切换）`;
    }
  }
});

/* ========== WebSocket ========== */

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/stream`);

ws.addEventListener('message', async (ev) => {
  if (!userAllowedPlayback) return;
  try {
    const msg = JSON.parse(String(ev.data)) as {
      type?: string; payload?: unknown; items?: unknown[];
      ncmSongId?: string; title?: string; artist?: string; status?: string;
    };

    if (msg.type === 'offline_favorite_ready') {
      metaEl.textContent += `\n离线收藏就绪：${msg.title ?? msg.ncmSongId} — ${msg.artist ?? ''}`;
      return;
    }

    if (msg.type === 'now_playing' && msg.payload) {
      const npRaw = msg.payload as NowPlaying;
      if (suppressWsNowPlaying > 0) return;
      if (!npRaw || !npRaw.type) return;
      const np = npRaw;

      await enqueueHydrateFromNow(np);
    } else if (msg.type === 'queue' && Array.isArray(msg.items)) {
      const next = findNextMusicItem(msg.items, queueMusicScanStartIndex);
      preloadTrack(next?.absUrl);
    } else if (msg.type === 'error') {
      const errMsg = (msg as { message?: string }).message;
      metaEl.textContent += `\n服务端错误：${errMsg ?? '未知'}`;
    }
  } catch { /* */ }
});

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'ping', schemaVersion: 1 }));
});

/* ========== 初始化 ========== */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

void refreshPlaybackMode();
void applyRandomStageBackground();
syncChatSendGlow();

audioEl.addEventListener('ended', () => {
  const traceId = audioEl.dataset.auraTrace;
  const kind = audioEl.dataset.auraKind;
  if (kind !== 'music' && kind !== 'voice') return;

  void (async () => {
    try {
      const res = await fetch('/api/queue/advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(traceId ? { traceId } : {}),
      });
      if (res.ok) await pullNowAndPlay();
    } catch {
      /** */
    }
  })();
});

audioEl.addEventListener('error', () => {
  const err = audioEl.error;
  const code = err?.code ?? null;
  if (code !== null && code === lastReportedAudioError) return;
  lastReportedAudioError = code;
  lastPlayedKey = '';
  if (pipelineAwaitingMusic) abortDjPipelineOnError();
  const hint =
    code === 4
      ? '（code=4：多为格式/解码或错误的跨域策略；已去掉 crossOrigin，请硬刷新后再试）'
      : '（多为网络或跨域限制）';
  metaEl.textContent += `\n<audio> 加载失败 code=${code ?? '?'}${hint} · 尝试跳过当前条目`;
  setForcePlayVisible(true);

  const traceId = audioEl.dataset.auraTrace;
  const kind = audioEl.dataset.auraKind;
  if (traceId && (kind === 'music' || kind === 'voice')) {
    void (async () => {
      try {
        const res = await fetch('/api/queue/advance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ traceId }),
        });
        if (res.ok) await pullNowAndPlay();
      } catch {
        /** */
      }
    })();
  }
});
