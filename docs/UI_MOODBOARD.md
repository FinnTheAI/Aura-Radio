# UI Moodboard — Agent 可执行审美 SPEC

**主题**：光之尘埃与永恒秩序（Dust of Light & Eternal Order）

实现与验收时请对照 [`DESIGN_TOKENS.json`](./DESIGN_TOKENS.json)、[`COMPONENT_GRAMMAR.md`](./COMPONENT_GRAMMAR.md) 及 `client/src/visual_logic.glsl`（粒子算法意图）。

---

## 空间意向

| 层级 | 意图 | 工程映射 |
|------|------|-----------|
| **底座层** | 宏大的、几何感极强的建筑负空间（柱廊、穹顶、光束） | 全屏背景图（`/api/background/*`）；构图留白，勿抢粒子层 |
| **介质层** | 浮动香槟色有机微尘（加法混合、中心更亮）；韵律漂移（方位/极角调制），非纯噪声 | `client/src/visual.ts`（`AURA_PARTICLES` + ShaderMaterial）· `visual_logic.glsl` |

---

## 交互哲学：隐身（Invisibility）

- **默认**：功能性 UI **缺席**（透明度 0 / 不占视觉焦点），粒子与底座主导。
- **观测介入**：用户指针进入舞台（悬停）→ 通过 **背景虚化**（`backdrop-filter`）腾出层次 → HUD **淡入**。
- **核对**：无悬停时 HUD 不可读；悬停后 0.5s 量级过渡（见 DESIGN_TOKENS `effects.hover_state.transition`）。

---

## 色彩与质感

| 元素 | 规格 |
|------|------|
| **微粒（WebGL）** | **加法混合**下的低饱和香槟 → 近白高亮芯；每粒子随机发光强度；大屏可见点尺寸（参数见 `visual.ts` → `AURA_PARTICLES`）。`palette.particle_gold` 多用于 CSS/HUD 语义对齐，与着色器内高明度粉粒不必数值一致 |
| **UI** | 极简白或浅金；**Hairline** 线性图标，避免块状填充图标 |
| **状态底** | 低调半透明暗底，见 `palette.status_bg` |

---

## 与本仓库文件的对应关系

| 能力 | 路径 |
|------|------|
| 视觉物理常数 | `docs/DESIGN_TOKENS.json` → `:root` CSS 变量（`client/src/style.css`） |
| 组件拼装规则 | `docs/COMPONENT_GRAMMAR.md` |
| 粒子 GLSL 意图与片段参考 | `client/src/visual_logic.glsl`（实际管线嵌入 `visual.ts` ShaderMaterial） |
| 建筑底图随机源 | `server/src/background-picker.ts`，目录默认 `Ref/Background/` |
