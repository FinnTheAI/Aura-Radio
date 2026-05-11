# Aura Radio — 前端版记（Agent C）

面向「前端体验与并行分支不回退」的契约摘要；后端细节以实现为准（可对照 `server/src/favorites.ts`、`server/src/express-app.ts`）。

---

## 2026-05 — 与 A（网易云 / 离线收藏）对齐

### 离线收藏 · HTTP

| 能力 | 说明 |
|------|------|
| **`GET /api/now`** | 当前为 **`music`** 时携带 **`ncmSongId`**（供收藏按钮等使用）。 |
| **`POST /api/favorite`** | Body：`{"ncmSongId":"<纯数字网易云单曲 id>"}`。成功时 JSON：`ok`、`ncmSongId`、`queuedDownload`（是否本次触发排队下载）、`status`（如 `pending` / `downloaded` / `failed`）、`message`（人类可读说明）。非法 id：`400`，`ok: false`，`error`。 |
| **`GET /api/local-audio/:songId.mp3`** | 同源直出已下载 MP3；队列/broadcast 下发的 **`url`** / **`proxiedUrl`** 规则由服务端决定，播放器仍按 WS + hydrate 更新 **`src`**。 |

### WebSocket（`/stream`）

- **`now_playing`**：在 **`suppressWsDuringDjPull > 0`**（`/api/chat` 后首轮拉态窗口）时跳过 hydrate，减轻 HTTP 与 WS 双写。
- **`now_playing`**：`blockMusicWsWhileVoiceHydrated` 为真时跳过 **`music`**，避免 voice 口播期间被插队；**空格切歌**时会 **`clearVoiceMusicWsBlock()`**，避免永久卡住下一首。
- **`queue`**：**始终处理**，用于预加载下一首 music（voice 期间也不断预加载）。

**改版播放器时请勿假设**：suppress 期间「完全没有 WS」——**`queue` 仍会到**，须保留 `preloadTrack` 逻辑。

### 空格切歌 · `/api/queue/skip · idle · AbortError`（与 A 对齐）

| 现象 | 说明 |
|------|------|
| **`idle · … 暂无可播放音频 URL`** | 服务端 `skip()` 清空当前项后若 **pending 为空**，`getNow()` 即为无 URL 的 idle；**非纯粹前端 bug**。前端已：**skip 后 `pullNowAndPlay()`** 同步态；若 **`newHead == null`** 追加一行提示「暂无下一首」。若产品要求「空格必有下一曲」，需 **服务端** 在空队列时补 enqueue（超出当前前端竞态修复范围）。 |
| **`AbortError: play() interrupted by pause()`** | 单 `<audio>` 上 **`resetAudioElement()`（pause+load）** 与 **`play()`** 并发或紧挨着重入时 Chrome 常见。缓解：**`enqueueHydrateFromNow` 串行**、换 src 前 **短延迟 + AbortError 一次重试**；**`forcePlayBtn` 不再二次 `play()`**（避免与 hydrate 内 `play()` 打架）。 |
| **「换一段」又像重头播 Voice** | `replaceQueue: true` 后队列头 **voice 优先**属产品设计；若体感重复，对照 **新 `traceId` / `djScript`** 区分后端重复 vs **`lastPlayedKey` / sameKey** 短路。 |

### 口播与音频

- **服务端 voice 轨**：口播为 **TTS MP3** 进队；`speakDjScriptSay` 当前为 **no-op**（避免与系统语音重复）。**`sayText`** 为 TTS 失败时的文案降级展示。
- **外链 / 离线 URL**：外链可走同源 **`/api/audio/proxy`** + **`proxiedUrl`**；离线下 **`/api/local-audio/...`**。

### C 端体验 · 仍可增强（收藏）

- **Toast / 按钮态**：收藏接口 **`queuedDownload` / `status` / `message`** 细粒度区分（已入队 / 已在库 / 失败重试）。
- **未暴露 API**：离线列表、批量同步、下载进度等需 **A/B** 补路由后再做 UI。

### 文件分工（前端 Agent）

| 可改 | 勿动（除非另开任务） |
|------|----------------------|
| **`client/src/main.ts`** | **`server/**`**、`client/public/sw.js`（慎重） |
| **`client/index.html`**、`style.css` | 「空格必有下一首」属 **服务端** 队列策略 |

### 自检清单

1. 空格 → **`skip`** 是否 200？**`newHead`** 是否 **`null`**？  
2. AbortError 是否伴随 **双重 `play()`** 或 **交错 hydrate**？  
3. 「换一段」**`traceId`** / **`djScript`** 是否更新？

### 接口扩展联络

新增只读聚合（例如离线曲库列表）：先在仓库对齐 **`server/src/favorites.ts`** + **`express-app.ts`**，再在 PR/分支点名 **A 或 B** 扩容。
