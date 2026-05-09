# Aura Radio — 架构与设计规格书（ARCH_DOC）

**文档性质**：本项目在「Claudio 施工图」四层结构上迭代的规范性描述（SPEC），并附带可并行拆分的 Agent 执行计划（PLAN）。

**版本**：0.2-baseline

**状态**：已与机器可读契约 [`CONTRACT.yaml`](./CONTRACT.yaml) 对齐，可作为实现与评审基准。

---

## 0. 与设计图像的对齐关系（逻辑底座映射）

施工图将系统分为：**外部上下文 → 本地大脑 → 运行时聚合 → 交互表层**。Aura Radio **保留分层与职责边界**，在技术选型上替换为：

| 施工图要素 | Aura Radio 对应 |
|------------|----------------|
| BRAIN（Claude Code 架构） | **Claude Code 分层架构**：意图分流 → Context Builder → 大脑适配器（Executor 通过适配器调用 **MiniMax** 等底层模型）；输出 JSON 结构化脚本 |
| MUSIC（网易云 API） | **NeteaseCloudMusicApi**：搜索、playable URL、歌词、推荐等 |
| VOICE / 播报 | MiniMax 生成 DJ 脚本（say 字段）+ 客户端 TTS（或后续接入其他语音合成） |
| 前端 PWA + 流媒体 | **Client**：宿主页 + `<audio>` 播放队列 + **Three.js / GLSL** 频谱驱动的粒子场景 |
| 本地状态与记忆 | **Server**：**SQLite** 持久化（`STATE_DB_PATH` 或 `$DATA_DIR/state.db`），可迁移 Postgres；与用户品味、播放史、调度痕迹 |

---

## 1. 设计总则

1. **思考外包**：自然语言理解与 DJ 话术生成由 MiniMax 完成；规则化调度可由代码确定性执行，仅在歧义处回退到模型。
2. **理解留人**：长期偏好、情绪定义、日程规则以**可读文件或显式数据结构**存放，可追溯、可版本化。
3. **单源播放**：同一时间轴上仅一个「当前音频」源流（音乐或 MiniMax 语音），Client 负责淡入淡出与可视化采样。
4. **视觉从属于音频**：粒子与 Shader 由 **AnalyserNode 频谱/能量序列**驱动；极简建筑空间、氛围感空间图像（低饱和、光影序列、几何逻辑）为容器，不参与业务决策。
5. **留白与呼吸（播报克制）**：AI DJ 不应在每首歌之间强制播报，需具备「留白」机制。当处于深度专注（例如 **Focus** 情绪标签）时，可连续播放 3–4 首纯音乐，仅通过底层视觉（粒子呼吸）维持陪伴感，避免语音过度打扰。

---

## 2. 数据流转路径（网易云 → 情绪标签 → MiniMax → 频谱可视化）

主干数据流（箭头表示因果依赖）：

1. **A 品味与静态画像**：`playlists.json`、`taste.md`、`mood-rules.md`、`routines.md`（或等价）。
2. **B 网易云元数据**：NeteaseCloudMusicApi — 搜索、标签/艺人/专辑、歌词线索、推荐。
3. **C 品味分析（Server）**：融合 A+B，输出结构化画像与非黑盒依据字段。
4. **D 情绪标签层**：规范化枚举（如 calm / focus / uplift / nostalgic）与置信度；可选时段/天气/日程修正。
5. **E 上下文装配**：persona + 画像 + 环境 + 记忆 + 工具结果 → 单一 prompt 包。
6. **F MiniMax 2.6**：生成结构化 DJ 脚本与播报音频（流或片段）。
7. **G 队列执行（Server）**：`play[]` → NCM URL；`say` → 语音片段；交错入队。
8. **H Client 音频图**：`<audio>` + Web Audio Analyser；HTTP/WS 同步 now-playing。
9. **I Three.js + GLSL**：频域/时域 → uniforms → 粒子呼吸与氛围感空间图像。

**契约**：情绪标签为品味与话术之间的显式语义层；频谱链路与业务降级解耦（话术失败时可视化仍可基于能量门限呼吸）。

**视觉映射（频谱 → 粒子）**：低频能量控制粒子的呼吸缩放，高频细节驱动粒子的闪烁与流转。

---

## 3. 模块化边界

### 3.1 Server

| 模块 | 职责 | 禁止 |
|------|------|------|
| Router | HTTP/WS 分发、简易指令 | WebGL / UI |
| Taste & Mood | 文件解析、NCM 聚合、情绪标签 | 替代模型写全长独白 |
| NCM Adapter | 上游 HTTP（`NCM_API_BASE_URL` 或 `NCM_ALLOW_LOCAL_DEFAULT`）为 MiniMax 输出的 `ncmSongId` 取元数据/外链；可降级 yt-dlp；`NETEASE_CLI_ENABLED` 本机抢答 **默认关**（Brain 优先） | 默认持久化全量原始响应 |
| Context Builder | 多片段 prompt 装配 | 日志泄露密钥 |
| MiniMax Adapter | 调用、解析 JSON、重试熔断 | 耦合前端路由 |
| Queue & Playback | now/next、播报/歌曲交错 | Three.js |
| Scheduler | 定时与日历钩子 | 阻塞音频 IO |
| Persistence | 消息、播放史、计划 | 向 Client 暴露令牌 |

### 3.2 Client

| 模块 | 职责 | 禁止 |
|------|------|------|
| App Shell | 路由、设置、场景加载 | 直连网易云 API |
| Audio Graph | `<audio>`、Analyser、手势解锁 | 计算「下一首」业务语义 |
| Visual | 粒子、GLSL、氛围感空间图像的光影 | 持有长期密钥 |
| Transport | REST/WS、重连；**频谱可视化依赖同源音频代理（`/api/audio/proxy`），Client 应优先使用 `proxiedUrl`** | 服务端会话存储 |
| UI 与布局（跨模块） | 播放器与设置采用隐喻式交互，控制区可在 hover 时再显露 | 禁止堆砌复杂的控件（如大量按钮、进度条轮廓）。播放器 UI 需采用隐喻式设计（如 hover 才显示控制区），确保氛围感空间图像始终是视觉主体。 |

---

## 4. 通信协议（API Contract）

实现阶段应用 OpenAPI 或 `CONTRACT.yaml` 固定端口、认证与分页。

### 4.1 HTTP

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/api/chat` | 用户输入 | `{ text, sessionId?, replaceQueue?, clientHints? }`（`replaceQueue:true` 时清空当前与待播队列并仅播本次生成片段） | `{ djScript, queued, traceId }` |
| GET | `/api/now` | 当前态 | `sessionId?` | `type, title?, artist?, url?, proxiedUrl?, positionMs, durationMs?, moodTag, minimaxClipId?, ncmSongId?` |
| GET | `/api/next` | 队列预览 | `?limit=5` | `{ items[] }` |
| GET | `/api/audio/proxy` | 外链音频同源代理（Range、流式） | `?url=<encoded>` | `200`/`206` 音频流；`502` 上游超时 |
| GET | `/api/taste` | 品味摘要 | `?sections=...` | `{ taste, moodRules, updatedAt }` |
| GET | `/api/plan/today` | 当日计划 | 时区头可选 | `{ blocks[] }` |
| POST | `/api/queue/skip` | 跳过（可选） | `{ reason? }` | `{ ok, newHead }` |

### 4.2 WebSocket

| 端点 | 用途 |
|------|------|
| `/stream` | now-playing、状态与可选文本流；Client 可发版本化 ping/轻指令 |

### 4.3 `/stream` 事件名（兼容性）

服务端推送与客户端消息的 `type` 字段取值（扩展时保持向后兼容）：

| type | 方向 | 说明 |
|------|------|------|
| `ping` | C→S | 可选载荷 `{ "schemaVersion": 1 }` |
| `pong` | S→C | `{ "schemaVersion": 1, "ts": "<ISO8601>" }` |
| `now_playing` | S→C | 与 `/api/now` 对齐的当前播放态 |
| `queue` | S→C | 队列头部预览（等价于小规模 `/api/next`） |
| `error` | S→C | `{ "message": "...", "traceId?" }` |

### 4.4 DJ 脚本 JSON（MiniMax → Server）

```json
{
  "schemaVersion": 1,
  "say": "string",
  "play": [{ "ncmSongId": "string", "reason": "string" }],
  "moodTag": "calm|focus|uplift|nostalgic|...",
  "segue": "string",
  "telemetry": { "confidence": 0.0 }
}
```

**moodTag 白名单（非法则降为 `neutral` 并记录）**：`neutral`、`calm`、`focus`、`uplift`、`nostalgic`。

---

## 5. Agent 执行计划（子任务）

| ID | 子任务 | 交付物 | 验收 |
|----|--------|--------|------|
| P1 | 脚手架 | server/client 最小可跑、`env.example` | 构建通过、密钥不入库 |
| P2 | 画像数据面 | `data/user/`、Schema | 校验失败可读错误 |
| P3 | NCM Adapter | 搜索、URL、detail、lyric | Mock 离线通过 |
| P4 | 品味与情绪 | moodTag + explain | 夹具稳定 |
| P5 | Context Builder | `prompts/dj-persona.md`、六片段装配 | 可脱敏 dump |
| P6 | MiniMax Adapter | 文本 + 语音管线 | 解析降级、重试 |
| P7 | 队列时序 | 交错、淡入淡出 | `/api/now` 与播放误差在阈内 |
| P8 | HTTP + WS | 契约实现 | 契约测试 |
| P9 | Client Audio | 单 audio、Analyser | 稳定帧率读频谱 |
| P10 | 氛围感空间图像场景 | Three/GLSL + uniforms | 静音可关开「环境呼吸」 |
| P11 | E2E | traceId、计划 API | 一曲一席话链路 |

依赖：`P2→P4→P5→P6`；`P3‖P2`；`P9–P10‖P5–P8`。

---

## 6. 非目标

多租户计费；盗版离线下载；在 GPU 着色器内做歌词 NLP。

---

## 7. 确认纪要

| 确认人 | 日期 | 修订意见 |
| Finn | 2026.5.7 | 已确认 |
| | | |

确认后对 `schemaVersion`、`moodTag` 枚举、`/stream` 事件名做兼容性约束。

---

## 8. 后续迭代（Next Wave）

以下工单已识别但**不属当前里程碑**，待统领排期后分配执行：

| 工单 ID | 主题 | 阻塞项 | 建议负责 Agent |
|---------|------|--------|----------------|
| W1 | MiniMax TTS 延迟优化 | 当前 5–8s 唤醒延迟 | B 或新性能专项 |
| W2 | 视觉体验升级 | 粒子大小/配色/视差背景；需 P10 频谱先稳定 | C 或新 UX 专项 |
| W3 | 部署与私有化 | Docker / HTTPS / 局域网方案；本机自用目标已达成，此条为可选 | 新 DevOps 专项 |

**备注**：W1 可归入 B 待命期或单独开「性能优化」线；W2 需 C 本轮关闭后重启；W3 为可选增强。

---

## 9. Brain 层架构（Claude Code 框架 + MiniMax 实现）

**架构命名**：遵循 Claudio 施工图 Layer 2（Claude Code 架构）——意图分流 → Context Builder → 大脑适配器。

**实现层**：Executor 通过适配器调用 **MiniMax** 实际生成 DJ 话术，输出同样的 JSON 脚本（say/play/moodTag/segue）。

**优势**：上层规范对齐施工图（子进程/prompt 组装/JSON 输出），底层模型可插拔（Claude/MiniMax/其他）。

---

## 10. 实时播放接口配置（A 部分补充）

**目标**：完善网易云实时播放到前端的完整链路，确保 `<audio>` 能直接消费服务端返回的 URL。

**验收点**：
- yt-dlp 或 NCM API 返回的音频 URL 能被前端直接播放（无需用户额外配置）
- 若使用 yt-dlp：需处理外链 CORS 或走 `/api/audio/proxy` 同源代理
- 若使用 NCM API：需配置 `NCM_API_BASE_URL` + Cookie，验证真机播放
- 接口层：`/api/now` 返回的 `url` / `proxiedUrl` 字段需与前端 `main.ts` 消费逻辑对齐
