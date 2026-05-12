# Aura Radio 进展与交接简报

> 用途：给「统领」同步当前阶段成果；给**重开终端后的 Claude / 协作者**快速恢复上下文。  
> 最后更新：2026-05-07（由 Cursor 侧根据终端摘要与代码库状态整理）

---

## 一、近期已确认进展（终端 / 联调侧）

### 1. 品味数据入口

- **问题**：`buildCloudTaste()` 曾主要依赖 SQLite `cloud_favorites` / `cloud_history`，在表为空时无法利用已存在的 **`data/user/taste-cloud.md`**（大量收藏画像摘要）。
- **处理**：增加 **`readTasteCloudMd()`**，在文件含「收藏总条目」或「网易云听歌画像」等标记时**优先整文件注入**；无文件时再回退数据库聚合。
- **注意**：全文注入会显著增大 Brain prompt 体积，易拉长单次 `/api/chat` 耗时，后续可考虑**摘要策略**（未做）。

### 2. 选曲策略文案（prompt 内）

- **旧**：偏「Top 艺人 + 约 20% 冷门」。
- **新**：强调**冷门佳作约 70%**、少依赖高收藏量、突出风格/氛围/情绪等隐性偏好（见 `server/src/context-builder.ts` 中 `buildCloudTaste` 兜底段）。

### 3. Claude CLI 与 Windows 限制

- **问题**：完整 prompt 用命令行 `-p "..."` 传递时可能触发 **`spawn ENAMETOOLONG`**（Windows 命令行长度限制），导致回落 Mock。
- **处理**：改为通过 **stdin** 向 `claude --print` 喂入整段 prompt，避免超长参数；并视环境调整 `--output-format json`（避免包装对象导致解析失败）。

### 4. 联调结果（曾报告）

- `POST /api/chat` 可返回 **HTTP 200**，非仅 Mock；`say` 与多首 `play`、`moodTag` 等结构可正常出现。
- 口味叙述可与「后摇、电子、华语独立」等画像对齐（依赖当时 prompt 与 NCM 解析链是否健康）。

---

## 二、Cursor / 本仓库相关实现要点（便于定位代码）

| 主题 | 主要路径 |
|------|----------|
| Brain、Claude 调用、DjScript 解析 | `server/src/brain.ts` |
| 用户语料 + 云端口味 + `taste-cloud.md` | `server/src/context-builder.ts` |
| 网易 API 代理、播放 URL | `server/src/ncma.js`、`config` 中 `NCM_API_BASE_URL` |
| discovery → 真实 `ncmSongId` | `server/src/song-candidates.ts`（`resolvePlayFromDiscovery`） |
| 播放队列、文案下发 | `server/src/queue-engine.ts` |
| 前端播放、WS、`queue` 预加载下一首音乐 | `client/src/main.ts`（含 `queueMusicScanStartIndex` 跳过队头当前项） |

---

## 三、A / B / C 板块交接：当前问题与风险（需继续打磨）

以下为**跨模块**现状，供排期与架构讨论用。

### A 板块：网易云与曲库（NCM API、解析、曲池）

- **依赖本地或远程 NCM Enhanced API**（默认 `http://127.0.0.1:3000`）：未启动则搜索/URL 失败，直接影响 `play` 落地。
- **Cookie / 同步**：`cloud_*` 表若长期为空，与「手写的 `taste-cloud.md` / `taste.md`」并存时，**语义易混淆**（API 里 `playlistStats` 与 DB 行数不是同一概念）。
- **选曲质量**：最终播什么仍强依赖 **Brain 写的 `discoveryNote` + NCM 搜索结果**，不是单一「画像文件」能完全锁定。

### B 板块：Claude Brain（推理、mmx、JSON）

- **延迟大**：Claude CLI +（可选）mmx-cli + NCM resolve，单轮常 **几十秒～两分钟级**，易触发客户端/ curl 超时。
- **稳定性**：Mock 回退可能由 **解析失败、CLI 退出码、环境变量、prompt 过长、Windows 特有问题** 等引起，需结合日志逐项排除。
- **记忆**：**每次新开终端 / 新会话，Claude Code 无持久「项目内记忆」**；业务侧若需连续对话，应依赖 **`data/state.db` 消息表、`messages`、以及本文件 + WORKLOG** 人工延续。

### C 板块：前端（播放、WS、体验）

- **交互**：单 `<audio>` 切源仍有感知间隙；虽已对 **`queue` 做下一首 `music` 预加载**，间隙文字显示期间的衔接、**suppressWsNowPlaying** 期间不更新预加载等，仍可能导致「听感不同步」。
- **文案与歌曲不同步**：队列顺序为 **间隙文案 → 音乐**，若客户端仍按旧逻辑「先拉一次 now」或 WS 乱序，会出现**文案未结束就切歌**或**元数据/文案与当前条不一致**。
- **延迟**：首包 `/api/chat` 慢 ≠ 播放侧一定慢，但用户体感上常混为一谈，需 **前端超时与 loading 状态** 产品化。

---

## 四、建议的后续打磨方向（摘要）

1. **画像注入**：对 `taste-cloud.md` 可做结构化摘要以省 token；**当前默认整文件注入**（`TASTE_CLOUD_MAX_CHARS` 未设置即完整读入，见 `context-builder.ts:readTasteCloudMd()`）。需要限长时可设 `TASTE_CLOUD_MAX_CHARS=1500` 等。
2. **B 链可靠性与可观测性**：Brain 失败原因结构化落日志；明确 Mock 触发条件。
3. **C 链播放**：统一以 **WS `now_playing` + `queue`** 为真源；评估文案间隙是否仍允许预加载「下一首音乐」；必要时双缓冲或淡入淡出。（**已落地**：间隙文案期间允许 queue 预加载下一首音乐；ws suppress 动态控制 + 500ms 保险）
4. **端到端 SLA**：区分「聊天生成慢」与「切歌缓冲慢」，分别优化。

### 近期已落地（2026-05-11）

| 功能 | 路径 | 说明 |
|------|------|------|
| 文案间隙 queue 预加载 | `client/src/main.ts` WS handler | 间隙文案期间 now_playing suppress，但 queue 仍可预加载下一首 music |
| ws suppress 动态控制 | `client/src/main.ts:suppressWsForDuration()` | 根据 durationMs 动态 suppress，避免硬编码时长 |
| taste-cloud.md 注入 | `server/src/context-builder.ts:readTasteCloudMd()` | 默认完整；`TASTE_CLOUD_MAX_CHARS` 设正整数则截断；`0`=不注入该文件 |
| 离线下载状态 | `server/src/favorites.ts` | `POST /api/favorite` → 异步下载 → `GET /api/local-audio/:songId.mp3` 同源直出 |
| 文案降级 | `server/src/queue-engine.ts` | Brain 失败时用默认文案占位 |
| mmx Web Search 节流 | `brain.ts`、`mmx-cli-gate.ts`、`next-track-segment.ts` | 单次 Brain 至多 1x `mmx-cli search`（gate 硬性）；`DjScript.play` 固定 1 首；单曲 natural 播完且队列空时自动再走一轮 Brain（`NEXT_TRACK_DISCOVERY_COOLDOWN_MS`/`MMX_MAX_SEARCH_PER_INVOCATION` 可调）|

---

## 五、给「下次重开终端的 Claude」的三句话

1. 先读本文件 + 根目录 `WORKLOG.md`（若存在有效条目）。  
2. 确认 **NCM(3000) + server(8080)** 与前端 dev 端口；`.env` 中 `NCM_API_BASE_URL`、`BRAIN_MOCK`、`BRAIN_FORCE_HTTP` 含义见 `server/src/config.ts`。  
3. 当前最大产品痛点是 **A/B/C 数据链与听感同步**，不是单点 bug；改动前先 **复现路径**（唤醒 → chat → 队列 → 浏览器 Network / WS）。

---

## 附：终端侧原始工作摘要（便于对照，勿当唯一事实源）

```
今日工作总结（摘录）

修复的问题
1. 品味数据读取路径错误 — readTasteCloudMd() 优先 taste-cloud.md
2. 选曲策略更新 — 冷门约 70%，弱化唯 Top 艺人
3. Claude CLI ENAMETOOLONG — stdin 传 prompt；曾尝试调整 allowedTools 等
4. --output-format json — 去掉包装解析问题

验证结果（曾报告）
POST /api/chat → HTTP 200，多首 play，口味与「后摇、电子、华语独立」等对齐改善。
```

若与当前代码或本机环境不一致，**以仓库 `git diff` 与实际 curl 为准**。
