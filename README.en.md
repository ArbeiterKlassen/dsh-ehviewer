# dsh-ehviewer

An e-hentai / exhentai toolkit for agents: an MCP server, a local viewer panel, and a DeepSeek Harness sidebar entry.

- **`dsh-ehviewer`** — MCP server (stdio, plain ESM, no build step). 46 tools: search, gallery details, page images, whole-gallery download with resume, favorites, subscriptions, comments, notes, local-library search.
- **`dsh-ehviewer-panel`** — read-only local panel on `127.0.0.1:7712`: what the agent has viewed, downloaded and annotated, plus an in-panel reader (local files first, online as fallback).
- **`dsh-ehviewer-plugin`** — adds a **DSH-EH** row to the DeepSeek Harness sidebar and embeds the panel in-app; it also supervises the panel process and forwards the host theme.

Everything stays local: data lives in `~/.dsh-eh/` and your download directory, and the panel binds loopback only.

## Quick start

```bash
git clone <repo> && cd dsh-ehviewer
npm install
npm test                       # offline suite

# MCP server
node packages/mcp/src/index.js

# panel
node packages/panel/server.mjs # http://127.0.0.1:7712/
```

Register the server in any MCP client:

```jsonc
{ "name": "ehentai", "transport": "stdio",
  "command": "node", "args": ["<repo>/packages/mcp/src/index.js"] }
```

Login is either account+password (`eh_login`) or cookies (`eh_cookie_set`); exhentai additionally needs `igneous`.
Network access goes through a SOCKS5 proxy by default (`socks5://127.0.0.1:10808`) — change `proxy` in `~/.dsh-eh/config.json` for your setup.

## Docs

- [README.md](README.md) — full Chinese documentation (tools, config, semantics, pitfalls)
- [docs/agent-usage.md](docs/agent-usage.md) — token-cheap call patterns for agents
- [packages/panel/README.md](packages/panel/README.md) — panel API and UI
- [packages/dsh-plugin/README.md](packages/dsh-plugin/README.md) — DSH bundle install and behavior

## License

MIT. Scraping behavior is your responsibility — defaults are `rateLimitMs: 800`, concurrency 4; keep them polite.
