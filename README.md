> 个人 AI 电台 · 读懂听歌习惯 · 规划声音 · 让 AI 成为最懂你的私人 DJ。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
<img width="3696" height="1574" alt="拼图" src="https://github.com/user-attachments/assets/70909ec0-2260-4c14-8544-f845c024657f" />

## ✨ 核心特性

- **🎧 AI DJ 主动推荐**：基于你的收听习惯，Claude 主动播报介绍（中文口播有点怪去掉了）
- **📻 诗意间隙文案**：歌曲间隙展示 1-2 句诗意过渡语，不打断音乐流
- **💾 离线收藏曲库**：收藏歌曲自动下载，高延迟时无缝降级播放
- **🎨 频谱粒子视觉**：Three.js + WebGL 粒子随音乐呼吸，沉浸氛围
- **☁️ 网易云集成**：对接 NeteaseCloudMusicApi，云端口味同步分析
- **🔧 模块化架构**：Claude Code 分层架构，意图 → Context → Brain → 执行

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 外部上下文                                         │
│  • taste.md / playlists.json（用户品味）                      │
│  • NeteaseCloudMusicApi（曲库）                              │
│  • MiniMax API（文案生成）                                   │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: 本地大脑                                           │
│  • Router (HTTP/WS)                                          │
│  • Context Builder（六片段组装）                             │
│  • Brain Adapter（Claude → MiniMax 降级）                   │
│  • Queue & Playback（队列时序）                              │
│  • SQLite 持久化                                             │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: 运行时聚合                                         │
│  • persona + 画像 + 环境 + 记忆 → prompt                     │
│  • DJ JSON 脚本（say / play / moodTag）                      │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: 交互表层                                           │
│  • PWA + <audio> 播放队列                                    │
│  • Three.js 粒子频谱可视化                                   │
│  • WebSocket 实时同步                                        │
└─────────────────────────────────────────────────────────────┘
```
<img width="941" height="1672" alt="ChatGPT Image 2026年5月13日 13_33_06" src="https://github.com/user-attachments/assets/88bddf42-68c4-45b0-b767-6761d01f17df" />

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/yourusername/aura-radio.git
cd aura-radio
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
copy env.example .env
# 编辑 .env 填入你的密钥
```

**必需配置：**

| 变量 | 说明 | 获取方式 |
|------|------|----------|
| `MINIMAX_API_KEY` | MiniMax API 密钥 | [MiniMax 官网](https://www.minimaxi.com/) |
| `NCM_API_BASE_URL` | 网易云 API 代理地址 | 本地部署 [NCM Enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) |

### 4. 启动服务

```bash
# 启动网易云代理（端口 3000）
cd /path/to/NCM-Enhanced
node app.js

# 启动 Aura Radio（新终端）
npm run dev:server   # 端口 8080
npm run dev:client   # 端口 5173
```

### 5. 打开浏览器

本地访问 http://localhost:5173，点击「触碰以唤醒播放」。

## 📁 项目结构

```
aura-radio/
├── client/                    # 前端 PWA
│   ├── src/
│   │   ├── main.ts           # 播放控制、WS、交互
│   │   ├── visual.ts         # Three.js 粒子场景
│   │   └── style.css         # 隐喻式 UI
│   └── index.html
├── server/                    # 服务端
│   ├── src/
│   │   ├── brain.ts          # Claude CLI + MiniMax 降级
│   │   ├── queue-engine.ts   # 队列时序、文案间隙
│   │   ├── context-builder.ts# 六片段 prompt 组装
│   │   ├── favorites.ts      # 收藏离线曲库
│   │   └── tts.ts            # 文案生成（已移除语音）
│   └── package.json
├── data/
│   └── user/
│       ├── taste.md          # 用户品味速写
│       ├── playlists.json    # 歌单收藏
│       └── taste-cloud.md    # 云端口味分析
├── prompts/
│   └── dj-persona.md         # DJ 人设 prompt
├── docs/
│   ├── ARCH_DOC.md           # 架构文档 SPEC
│   ├── CONTRACT.yaml         # API 契约
│   └── NCM_UPSTREAM.md       # 网易云代理指南
└── README.md
```

## 🛠️ 技术栈

- **前端**：Vite + TypeScript + Three.js (WebGL 粒子)
- **后端**：Node.js + Express + WebSocket + better-sqlite3
- **AI**：Claude Code CLI + MiniMax API
- **音乐**：NeteaseCloudMusicApi Enhanced
- **部署**：PWA + 本地服务器

## 📝 配置说明

### 播放模式

```env
# 强制在线模式（不走离线曲库）
FORCE_ONLINE_MODE=1

# 文案显示时长（毫秒）
DJ_TEXT_DISPLAY_MS=3000

# 粒子视觉风格
PARTICLE_STYLE=additive    # additive / normal
```

### 网易云代理

详见 [docs/NCM_UPSTREAM.md](docs/NCM_UPSTREAM.md)

## 🙏 致谢

- [Claudio_施工图_mmguo](https://mmguo.dev/claudio-fm/) - 架构灵感来源
- [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) - 网易云 API
- [MiniMax](https://www.minimaxi.com/) - AI 文案生成
- [Three.js](https://threejs.org/) - WebGL 渲染

---

> 🌙 *暮色漫过窗沿，音符在缝隙里游走* — Aura Radio
