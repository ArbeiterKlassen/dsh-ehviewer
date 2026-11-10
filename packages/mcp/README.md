# dsh-ehviewer

MCP server (stdio) for e-hentai / exhentai. 46 tools, plain ESM, no build step, Node ≥ 20.

```bash
node src/index.js          # 等 MCP 客户端来连
npm run smoke              # 46/46 工具注册 + URL 构造 + 过滤规则
npm test                   # 离线测试（CI 同款）
```

客户端注册：

```jsonc
{ "name": "ehentai", "transport": "stdio",
  "command": "node", "args": ["<repo>/packages/mcp/src/index.js"] }
```

数据目录 `~/.dsh-eh/`（配置、历史、笔记、评论缓存、订阅、标签库索引），下载默认落在 `~/.dsh/eh-downloads/<exh|eh>-<memberId>/`。

完整说明见仓库根目录 [README.md](../../README.md)。
