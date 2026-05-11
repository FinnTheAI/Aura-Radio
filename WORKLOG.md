# AI DJ 选曲与预加载 — 工作记录

## 目标

基于网易云口味画像驱动歌曲推荐，实现队列驱动的无缝播放预加载。

## 核心变更（2026-05-11）

### 1. `server/src/context-builder.ts` — 品味数据读取

**问题**：原 `buildCloudTaste()` 直接查 SQLite 数据库（`cloud_favorites` / `cloud_history`），但数据库为空，导致口味数据始终为"暂无数据"，选歌完全随机。

**修复**：
- 新增 `readTasteCloudMd()` — 优先读取 `data/user/taste-cloud.md` 文件
- 检测"收藏总条目"字段判断文件是否有真实数据
- 空时兜底读数据库（已废弃路径）

```typescript
function readTasteCloudMd(): string {
  const tasteCloudPath = path.join(config.userDataDir, 'taste-cloud.md');
  const content = fs.readFileSync(tasteCloudPath, 'utf8');
  if (content.includes('收藏总条目') || content.includes('网易云听歌画像')) {
    return content; // 有真实收藏数据
  }
  return ''; // 兜底空数据库
}
```

**选曲策略更新**（`buildCloudTaste` 兜底返回）：
- 旧：优先从 Top 艺人选，冷门佳作留 20%
- 新：**冷门佳作优先 70%**，不依赖收藏量高的数据，分析隐性偏好

---

### 2. `server/src/brain.ts` — Claude CLI 调用链

**问题 1：`ENAMETOOLONG`**
- prompt 全长超 Windows 命令行参数限制，`spawn` 失败，降级 Mock

**修复**：去掉 `-p` 命令行传参，改用 **stdin pipe** 传入 prompt

**问题 2：`--allowedTools Bash` 导致 stdin pipe 挂起**
- Claude CLI 在 `--print --input-format text --allowedTools Bash` 模式下，收到 stdin 后等待 Bash 工具执行，API 调用永久挂住

**修复**：去掉 `--allowedTools Bash`（纯文字生成场景不需要工具调用）

**问题 3：`--output-format json` 输出包装格式**
- `--output-format json` 返回 `{"type":"result","result":"{...}"}` 而非纯 JSON
- `parseDjJson` 解析失败，降级 Mock

**修复**：去掉该 flag，Claude 直接输出纯 JSON

**最终调用方式**：
```typescript
const child = spawn('claude', [
  '--print',
  '--input-format', 'text',
  '--permission-mode', 'bypassPermissions',
], { stdio: ['pipe', 'pipe', 'pipe'] });

child.stdin.write(prompt, () => child.stdin.end());
```

---

### 3. `client/src/main.ts` — 队列驱动预加载

**新增功能**：
- 订阅 WebSocket `queue` 消息（之前只处理 `now_playing`）
- `findNextMusicItem(items, startIndex)` — 从队列中跳过 voice 项，找第一首有 URL 的 music
- `queueMusicScanStartIndex` — idle 时从 0 扫，否则从 1 扫（跳过 items[0] 当前在播）
- 隐藏 `<audio id="preload-audio">` — 仅 `.load()` 缓冲，不 `.play()`
- Space 键触发 `POST /api/queue/skip` → 服务端推进队列 → 新 `queue` WS → 预加载立即指向新的下一首

**关键逻辑**：
```typescript
// WS handler
if (msg.type === 'queue' && Array.isArray(msg.items)) {
  const next = findNextMusicItem(msg.items, queueMusicScanStartIndex);
  preloadTrack(next?.absUrl); // 只 .load()，不 .play()
}

// hydrateFromNow
queueMusicScanStartIndex = np.type === 'idle' ? 0 : 1;
```

---

## 验证结果

```bash
# /api/chat 端到端（成功，不再 Mock）
POST /api/chat → HTTP 200
say: "深夜的后摇质地——那种层层堆叠、无人声..."
play: 4首，moodTag: calm

# 品味画像已注入
# taste-cloud.md（9485 条收藏）→ buildCloudTaste → userCorpus
```

## 当前状态

- **构建通过**：`tsc` 无错误
- **Claude CLI 正常**：`stdin pipe` 方式稳定返回
- **选歌符合偏好**：后摇、电子、华语独立（来自 taste-cloud.md）
- **预加载就绪**：队列 WS + 跳过当前项逻辑

## 待优化

- `taste-cloud.md` 内容可进一步裁剪（目前 21KB 全量注入）
- `suppressWsNowPlaying > 0` 期间 queue 消息也被忽略，口播很长时下一首不会被预加载
