# dsh-ehviewer-plugin

给 DeepSeek Harness 用的一个小 bundle：侧边栏加一行 **DSH-EH**，点开在主区域内嵌 `dsh-ehviewer-panel`（iframe），并负责把面板进程拉起来、挂了重拉、上一轮的遗留进程收掉。

## 它做什么

1. **启动即探活**：`127.0.0.1:7712` 没在听就用 node 拉起 `dsh-ehviewer-panel`（`detached + stdio:'ignore' + unref`，不阻塞宿主启动，失败只记日志）。
2. **认亲 + 接管**：端口在听但对面不是本轮进程（`/api/health` 的 `owner` 不同或 `startedAt` 早于宿主启动）→ 确认脚本是 `panel/server.mjs` 后 `taskkill /F` 收掉，再重新拉起。老版本没有 `/api/health` 时用 `/api/summary` 认亲 + `netstat -ano` 找 pid。
3. **看护**：之后每 60 秒探一次活，死了自动重启（timer 已 `unref`，不挡宿主退出）。
4. **主题桥**：从宿主真实 CSS token 里取 8 个颜色 + `mode`（`body[data-ds-dark-theme]`），`postMessage` 给 iframe；`MutationObserver` + `prefers-color-scheme` 变化时补发。
5. **宿主路由**（需要鉴权，只给宿主自己用）：`GET /api/dsh-eh/ensure`、`GET /api/dsh-eh/status`。

## 安装

```bash
cd <你 profile 的目录>            # 例如 ~/.dsh/profiles/desktop
npm i -D dsh-ehviewer-plugin      # 或 npm i -D file:<repo>/packages/dsh-plugin
```

然后 profile 的 `package.json` 里：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-ehviewer-plugin"]
    }
  }
}
```

重启 DSH。侧边栏「上下文洞察」和「MCP连接器」之间会多一行 **DSH-EH**。

## 配置

bundle 的 `cordis.patch.yml` 里那一行可以覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `url` | `http://127.0.0.1:7712/` | 面板地址（改端口这里也要改） |
| `script` | 空 = 自动解析 | 面板脚本绝对路径；留空时依次看 `DSH_EH_PANEL_SCRIPT`、同仓库 `packages/panel/server.mjs`、依赖 `dsh-ehviewer-panel` |

## 卸载

```bash
npm uninstall dsh-ehviewer-plugin
```

再从 `dsh.profile.bundles` 里删掉 `dsh-ehviewer-plugin`，重启 DSH。面板进程若还在，`taskkill` 掉即可。

## 坑

- **改了 `lib/client.js` 必须 Ctrl+R 一次**：客户端模块被 `__ModuleLoader__` 缓存，HMR 换 rev 不保证重新求值。
- 端口被别的程序占着且 `/api/summary` 不像面板 → 不动它，只记 `occupied-by-other`，按钮会显示原因。
- 桌面宿主的 `process.execPath` 是 DSH 的 exe，不能拿它 spawn（会再开一个 GUI）；插件按 `DSH_EH_NODE` → PATH → 常见安装路径找真 node。
