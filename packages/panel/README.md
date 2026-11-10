# dsh-ehviewer-panel

`dsh-ehviewer` 的本地浏览面板：**只读**，只绑 `127.0.0.1`，起一个 node 进程就够，没有任何第三方依赖。

```bash
node server.mjs                       # 默认 7712，被占自动顺延（最多 +10）
node server.mjs --port 7800 --data ~/.dsh-eh --root ~/.dsh/eh-downloads
npx dsh-ehviewer-panel                # 装成依赖之后
```

启动后打印真实地址，例如 `http://127.0.0.1:7712/`。

## 它读什么

| 文件 | 内容 |
| --- | --- |
| `~/.dsh-eh/history.jsonl` | MCP 记下的 `view` / `download` / `search` 流水 |
| `~/.dsh-eh/notes.json` | 笔记（按 gid） |
| `~/.dsh-eh/comments.json` | 评论快照（`eh_comments` 读一次存一份） |
| `~/.dsh-eh/library.json` | 下载库索引（`eh_local_index` 生成） |
| `<downloadDir>/<account>/<gid>-<token>/` | 图片与 `meta.json` |

全部只读，面板自己不改这些文件。

## 界面

- **看过**：时间线，按 gid 聚合（同一本看多次标 `×N`），有笔记和评论会打点。
- **下载**：网格，封面取本地第一张；点开进详情。
- **笔记**：卡片，带评分与来源（线上/下载）。
- **本地库**：表格，点行进详情。
- **阅读器** `/read/:gid/:token?n=1`：本地有下载就读本地文件，没有走在线（`online.mjs` 复用 MCP 那份 config / cookie / 代理 / 解析器，20 页一个窗口懒加载）。← → 翻页、Home/End 首尾、Esc 回详情、宽屏双页、失败可重试。

配色跟 DSH 走：父窗口会 `postMessage({type:'dsh-eh:theme', mode, vars})` 下发 8 个颜色变量（`--eh-bg / -bg-elev / -bg-hover / -border / -text / -text-dim / -accent / -accent-dim`）；单独打开时按 `prefers-color-scheme` 自己判断。

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/health` | `{ok,pid,port,startedAt,owner,script,node,root}`，给宿主插件认亲用 |
| `GET /api/summary` | 各类计数、最近浏览时间 |
| `GET /api/history?type=&q=&limit=&offset=` | 原始流水（聚合在前端做） |
| `GET /api/notes?q=&limit=&offset=` | 笔记 |
| `GET /api/library?q=&limit=&offset=` | 本地库索引 |
| `GET /api/gallery/:gid` | 合并视图：history + note + local + comments |
| `GET /api/online/pages/:gid/:token?from=&to=` | 在线页链接（窗口 ≤ 20） |
| `GET /api/online/img/:gid/:token/:n` | 在线图片字节流 |
| `GET /img?path=<绝对路径>` | 本地图片，越界 403 |

安全边界：所有 `/img`、`--root` 相关路径都限制在下载根目录内；只监听回环地址，没有鉴权（同机其他程序能读，介意就别开）。

## 已知取舍

- `/api/summary`、`/api/history` 每次请求都重读文件，几千条量级无压力；再大就该上索引。
- 在线读图会**串行**走 MCP 的限速（默认 800ms/请求），一本 40 页大概是「翻到哪加载到哪」的体感，不会一次拉全本。
