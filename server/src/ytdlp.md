# yt-dlp 歌曲 URL 获取模块

## 概述

当 `NeteaseCloudMusicApi` (NCM_API_BASE_URL) 未配置时，系统使用 yt-dlp 从网易云音乐获取真实播放 URL。

## 依赖

- `yt-dlp` 已安装并位于 PATH 中
- Node.js >= 18

## 工作流程

1. `ncmSongUrl()` 被调用（来自 `queue-engine.ts`）
2. 如果 `config.ncmMock || !config.ncmApiBaseUrl`，则调用 `ytdlpGetUrl()`
3. `ytdlp.ts` 执行 `yt-dlp -J https://music.163.com/song?id=XXX`
4. 解析 JSON 输出，提取最高音质的音频 URL
5. 返回 `{ url, durationMs }`

## 降级策略

```
NCM API (NeteaseCloudMusicApi) → yt-dlp fallback → Mock MP3
```

每层都有 fallback：
- **NCM API**：需部署 `NeteaseCloudMusicApi` 服务并配置 Cookie
- **yt-dlp**：需本地安装 yt-dlp，有 15 秒超时
- **Mock**：返回 SoundHelix 示例 MP3（保底）

## 超时控制

yt-dlp 调用有 15 秒超时（可配置），防止网络慢时请求卡死。

## 日志

使用统一的 `logger.ts`，日志前缀为 `[ytdlp]`。

## 注意事项

> ⚠️ **Experimental/Development use**: yt-dlp 是抓网页/逆向，结构可能变、可能有风控/IP 限制，不适合生产环境长期依赖。

## API 调用示例

```bash
# 直接测试 yt-dlp
yt-dlp -J "https://music.163.com/song?id=108914"
```

## 与现有架构的集成

```
queue-engine.ts → ncma.ts → ytdlp.ts (fallback)
                              ↓
                        yt-dlp CLI
                              ↓
                        真实播放 URL
```

修改的文件：
- `server/src/ncma.ts` - 在无 NCM API 时调用 ytdlp
- `server/src/ytdlp.ts` - 新增模块（超时控制 + 统一日志）
