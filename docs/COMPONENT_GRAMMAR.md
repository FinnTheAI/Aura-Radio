# Component Grammar — 从功能到构件（Tectonics of Interface）

Agent 实现 UI 时按本节拼装；审美总则见 [`UI_MOODBOARD.md`](./UI_MOODBOARD.md)。

---

## 1. 悬浮控制区（Hover Overlay）

| 项 | 规则 |
|----|------|
| **触发** | 指针进入舞台根节点（`.aura-stage`，含画布区域） |
| **视觉** | `#stage-blur` 叠在**背景图之上、WebGL 画布之下**，使用 `backdrop-filter` 做深度虚化（值见 `DESIGN_TOKENS.effects.hover_state.blur`） |
| **HUD** | 默认 `opacity: 0`；悬停时 `opacity: 1`，过渡见 tokens |
| **指针事件** | HUD 非悬停时使用 `pointer-events: none`，悬停时为 `auto`，避免隐形层挡操作 |

---

## 2. 图标矩阵（Icon Matrix）

| 项 | 规则 |
|----|------|
| **形态** | 线性图标（Hairline）：唤醒（Play）、下一首、收藏（Like）、对话（Chat） |
| **Chat** | 点击 Chat → 展开 `#chat-panel`（输入行 + 发送）；发送键默认低对比，**有输入内容时**提高亮度（`.chat-send-active`） |
| **模式** | 在线/离线切换可置于矩阵旁次级控件，保持细线/文字极简 |

---

## 3. 状态铭牌（Status Nameplate）

| 项 | 规则 |
|----|------|
| **位置** | 底部固定区域；宽度随内容自适应（`max-width` + 换行） |
| **内容** | 当前曲目 / 流水线状态 / DJ 大字文案 / `#meta` 诊断与兜底提示 |
| **可读性** | 使用 `palette.status_bg` 类半透明衬底，勿用大色块按钮抢占铭牌 |

---

## 4. 背景图（服务端）

- 自 `Ref/Background/`（或 `BACKGROUND_REF_DIR`）随机抽取一张作为 `#bg-layer` 的 `background-image`。
- 前端启动时请求 `GET /api/background/random`；404 时静默无图（仅渐变 + 粒子）。
- `#scene` 内 WebGL 画布透明（`alpha` 清屏），粒子参数与混合策略见 [`ARCH_DOC.md`](./ARCH_DOC.md) §2.1 · `client/src/visual.ts` → `AURA_PARTICLES`。

---

## 5. Agent 执行清单（PR 自检）

- [ ] `:root` 与 `DESIGN_TOKENS.json` 一致  
- [ ] 悬停虚化为「仅虚化背景层」，粒子层保持锐利  
- [ ] 图标为 stroke / hairline，非填充块标  
- [ ] 发送键随输入点亮  
- [ ] 背景 API 与目录安全配置（路径穿越防护）
