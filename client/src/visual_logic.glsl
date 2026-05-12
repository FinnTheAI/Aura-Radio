// =============================================================================
// Aura Radio — 粒子「光之尘埃」动力学意图（参考 SPEC）
// 实际运行时：顶点/片段着色器内嵌于 client/src/visual.ts 的 ShaderMaterial。
// 可调数值收口于 visual.ts 顶层常量 AURA_PARTICLES；顶点串注入时用 glslFloat()，勿把裸整数写入 mix()。
// 美学对齐：docs/UI_MOODBOARD.md · docs/DESIGN_TOKENS.json · docs/ARCH_DOC.md §2.1
// =============================================================================
//
// Uniform（与 visual.ts 字段名一致）：
//   uTime           — 帧累积时间（tick 内 ~+1/60）
//   uLow / uHigh    — Analyser 低频 / 高频能量（已 lerp 平滑）
//   uAmbientBreath — 静音「环境呼吸」时为 1，否则 0
//
// Varying：
//   vDepth01 / vFocus — 相机距离归一化与对焦权重（近 focus 高）
//   vAtmo       — 由静止 position.y 推导的氛围插值（冷暖微调）
//   vGrain      — 每粒子 hash（尺寸抖动等）
//   vGlowAmp    — 每粒子随机发光强度，片段乘到 hot 通道 alpha
//
// 设计意图（与当前实现一致）：
//   1. 分布 — 均匀球体体积采样 rr=cbrt(rand)*R，方向均匀，蓬松一球云。
//   2. 顶点 — 由 radial dir 得 azimuth/polar；径向脉冲 + 切向 swirl + 轴向微摆，
//            相位随方向变化形成韵律漂移；低频调制 pulse/scale，高频 flicker；
//            depth01 驱动 gl_PointSize（近小远大，雾粒更大）。
//   3. 片段 — Additive：低饱和 dust/champagne，径向混入 whiteCore（hot 高斯芯 +
//            halo 幂次雾）；shell 宽 smoothstep 柔边；rgb 下限 clamp，减轻暗底上的灰边感；
//            aHalo + aHot 双层透明度。
//   4. 合成 — WebGL 画布 alpha=0 清屏，叠于 #bg-layer 之上；勿与 NormalBlending
//            预乘混用，除非同步改版 ARCH_DOC §2.1。
