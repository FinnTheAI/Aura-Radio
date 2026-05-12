# 网易云上游（NCM）长期方案 — 常驻服务

Aura Radio Server 通过 **`NCM_API_BASE_URL`** 调用网易云 **HTTP API 代理**。本仓库的适配层在 **`server/src/ncma.ts`**（路径形如 `/song/detail`、`/song/url`、`/cloudsearch` / `search` 等，与开源 **NeteaseCloudMusicApi / Enhanced** 系列兼容）。

**产品约定（长期）**：生产与日常联调均视为 **NCM 代理常驻**；`/health`（8080）通过不代表 **3000（或配置的 NCM 端口）**可用。离线收藏文件名、 playable URL、`song-candidates` 拉取等均强依赖或可显著受益于 **可用 NCM**。仅当运维明确允许单机断网 Demo 时才使用 **`NCM_MOCK`** 或由上游失败触发的 yt-dlp 兜底（见 `server/src/ytdlp.md`）。

---

## 1. 推荐上游：NeteaseCloudMusicApi Enhanced

依据《网易云音乐 NodeJS API Enhanced》文档，该项目为 **NeteaseCloudMusicAPI 的增强复刻**，接口数量多、持续维护，与 Aura 的「通过 HTTP 调官方能力」模型一致。

| 能力 | 说明 |
|------|------|
| 默认端口 | **3000**（可用环境变量 `PORT` 修改） |
| 运行形态 | 本机 **`node`**、**`npx @neteasecloudmusicapienhanced/api@latest`**、**Docker**、Vercel / 腾讯云 Serverless 等 |
| 登录/Cookie | 部分接口需在请求中携带网易云 **Cookie**（与 Aura：`MUSIC_U` / `NCM_UPSTREAM_COOKIE` 合并发往代理一致） |
| 地区/IP | Enhanced 文档提供 **`randomCNIP=true`**、`realIP`（Vercel）、**`proxy=`** 查询参数等方式缓解地区或线路问题 |
| 缓存 | 上游可能对相同 URL **短期缓存（文档示例约 2 分钟）**；若遇异常缓存，Enhanced 文档建议 POST 等在 URL 上带时间戳等策略 |

Aura **不负责**托管该仓库进程；由部署方在 **与 Aura Server 同源网络或可被其访问的主机** 上 **常开** 该服务。

**上游仓库指引（摘自公开文档口径）**：`neteasecloudmusicapienhanced/api-enhanced`，亦可通过 **`npx @neteasecloudmusicapienhanced/api@latest`** 快速拉起（每次可能拉最新版，生产建议锁版本）。

---

## 2. Aura 侧环境变量（与 `server/src/config.ts` 对齐）

| 变量 | 含义 |
|------|------|
| **`NCM_API_BASE_URL`** | NCM HTTP 代理根 URL，无尾部多余路径即可。**不要**以 `/` 结尾与否由 `ncma.ts` 归一化处理。示例：`http://127.0.0.1:3000` |
| **`NCM_MOCK`** | 若为 `true`：**不**发起真实上游（开发占位）。长期方案应为 **`0` / unset** |
| **`NCM_ALLOW_LOCAL_DEFAULT` + `NCM_LOCAL_FALLBACK_PORT`** | 未配置 `NCM_API_BASE_URL` 时是否默认连 `127.0.0.1:端口`；与「Explicit 优于隐式」相比，生产更推荐 **显式写死 `NCM_API_BASE_URL`** |
| **`MUSIC_U` / `NCM_UPSTREAM_COOKIE`** | 发往 NCM 代理的 Cookie，用于登录态、更高可用 URL（勿提交密钥） |

**验收**：Aura 进程所在环境 **`curl "${NCM_API_BASE_URL%/}/song/detail?ids=<合法单曲ID>"`**（或使用代理文档里的等价路径）应在超时内返回 **JSON**。

**健康信号（日志）**：若 **`ultimate_fallback_pick`** 或 **`candidate_pool_fallback_pick`** 在短时间内反复出现，说明云搜/可播 URL 或 Brain 解析仍不稳定，应优先排查：代理是否常驻、基址是否正确、Cookie 是否有效、是否误开 `NCM_MOCK` 或 `AURA_SKIP_NCM_CANDIDATES=1`。详见下文「日志关键词」。

---

## 3. 「NCM 常开」运维形态（任选其一）

1. **本机常驻进程**：`pnpm i && node app.js`，配合 **NSSM / pm2 / systemd user unit** —— 开机自启、崩溃重启、日志轮转。  
2. **Docker**：文档示例 `docker run -d -p 3000:3000 …`；注意容器内 **`http_proxy`** 等与请求库交互，不可用代理时按需清空或通过 Enhanced 文档的 **`proxy=`** 显式传入。  
3. **局域网/内网地址**：Aura 的 **`NCM_API_BASE_URL`** 指向内网网关或 Sidecar Pod，不要求与 8080 同进程。  
4. **远程 Hosted API**：不推荐依赖他人公共实例（安全与 SLA）；若自建在 Vercel 等，按 Enhanced 文档配置 **`realIP` / `randomCNIP`** 等，并把基址填入 **`NCM_API_BASE_URL`**。

**建议增加独立健康巡检**（任选）：每 60s GET 一条轻量接口；失败则告警，避免仅发现「收藏变数字 id.mp3」或 Brain 链路二次失败。

---

## 4. 与降级链路的边界

顺序（语义上）通常为：**NCM 代理成功 → playable URL / 详情**；仅在 **未配置或可配置失败**时再走 **`ncma.ts` 内部** yt-dlp / 占位（实现以 **`server/src/ncma.ts`**、**`server/src/ytdlp.ts`** 为准）。

**Brain** 链路（Claude / MiniMax）故障时 **不再自动 Mock DJ 脚本**（需 **`BRAIN_MOCK=1`** 才可能占位）；与 **NCM 是否可用**互相独立——但 **曲目落地**仍需 NCM 或 yt-dlp 其一可读。

---

## 5. 联调自检清单（给终端/CI）

1. NCM：`curl`/`Invoke-WebRequest` 探活 **`NCM_API_BASE_URL`**。  
2. Aura：`curl http://localhost:8080/health`。  
3. 业务：`POST /api/favorite` 后对 **`data/downloads/`**：在 NCM 正常且 Cookie 可用时，应优先出现 **`标题 - 歌手.mp3`**；极端失败时再退化为 **`{ncmSongId}.mp3`**（见离线收藏模块）。

---

## 6. 架构文档映射

整体设计见 **[ARCH_DOC.md](./ARCH_DOC.md)** §3「NCM Adapter」；本条为 **运维与上游选型专用补充**，契约细节仍以 **`CONTRACT.yaml`** 与本仓库实现对齐为准。

---

## 7. 服务端日志关键词（选曲链路）

以下由 `server/src/song-candidates.ts` 打出，便于 grep / 日志平台建简单告警：

| 关键词 | 含义与处理 |
|--------|------------|
| **`ultimate_fallback_pick`** | 已使用内置占位曲 ID；**频繁出现**＝请先修稳 **NCM 代理 + `NCM_API_BASE_URL` + Cookie**，再查 Brain `discoveryNote`。 |
| **`candidate_pool_fallback_pick`** | 主解析失败，从当日候选池随机换歌；与上条同时增多时同上。 |
| **`discoveryNote_empty_search`** / **`discoveryNote_ncm_search_failed`** | 云搜无结果或请求失败 → 查代理连通与关键词质量。 |
| **`discoveryNote_no_playable_hit`** / **`emergency_search_no_playable_hit`** | 有搜索结果但 **`/song/url` 均无可用链接** → 重点查 **Cookie / VIP** 与代理版本。 |
| **`brain_ncm_id_unplayable_after_probe`** | Brain 给的数字 ID 当前环境不可播 → Cookie 或版权。 |

启动时若 **`[aura] NCM 上游未就绪`** 或 **未检测到 Cookie**，也会在首屏 warn，避免长期误以为「Brain 坏了」实为上游未配置。

---
