# eh-mcp 模块契约（所有子模块必须遵守）

目标：给 agent 用的 e-hentai / exhentai MCP server。纯 ESM（`"type": "module"`），无 TS 构建。
依赖已装：`@modelcontextprotocol/sdk` `cheerio` `undici` `socks-proxy-agent`。

## 目录
```
src/config.js    配置读写（~/.dsh-eh/config.json）
src/http.js      带代理/限速/cookie 的 HTTP 客户端
src/auth.js      登录、cookie 导入、whoami、站点切换
src/gallery.js   列表页 / 详情页 HTML 解析 + URL 构造
src/pages.js     多页查看器：页链接解析、图片地址解析、showkey/重载
src/browse.js    搜索、热门、首页最新、watched、收藏、tag 补全
src/tags.js      本地标签字典查询（中文↔规范 tag，纯内存不联网）
src/download.js  图片下载（并发/断点续传/进度）、归档下载链接
src/store.js     本地存储：历史/搜索记录/订阅（JSON 文件，原子写）
src/subs.js      订阅轮询：拉新作品
src/index.js     MCP server（stdio），注册全部工具
```

## 站点与 URL
- EH  = `https://e-hentai.org`
- EXH = `https://exhentai.org`
- 搜索：`{site}/?f_search=<urlencoded>&page=<n>`，可加 `&f_cats=<bitmask>&advsearch=1`
- 列表页每 25 条：`.itg.gld .gl1t` 每个 gallery，`a[href]` 形如 `https://e-hentai.org/g/<gid>/<token>/`
- 详情页：`/g/<gid>/<token>/`，标签在 `#taglist tr`，`td.tc` 是 namespace，`div.tc a` 是 tag 值
- 多页：`/?p=<n>`；页链接来自 `#gdt .gdtm a` 或 `.gdtl a`，href 形如 `/s/<ihash>/<pageToken>-<n>`
- 图片页：`#img` 的 src 是图片，`#i3 a` 是重载链接（`?nl=`）、`#loadfail` 表示要重载；`showkey` 在 `#i6 a` 的 onclick 或 `#loadfail` 的 URL 参数里
- 归档：详情页 `#gd5` 有 `a` 指向 `/archiver.php?gid=..&token=..`；POST 该地址（`hathdl_xres=org|resample`，需 GP）
- 首页最新：`{site}/`（`.itg .gl1t`）
- 热门：`{site}/toplist.php?tl=<4h|1d|1w|1m|1y|all>`，结构同列表页
- 收藏：`{site}/favorites.php?favcat=<0-9|all>&page=<n>`
- 收藏内搜索（照抄 Ehviewer FavListUrlBuilder）：
  `{site}/favorites.php?favcat=<0-9|all>&f_search=<urlenc>&sn=on&st=on&sf=on&page=<n>`
  （sn=搜名称、st=搜标签、sf=搜收藏备注，三个都要给；`favcat=all` 表示全部槽位）
- 我的画廊：`{site}/watched`（需要登录）
- 标签搜索语法：直接把用户输入当 f_search 值即可，勿改写。

## 关键约定
1. **一切网络请求走 `http.js` 的 client**，不要直接用 fetch。`client.get(url, {query})` 返回 `{status, headers, text, finalUrl}`。
2. `client` 内部负责：代理（socks5:// / http://）、UA、Referer、cookie 同步、限速（默认 800ms/次）、429/5xx 退避重试 3 次、EH 的 "temporarily banned" 识别并抛 `class EHBlocked extends Error`。
3. **exhentai 无 cookie 会 302 回 e-hentai**：`client.get` 把真实 `finalUrl` 交给调用方判断；`auth.mode()` 返回实际可用站点。
   认证失效（302 回 EH / 跳 forums 登录 / sad panda / 200 空首页）时 `client` 会自己刷一次 `igneous` 并重放请求一次，
   仍失败则结果带 `needsRelogin: true`（`error` 是一行可行动中文，不带堆栈）。
4. 所有解析函数**不允许抛异常**：结构缺失时返回空数组/空字符串/null，并在 `warnings: []` 里记一句。
5. 所有导出函数都用 `async`；参数用对象解构。
6. 文件写盘一律原子写（`.tmp` + rename），路径用 `node:path`。
7. 不打印敏感信息：cookie 只在 `cookie_status` 里返回有效性布尔量与用户名。
8. 中文注释，英文标识符。
9. 每个模块提供 `export async function __selftest()`，供 `test/smoke.mjs` 调用。

## 统一数据结构
```js
// GalleryListItem
{ gid, token, url, title, category, posted, uploader, rating, pages, thumb, tagsPreview: string[] }

// GalleryDetail
{ gid, token, url, title, jtitle, category, posted, uploader, uploaderUrl, rating, pages, size,
  favorite: {name, slot} | null, tags: { [namespace]: string[] }, thumb, archiverUrl,
  torrents: [{name, url}], parent, visible, language, warnings: string[] }

// PageEntry
{ index, url, ihash, pageToken }

// ImageResult
{ index, url, reloadUrl, showKey, width, height, warnings: string[] }

// DownloadMeta（<dir>/<gid>-<token>/meta.json，v2；v1 仍可读，readMeta 会归一）
{ version: 2, gid, token, title, site,
  pages: [{ index, url, file, bytes, status }],   // status: downloaded | skipped | failed | cancelled
  startedAt, finishedAt,
  total, downloaded, skipped, failed, status, warnings,
  gallery: {...}, images: [{index,page,url,file,bytes,attempts,status,error?}] }  // 后两块是 v1 兼容

// DownloadResult
{ dir, downloaded, skipped, failed: [{index,url,page,file,error,attempts,kind,expected?,received?}],
  warnings: string[], cancelled: boolean }
```

## 工具命名（MCP tool names）
`eh_config_get` `eh_config_set` `eh_login` `eh_cookie_set` `eh_cookie_status` `eh_site_switch`
`eh_search` `eh_gallery` `eh_popular` `eh_recent` `eh_watched` `eh_favorites` `eh_fav_add`
`eh_pages` `eh_image` `eh_download` `eh_download_status` `eh_download_cancel` `eh_archive` `eh_sub_add` `eh_sub_list`
`eh_sub_remove` `eh_sub_check` `eh_history` `eh_tags` `eh_thumb`

返回给模型的 JSON 精简：列表最多 25 条/次，长文本截断 300 字，不带 HTML 原文。

## 导出签名（必须一字不差，index.js 按这个调用）

```js
// config.js
export const DEFAULTS                              // downloadDir 默认 ~/.dsh/eh-downloads，accountScoped: true
export const DEFAULT_DOWNLOAD_DIR                  // path.join(os.homedir(), '.dsh', 'eh-downloads')
export const LEGACY_DEFAULT_DOWNLOAD_DIR           // '<cwd>/downloads'（老配置照用，只给 warnings）
export function getConfigPath()
export async function loadConfig()                 // -> Config（额外带 warnings: string[]，不落盘）
export async function saveConfig(patch)            // -> Config（深合并 + 原子写；不带 warnings）
export async function ensureDownloadDir(dir)       // -> {ok, dir, warning?}；永不抛
export function downloadDirWarnings(dir)           // -> string[]；旧默认值提示
export function resolveDownloadDir(cfg, {memberId, site})
//   accountScoped !== false 时返回 <downloadDir>/<account>，account = exh-<memberId> | eh-<memberId> | anon
//   accountScoped === false 时返回 <downloadDir>

// http.js
export class EHBlocked extends Error
export async function createClient(cfg)            // -> client
// client.get(url, {query, headers, referer, redirect}) -> {status, headers, text, finalUrl}
// client.post(url, {form, headers, referer})         -> 同上
// client.setCookies(objOrString); client.getCookies() -> {}
// client.close()
// 失败时 error 是一行中文可行动提示（≤120 字，不贴堆栈）；exhentai 认证失效的响应额外带 needsRelogin: true

// auth.js
export function baseUrl(cfg, site)                 // site: 'e-hentai'|'exhentai'
export async function login({cfg, username, password})
export async function setCookies({cfg, cookieString, cookies})
export async function refreshIgneous({cfg, client, force, persist, sources})
//   -> {ok, changed, igneousLen, cached?, verified?, reason?}
//   只在论坛/e-hentai 下发新 igneous 时 changed:true；没下发但 exhentai 仍可进 → verified:true
//   60 分钟内成功刷过直接吃缓存（force 跳过）；persist:false 只改内存不落盘（测试用）；永不抛、不回传明文
export async function status({cfg, client})        // -> {loggedIn, username, memberId, site, gp, hathPerks, needsRelogin?}
export async function mode({cfg, client})          // -> 'exhentai' | 'e-hentai'
export async function switchSite({cfg, target})    // -> Config

// gallery.js
export function galleryUrl(gid, token, base)
export function buildSearchUrl(cfg, {query, page, category})
export function parseGalleryList(html, {base})     // -> GalleryListItem[]
export function parseTags(html)                    // -> {[ns]: string[]}
export function parseGalleryDetail(html, {base})   // -> GalleryDetail|null

// pages.js
export function parsePageEntries(html, {base})     // -> PageEntry[]
export async function listPages(client, {gallery, from, to})   // -> PageEntry[]
export async function resolveImage(client, pageUrl)            // -> ImageResult

// browse.js
export async function galleryDetail(client, {base, gid, token})
export async function search(client, {base, query, page, category})
export async function popular(client, {base, period})
export async function recent(client, {base})
export async function watched(client, {base})
export async function favorites(client, {base, cat, page, query})   // -> {items, site, warnings, url, cat, query}
export function buildFavoritesUrl(base, {cat, page, query})        // -> 收藏/收藏内搜索 URL
export async function favNotes(client, {base, cat, page})          // -> {notes:{[gid]:note}, site, warnings, url}
export async function parseFavNotes(html)                          // -> {notes, warnings}（纯解析，测试用）
export async function favAdd(client, {base, gid, token, slot})
export async function tagSuggest(client, {base, q})

// download.js
export const META_VERSION, MIN_FREE_BYTES
export async function downloadGallery({client, gallery, dir, concurrency,
  minFreeBytes, rateLimitBackoffMs, onProgress, _deps})   // -> DownloadResult
export async function archiveInfo(client, {gallery})
export async function requestArchive(client, {gallery, res, dryRun})
export async function fetchBinaryResult(url, opts)  // -> {buffer, headers, status, finalUrl}
export async function fetchBinary(url, opts)        // -> Buffer（老接口，保持不变）
export function cancelDownload(gid)                 // -> boolean；没有活跃任务返回 false
export function normalizeMeta(raw)                  // -> MetaV2 | null（v1 自动升）
export async function readMeta(dir)                 // -> MetaV2 | null

// store.js
export async function addHistory(entry); export async function listHistory({limit, type, query})
export async function addSearch(query);  export async function listSearch({limit})
export async function addSub(sub); export async function listSubs(); export async function removeSub(id)
export async function markSeen(id, ids)
export async function compactStore()   // -> {dir, history:{before,after,trimmed}, search:{...}, subs:{...}}
export async function stats()          // -> {dir, files:{history,search,subs,fav}, bytes, records, limits, warning?}

// fav.json（收藏夹本地缓存）：{version:1, updatedAt, items:[{gid,token,title,tags,note,cat}]}
export async function saveFavorites(items)          // 整份覆盖写；脏记录（无 gid）丢弃
export async function loadFavorites()               // -> {version:1, updatedAt, items}；缺失/损坏返回空壳
export async function searchFavorites(query, {limit})  // -> 精简条目[]；本地子串，支持 field:value 与 ns:value，不做正则

// tags.js —— 数据是 scripts/build-tags.mjs 生成的 src/tags-db.json（构建产物，随仓库走，运行时不联网）
//            外加手写口语别名表 src/tags-alias.json（目标 tag 必须在库里，坏条目载入时跳过）
export async function loadTags({path})            // -> {version, builtAt, namespaces, tags, zhIndex, warnings}
export function suggestTags(prefix, {ns, limit})  // -> string[]，形如 ["female:big breasts 巨乳"]
export function translate(text)                    // "巨乳" -> "female:big breasts"；查不到 null
export function expandQuery(query, {aliasPath})    // -> {query, replaced:[[from,to,source]], warnings}
export function aliasOf(word, {aliasPath})         // "NTR" -> "female:netorare"；查不到 null
export function listAliases({aliasPath})           // -> [{alias, tag}]
export async function loadAliases({path})          // -> {entries, warnings}
export function namespaceOf(tag)                   // "f:big breasts" -> "female"；无前缀 null
export function abbrOf(ns)                         // "female" -> "f"
export function allNamespaces()                    // -> [{ns, name, abbr, count}]
// expandQuery 顺序：别名（整词，最长优先）→ 中文反查（整词）→ 缩写展开；replaced[2] = 'alias'|'zh'|'abbr'
// suggestTags/translate/expandQuery 都是同步函数（内部惰性读一次 json 并建索引），永不联网；
// tags-db.json / tags-alias.json 缺失时返回空结构 + warnings，不抛。
// 重建字典：node scripts/build-tags.mjs（走 socks5://127.0.0.1:10808，幂等内容不重写，顺带校验别名表）

// subs.js
export async function checkSubs({client, base, cfg, _deps})
// -> [{id, query, newItems:[{gid,token,title,pages}], pagesFetched, lastError, error?}]
// newItems 是压缩后的四字段；早停规则：整页 gid 全在 seen / 短页 / 最多 3 页
export function compactItem(item)                  // -> {gid, token, title, pages}
```

## 环境事实（已实测）
- 直连 e-hentai / exhentai 不通；本机 sing-box 提供 SOCKS5 `127.0.0.1:10808`，经它访问 EF 返回 200，EXH 无 cookie 时 302。
- 默认 proxy 配置写 `socks5://127.0.0.1:10808`。
- 论坛 `forums.e-hentai.org` 目前对本机出口返回 Cloudflare `Just a moment...`（403），拿不到新 igneous；
  `refreshIgneous` 此时退化成「探一次 exhentai 确认旧值仍有效」（`verified: true`），真要换只能 `eh_login` 或从浏览器重导 cookie。
- EH 响应里会出现 `Set-Cookie: igneous=deleted`（作废占位值），不能当新值写回，否则等于自己把登录搞掉。

## 评论区与笔记（2026-11 追加）

```js
// gallery.js
export function parseComments(html)                  // -> {comments:[{id,at,author,score,text,votes}], warnings}
export async function galleryComments(client, {gid, token, base})
// -> {url, count, comments, warnings}
// 结构：详情页 `#cdiv > a[name=c<id>] + div.c1`；.c3 作者/时间、.c5 分数、.c6 正文、.c7 投票明细

// notes.js —— 线上/离线同一份库，按 gid 对齐
export async function saveNote({gid, token, title, note, rating, tags, source, url})  // -> rec
export async function getNote(gid)                   // -> rec|null
export async function removeNote(gid)                // -> boolean
export async function listNotes({limit, query})      // -> {items, total}
export async function stats()                        // -> {total, bySource, updatedAt}
```

存储：`<dataDir>/notes.json`（默认 `~/.dsh-eh/notes.json`），`{version:1, updatedAt, items:{[gid]:{...}}}`，整份原子写（tmp+rename）。同一本只保留最新一条，`note` 为空时拒绝（清空走 `removeNote`）。

浏览历史：`browse.galleryDetail()` 成功解析后追加 `{type:'view', gid, token, title, jtitle, pages, site, url}` 到 `history.jsonl`（fire-and-forget，失败不影响主流程），面板据此展示「agent 看过什么」。

坑：详情页**没有** `<link rel="canonical">`；旧解析从 `a[href*="/g/"]` 兜底会抓到 `#gdd` 里的 `Parent:` 链接，把 gid/页数带偏（4317228 被读成 4314307）。现在 `parseGalleryDetail(html,{gid,token})` 优先用调用方给的 id。
评论缓存：`eh_comments` 每次成功读取后会把这一本的评论快照写进 `<dataDir>/comments.json`（`{version, items:{[gid]:{gid, token, title, url, comments[], count, at}}}`），面板的详情页直接读它，所以断网也能看上次读到的评论。同一次请求里顺带解析标题（`galleryComments` 现在返回 `title`），不再二次拉详情页。
