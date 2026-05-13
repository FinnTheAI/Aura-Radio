# 贡献指南

感谢你对 Aura Radio 的兴趣！

## 开发流程

1. **Fork & Clone**
   ```bash
   git clone https://github.com/yourusername/aura-radio.git
   cd aura-radio
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **创建分支**
   ```bash
   git checkout -b feat/your-feature-name
   ```

4. **开发 & 测试**
   ```bash
   npm run dev:server
   npm run dev:client
   npm test
   ```

5. **提交 PR**

## 代码规范

- **TypeScript**：严格类型，禁止 `any`
- **API 契约**：修改 CONTRACT.yaml 前需统领确认
- **密钥**：绝不提交 `.env`，使用 `env.example` 占位

## 提交信息格式

```
feat: 新功能
fix: 修复
docs: 文档
refactor: 重构
perf: 性能优化
```

## 问题反馈

使用 GitHub Issues，附：
- 复现步骤
- 环境信息（Node 版本、操作系统）
- 错误日志
