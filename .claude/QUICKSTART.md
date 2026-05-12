# Aura Radio 快速启动指南

## 项目状态（截至 2026-05-12）

- **架构**: Claude Code 分层 + MiniMax 实现，文案间隙显示（无TTS语音）
- **状态**: 制作基本完成，进入体验优化阶段
- **主要组件**: 粒子视觉 ✅、Mock随机选曲 ✅、收藏离线曲库 ✅、诗意文案间隙显示 ✅

## 依赖服务检查

| 端口 | 服务 | 启动方式 | 状态检查 |
|------|------|----------|----------|
| 3000 | NCM Enhanced 代理 | `cd D:\NeteaseCloudMusicApiEnhanced\api-enhanced-main && node app.js` | `curl http://127.0.0.1:3000` |
| 8080 | Aura 服务端 | `npm run dev -w @aura-radio/server` | `curl http://127.0.0.1:8080/health` |
| 5173 | 前端开发服务器 | `npm run dev -w @aura-radio/client` | 浏览器访问 |

## 一键启动命令（PowerShell）

```powershell
cd D:\Projects\Individual\Aura-Radio; Write-Host "=== Aura Radio 快速启动 ===" -ForegroundColor Cyan; $ncm = curl -s http://127.0.0.1:3000 2>$null; if (!$ncm) { Write-Host "⚠️  NCM (3000) 未启动，请先启动网易云代理" -ForegroundColor Yellow } else { Write-Host "✅  NCM (3000) 已就绪" -ForegroundColor Green }; $aura = curl -s http://127.0.0.1:8080/health 2>$null; if (!$aura) { Write-Host "🚀  启动 Aura 服务端..." -ForegroundColor Cyan; npm run dev -w @aura-radio/server } else { Write-Host "✅  Aura (8080) 已就绪" -ForegroundColor Green }; Start-Sleep 3; $client = curl -s http://127.0.0.1:5173 2>$null; if (!$client) { Write-Host "🚀  启动前端..." -ForegroundColor Cyan; npm run dev -w @aura-radio/client } else { Write-Host "✅  前端 (5173) 已就绪" -ForegroundColor Green }; Write-Host "🎵  打开浏览器: http://localhost:5173" -ForegroundColor Magenta
```

## 快速验证清单

打开 http://localhost:5173 后：

- [ ] 背景建筑图透出，粒子在前景飘动
- [ ] 点击「触碰以唤醒播放」，显示诗意文案（如"暮色漫过窗沿..."）
- [ ] 文案后自动播音乐，无 AbortError
- [ ] 空格切歌，文案同步更新
- [ ] 收藏按钮（♡）可用，提示"已加入离线曲库"

## 常见排查

**粒子不显示**: 检查 WebGL 是否启用，浏览器控制台无 GLSL 编译错误
**无声音**: 检查 3000/8080/5173 三端口是否全起，浏览器自动播放策略需用户点击
**文案不更新**: 检查 WebSocket /stream 连接，看 network 面板 WS 帧

## 文件定位（供Claude快速查找）

- 粒子实现: `client/src/visual.ts`, `client/src/visual_logic.glsl`
- 播放控制: `client/src/main.ts`
- Brain文案: `server/src/brain.ts`, `prompts/dj-persona.md`
- 收藏离线: `server/src/favorites.ts`
- 契约文档: `docs/CONTRACT.yaml`, `docs/ARCH_DOC.md`
