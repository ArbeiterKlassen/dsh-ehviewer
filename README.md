# eh-mcp

给 agent 用的 e-hentai / exhentai MCP server（stdio，纯 ESM，无构建）。

工具面三层：契约里定死的 25 个核心工具 + 从 [Ehviewer_CN_SXJ](https://github.com/xiaojieonly/Ehviewer_CN_SXJ) 真实实现里移植的 9 个扩展（含 `eh_download_cancel`）+ 5 个一步到位的复合工具（`eh_find` / `eh_open` / `eh_read` / `eh_quick` / `eh_image_search`），共 **39** 个。

输出默认按 agent 习惯压缩（默认字段集、`limit=10`、`format="tsv"` 可选），真实调用示例与 token 数见 [docs/agent-usage.md](docs/agent-usage.md)。

---

## 功能一览

### 配置与登录

| 工具 | 用途 |
| --- | --- |
| `eh_config_get` | 读配置（cookie 只回名字与数量，不回值） |
| `eh_config_set` | 改配置并落盘（深合并） |
| `eh_login` | 账号密码登录，拿 `ipb_member_id` / `ipb_pass_hash` / `igneous` |
| `eh_cookie_set` | 直接导入 cookie 串或键值对象 |
| `eh_cookie_status` | 看 cookie 是否有效、登录的是谁、实际能走哪个站 |
| `eh_site_switch` | 在 `e-hentai` / `exhentai` / `auto` 之间切 |

### 浏览与搜索

| 工具 | 用途 |
| --- | --- |
| `eh_search` | 主力搜索：`mode=search/uploader/tag/watched`，支持分类掩码与高级搜索 |
| `eh_gallery` | 画廊详情（标题、tag、评分、归档、种子） |
| `eh_popular` | 热门：默认走 `/popular` 通栏页；传 `period` 走 `toplist.php`（除 `all` 外需登录） |
| `eh_recent` | 首页最新 |
| `eh_watched` | 我的画廊（需登录） |
| `eh_favorites` | 收藏夹（`cat=0..9` / `favdel`） |
| `eh_fav_add` | 加收藏到指定槽位 |

### 看图与下载

| 工具 | 用途 |
| --- | --- |
| `eh_pages` | 列多页查看器链接（支持 `from`/`to` 区间） |
| `eh_image` | 解析看图页 → 真图片地址（含 showkey/重载） |
| `eh_thumb` | 直接回图片二进制给模型看（自动带 cookie + Referer） |
| `eh_download` | 整本下载（并发 + 断点续传 + 短包校验） |
| `eh_download_status` | 看本进程内下载进度（running / cancelling / done / cancelled / failed） |
| `eh_download_cancel` | 取消正在跑的下载（已下完的保留，meta 标 cancelled，下次可续） |
| `eh_archive` | 归档信息 / 下归档（GP） |

### 订阅、历史与 tag

| 工具 | 用途 |
| --- | --- |
| `eh_sub_add` / `eh_sub_list` / `eh_sub_remove` / `eh_sub_check` | 搜索式订阅：存下来、列出、删除、只拉新作品 |
| `eh_history` | 本地历史（浏览 / 搜索 / 下载） |
| `eh_tags` | tag 补全（本地字典优先：中文可直接联想，如 `巨乳` → `female:big breasts`） |

本地标签字典来自 [EhTagTranslation/Database](https://github.com/EhTagTranslation/Database)，编译产物 `src/tags-db.json` 随仓库走，运行时只读不联网。口语说法（中文 / 汉化 / 无码 / NTR / 黑丝…）走手写的 `src/tags-alias.json`，目标 tag 在载入时校验，不存在的条目会被跳过。库里变动时重建一次：

```bash
node scripts/build-tags.mjs        # 走 socks5://127.0.0.1:10808，12 个命名空间，约 4.5 万条；顺带校验别名表
node test/_t_tags.mjs              # 离线验证，期望 PASS n/0
```

### 收藏夹与本地库

| 工具 | 用途 |
| --- | --- |
| `eh_favorites` | 收藏夹列表（`cat`=0~9/`all`/`favdel`），`query` 走站点内搜（`f_search`+`sn/st/sf`），`cache=true` 把这页存进本地缓存 |
| `eh_fav_local` | 断网可用：搜已缓存收藏，支持 `title:` `tags:` `note:` `gid:` `cat:` 前缀 |
| `eh_local_index` | 扫下载目录建索引（`action=rebuild` 增量 / `stats` 看统计） |
| `eh_local_search` | 在下好的画廊里搜：裸关键词、`ns:value`（`f:big breasts` 与 `female:"big breasts"` 等价）、`/正则/`、`tag:/re/`、`-排除`、`|` 或、`sort`（`-size` / `pages` / `title`） |

本地索引落在 `~/.dsh-eh/library.json`（≈512 B/条，500 条约 250 KB）。增量判据是目录 + `meta.json` 的 mtime/size：500 条首次约 450 ms、二次增量约 130 ms、单次查询约 0.6 ms。下载落盘的 `meta.json`（v2）里 `gallery` 块含 `title/titleJpn/uploader/tags/site/category`，所以 tag 与作者都能搜；老目录缺这块就搜不到 tag，重下一次即可。

### 本地面板（DSH-EH）

只读的本地浏览面板，跟 MCP 进程分开跑：`node panel/server.mjs --port 7712`（只绑 `127.0.0.1`，端口被占自动顺延，最多 +10，启动后打印真实地址；`--data` / `--root` 可换数据目录与下载根）。
数据只读 `~/.dsh-eh/` 下的 `history.jsonl`（浏览/下载/搜索记录）、`notes.json`（笔记）、`library.json`（本地库索引），封面图从下载根目录（默认 `~/.dsh/eh-downloads`）取，越界路径一律 403。

DSH 里点侧边栏的 **DSH-EH** 就能在窗口内打开它（`dsh-eh-panel` 插件注册的 `main` 面板，iframe 嵌 7712，服务没起会自动拉起）。

配色跟着 DSH 本体走：内嵌时由 `dsh-eh-panel` 把 8 个颜色变量（`--eh-bg` / `-bg-elev` / `-bg-hover` / `-border` / `-text` / `-text-dim` / `-accent` / `-accent-dim`）从 DSH 的真实 token 里取出来 postMessage 下发，`mode` 取自 `body[data-ds-dark-theme]`；切主题即时生效。单独用浏览器打开时按 `prefers-color-scheme` 自己判断。
面板现在分三组：**浏览**（主页 / 热门 / 收藏 / 订阅 / 搜索）、**本地**（看过 / 下载 / 笔记 / 本地库）、**设置**（账号与配置）。浏览类页面直接复用 MCP 的 cookie 与限速，卡片上带站点原样的 `category` 角标（叙事类 / 差分类 / 真人各一色，`Misc`、`Non-H` 带 hover 说明）。

账号与配置页可以做账号密码登录、粘贴 cookie、切站点、改代理 / 下载目录 / 账号分层 / 并发与限速；cookie 只显示键名与长度，写盘后 MCP 下次调用自动生效。
阅读器在面板里，不再跳浏览器：本地有下载就优先读本地文件，没有就走在线（`panel/online.mjs` 复用同一份 config / cookie / 代理 / 解析器，20 页一个窗口懒加载）。← → 翻页、Home/End 首尾、Esc 回详情、宽屏可双页；顶部只有「在源站打开 ↗」一个出口会交给系统浏览器。


### 分类与阅读策略（agent 必读）

站点只有 11 个分类，`category` 字段在搜索、列表、`eh_gallery`、`eh_download`、历史、本地库搜索里都会带出来，值就是站点原样写法：

| 分类 | 内容特点 | 建议的读法 |
| --- | --- | --- |
| `Doujinshi` | 同人志，连续分镜叙事 | **逐页读**（`eh_pages` 全量 or 分段 20） |
| `Manga` | 商业志/连载，同样连续 | **逐页读** |
| `Artist CG` | 画师图集，大量近似差分 | **跳页读**：先看 1、中间、最后，再抽查 |
| `Game CG` | 游戏 CG 抽出，差分多 | **跳页读** |
| `Image Set` | 图集/合集，顺序常无叙事 | **跳页读** |
| `Cosplay` | 真人照片 | 跳页读，除非要找特定造型 |
| `Asian Porn` | 真人照片/影像截图 | 跳页读 |
| `Western` | 欧美同人/图集，质量参差 | 先看标题与页数，再决定逐页或跳页 |
| `Non-H` | 非成人内容 | 非本任务目标时直接跳过 |
| `Misc` | **AI 生成居多**、杂项 | 默认可跳过，除非标题明确相关 |
| `Unknown` | 站点没标 | 看标题/页数判断 |

跳页读的具体做法：`eh_pages { gid, token, from: 1, to: 3 }` 看开头，再取中间与结尾各 2~3 页；确认是同一套构图就停，别为了一张差分把整本翻完。

`eh_download` 返回里也带 `category`，历史记录同样有，所以「下过什么、属于哪类」是可以离线检索的。

### 评论与笔记

| 工具 | 用途 |
| --- | --- |
| `eh_comments` | 读这本的在线评论：作者、时间、评分、正文（`full=true` 连带投票明细）。没下载过也能读，走详情页 `#cdiv` |
| `eh_note_save` | 写感想：`note` 必填，可选 `rating`(1~10) / `tags` / `source`(`online`/`local`) / `title` / `token` |
| `eh_note_list` | 列 / 搜笔记（`query` 匹配标题、正文、tag），新的在前 |
| `eh_note_remove` | 删笔记（按 gid） |

`eh_comments` 读过的评论会缓存到 `~/.dsh-eh/comments.json`（每本留最新一份），面板断网也能看。

笔记存在 `~/.dsh-eh/notes.json`，线上看的和下载后看的是同一份，按 `gid` 对齐，所以面板里一本只会有一条。看完一本顺手记一句，比攒着写长评实际。

另外，任何一次成功打开详情页（`eh_gallery` / `eh_open` / `eh_read` / 下载前的元数据补全）都会往 `~/.dsh-eh/history.jsonl` 记一条 `type:'view'`，这就是「agent 看过什么」的数据源。

### 移植自参考仓库的扩展

| 工具 | 来源 | 用途 |
| --- | --- | --- |
| `eh_toplists` | `toplist.php` | 排行榜，`tl` + 翻页 `p`（0~199）。**未登录只有 `tl=all` 能用**，其余周期站点直接回 “Non-existing toplist” |
| `eh_uploader` | `/uploader/<名字>` | 某个上传者的全部作品 |
| `eh_tag_page` | `/tag/<tag>` | 站点原生 tag 页，比 `f_search` 更接近点 tag 链接 |
| `eh_batch_meta` | `api.php` → `gdata` | 一次最多 25 个 gid+token，批量补标题/tag/评分/体积/种子数 |
| `eh_mytags` | `/mytags` | 站点记录的「我用过的 tag」，需登录 |
| `eh_filter_list` / `eh_filter_add` / `eh_filter_remove` | `EhFilter` | 本地标题/tag/上传者黑名单；`eh_search` 带 `filter=true` 时生效 |

---

## 给 agent 的省 token 用法（先看这节）

列表类工具默认为 **4 个字段 / 10 条 / 不带 url·thumb·tagsPreview**。要更多再加参数：

| 参数 | 作用 | 默认 |
| --- | --- | --- |
| `fields` | 逗号分隔要回的字段，如 `"gid,title,pages,rating"` | `gid,token,title,pages`（`eh_find` 多 `category`） |
| `format` | `json`（紧凑无缩进）/ `tsv`（首行表头，一行一条） | `json` |
| `limit` | 返回条数 | 10（最大 50） |
| `offset` | 跳过前 N 条；`hasMore=true` 时 body 里有 `nextOffset` | 0 |

返回体统一成 `{tool, site, count, hasMore, items}`：`site` 是**这次实际生效**的站点（`exhentai` / `e-hentai`），
不是配置里的 `auto`。`null` / 空串 / 空数组字段直接不出现，`warnings` 只在非空时出现。
`url` 不回——`gid + token` 就能拼 `{site}/g/<gid>/<token>/`。

### 一步到位

| 工具 | 一次调用干完什么 | 什么时候用 |
| --- | --- | --- |
| `eh_quick` | 登录状态 + 首页最新 5 条 + 订阅新作 | 会话开场 |
| `eh_find` | 搜索 + gdata 批量补全 → 精简列表 | 找本第一步 |
| `eh_open` | 详情 + 前 N 页图片直链 | 要下载/看图前 |
| `eh_read` | 详情 + 封面与前几页真图（image content） | 想先看看内容 |
| `eh_image_search` | 以图搜图（`path` 本地 / `url` 远程，multipart 上传） | 手上有图没出处 |

省 token 的典型组合（省掉 2~3 次往返）：

```text
eh_quick {}                                 → 三合一，≈180~420 token
eh_find  {query, limit:10, format:"tsv"}    → 10 条，≈385 token（JSON 同内容 ≈570）
eh_open  {gid, token, pages:3}              → 详情 + 3 条直链，≈205 token
eh_gallery {gid, token}                     → 精简元数据，≈70 token（full:true 才有完整 tag/警告）
```

### 高级搜索（对齐手机端面板）

`eh_search` 的 `adv` 用站内真实字段，出现任意一项就自动带 `advsearch=1`：

```text
name→f_sname  tags→f_stags  desc→f_sdesc  torrentName→f_storr  withTorrents→f_sto
expunged→f_sh lowPower→f_sdt1 downvoted→f_sdt2
disableLang→f_sfl disableUploader→f_sfu disableTags→f_sft
minRating→f_sr+f_srdd(1..5)   pageFrom/pageTo→f_sp+f_spf/f_spt
```

旧名 `torr/del/exp/lang/uploader/fav` 仍收（映射到同一批字段）。`category` 十项走 `toFCats` 取反：
`doujinshi / manga / artistcg / gamecg / western / nonh / imageset / cosplay / asianporn / misc`。

---

## 安装

```bash
cd D:/DSHQQ/eh-mcp
npm install          # 依赖已锁在 package-lock.json
node test/smoke.mjs       # 离线冒烟：39/39 工具 + URL 构造 + 过滤规则往返
node test/_t_compact.mjs  # 离线：字段裁剪 / tsv / limit·offset / 空值省略 / 复合工具
```

依赖：`@modelcontextprotocol/sdk`、`cheerio`、`undici`、`socks-proxy-agent`。

要求 Node ≥ 20（实测 v23.10.0），项目是纯 ESM（`"type": "module"`），没有 TS 构建步骤。

---

## 配置：`~/.dsh-eh/config.json`

`eh_config_set` 就是写这个文件；手改也行，下次调用自动读到。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `site` | `"auto"` | `auto` / `e-hentai` / `exhentai`。`auto` 会探测 exhentai 是否可用（结果缓存 5 分钟） |
| `proxy` | `"socks5://127.0.0.1:10808"` | 支持 `socks5://`、`socks4://`、`http://`；空串 = 直连 |
| `cookies` | `{}` | 键值对象，登录/导入后自动填；常用键 `ipb_member_id`、`ipb_pass_hash`、`igneous` |
| `downloadDir` | `~/.dsh/eh-downloads`（Windows：`C:\Users\<用户名>\.dsh\eh-downloads`） | 下载根目录，每本一个子目录 |
| `accountScoped` | `true` | 按账号分子目录：`exh-<memberId>` / `eh-<memberId>` / `anon`；关掉就全部平铺在 `downloadDir` 下 |
| `concurrency` | `4` | 下载并发（1~16） |
| `rateLimitMs` | `800` | 每次请求最小间隔，调小容易被 ban |
| `userAgent` | 桌面 Chrome | 站点对移动端 UA 用另一套页面结构，别乱改 |
| `dataDir` | `~/.dsh-eh` | 历史/搜索/订阅 JSON 的目录 |

最小可用配置：

```json
{
  "site": "auto",
  "proxy": "socks5://127.0.0.1:10808",
  "cookies": {},
  "downloadDir": "~/.dsh/eh-downloads",
  "accountScoped": true,
  "concurrency": 4,
  "rateLimitMs": 800
}
```

---

## 登录：两种姿势

### 姿势一：账号密码（推荐首次用）

```
eh_login { username, password }
```

走 `https://forums.e-hentai.org/index.php?act=Login&CODE=01`，成功后把 `ipb_member_id` / `ipb_pass_hash` / `session_id` 存进配置；再访问一次 exhentai 拿 `igneous`。

### 姿势二：直接塞 cookie（不想给密码时）

```
eh_cookie_set { cookieString: "ipb_member_id=xxx; ipb_pass_hash=yyy; igneous=zzz" }
```

浏览器 F12 → Application → Cookies，把 e-hentai（或 exhentai）域下的这三个键抄过来即可。键值对象形式也收：

```
eh_cookie_set { cookies: { ipb_member_id: "xxx", ipb_pass_hash: "yyy", igneous: "zzz" } }
```

验证：`eh_cookie_status` → 看 `loggedIn` 与 `site`。`site` 是 `e-hentai` 说明 exhentai 还进不去（多半缺 `igneous`）。

---

## 在 DSH 里注册

```jsonc
mcp_connector_configure {
  "name": "eh-mcp",
  "transport": "stdio",
  "command": "node",
  "args": ["D:/DSHQQ/eh-mcp/src/index.js"]
}
```

注册后工具名会带前缀（如 `mcp__eh-mcp__eh_search`），直接对 agent 说「搜 xxx 的本子」就会命中。

启动时 stderr 会打一行 `[eh-mcp] v0.2.0 已启动 · 工具 39/39 个 · node v23.10.0`，以及任何缺失模块的警告。stdout 只走 MCP 协议，不掺日志。

---

## 移植自参考仓库的能力

`src/reference-notes.md` 是从 [Ehviewer_CN_SXJ](https://github.com/xiaojieonly/Ehviewer_CN_SXJ) 的 `com.hippo.ehviewer.client` 里逐条抠出来的真实实现，落地成下面这些：

1. **列表 URL 构造**（`ListUrlBuilder` 等价物）—— `eh_search` 的 `mode` / `category` / `adv` 全部映射到站点的真实参数：
   - 搜索：`?f_search=<enc>&page=<n>&f_cats=<(~cats)&1023>`
   - 上传者：`/uploader/<enc name>[/<page>]`
   - tag：`/tag/<enc tag>[/<page>]`
   - 高级搜索：`advsearch=1` + `f_sname/f_stags/f_sdesc/f_storr/f_sto/f_sh/f_sfl/f_sfu/f_sft`、`f_sr+f_srdd`、`f_sp+f_spf/f_spt`
   - **分类掩码是取反语义**（`f_cats = (~cats) & ALL_CATEGORY`，`ALL_CATEGORY = 1023`）：传进来的 `category` 是「想看哪些」，出门时取反。
2. **gdata 批量元数据** —— `eh_batch_meta` POST `api.php`，`{"method":"gdata","gidlist":[[gid,token],...],"namespace":1}`，每批上限 25 条。
3. **归档三步** —— `eh_archive` 的 `info` 只读 `/archiver.php`，`request` 才会真下单（耗 GP）。
4. **登录三件套** —— `ipb_member_id` / `ipb_pass_hash` / `igneous`，缺 `igneous` 时 exhentai 一律 302 回 e-hentai。
5. **排行榜 / 我的 tag / 上传者页** —— `eh_toplists`、`eh_mytags`、`eh_uploader`、`eh_tag_page`。
6. **本地过滤（EhFilter）** —— `eh_filter_*` 存 `~/.dsh-eh/filters.json`（原子写），`eh_search` 的 `filter=true` 在结果上做标题/tag/上传者的子串剔除。

> 参考仓库里自己的 CBOR spider 后端没有照搬——我们只走标准 HTTP。

---

## 常见坑

- **exhentai 必须要有 `igneous`**。只给 `ipb_member_id` + `ipb_pass_hash` 时，exhentai 会 302 回 e-hentai；`eh_cookie_status` 的 `site` 会显示 `e-hentai`，别以为是登录失败。
- **图片必须带 Referer**。缩略图/大图都按 Referer 防盗链，`eh_thumb` 默认补站点首页；自己写请求时别漏。
- **GP 归档要先看价格**。`eh_archive action=request` 会真花 GP，先 `action=info` 看清再下单；没 GP 时站点只给 H@H 提示。
- **IP ban**。短时间内大量请求会拿到 `temporarily banned`，本 server 会识别成 `EHBlocked` 并回一句人话。等 10~30 分钟，或换代理；`rateLimitMs` 调到 1200+ 更稳。
- **exhentai 有里站专属内容**，但它对 cookie 更挑；`site=auto` 探测失败会自动回落到 e-hentai，不会整个工具挂掉。
- **看图是两跳**：先 `eh_pages` 拿 `/s/<ihash>/<token>-<n>`，再 `eh_image` 才换成真图片地址。直接对 `/g/` 详情页调 `eh_image` 解不出东西。
- **排行榜的 `4h/1d/1w/1m/1y` 需要登录**。没登录时站点返回 “Non-existing toplist”，本 server 会翻成一句人话并提示改用 `tl=all`。
- **排行榜 / `/popular` 不是网格布局**。它们是通栏表格页，没有 `.gl1t`，`eh_toplists`/`eh_popular` 在常规解析为空时按 `/g/<gid>/<token>/` 链接兜底抽取，标题取自链接文本（`<div class="tun"><a>标题</a></div>`）；这类页面的分类/缩略图/页数仍为空，需要细节就再对单个 gid 调 `eh_batch_meta` 或 `eh_gallery`。
- **`eh_download` 的进度只在本进程内**。MCP server 重启后 `eh_download_status` 会空，但文件还在：断点续传按 `meta.json`（v2）里记的字节数判断——大小对得上才算下完，被截断的会重下。没有 meta 的老目录退化为「非空即跳过」。
- **下载会自查三件事**：`content-length` 与实际字节（短包重试 3 次后进 `failed.json`，不拖累其它图）、目标盘剩余空间（<200MB 直接拒绝）、429 / temporarily banned（并发临时减半 + 退避 5s，写进 `warnings`）。

---

## 语义约定（踩过坑，写在前面）

1. **`category` 是「想要哪些分类」**，不是站点原生的 `f_cats`。内部按参考实现取反：`f_cats = ALL_CATEGORY(1023) & ~want`。传 `"doujinshi"` / `"doujinshi,manga"` / 位掩码都行。
2. **列表页的 `pages` 可能为 `null`**：站点只在部分行渲染 `N pages`，且上传者昵称尾部的数字会粘上来（`TMDlixin250` + `37 pages` → 曾误解析成 25037）。解析器已用左边界断言修掉，拿不到就老实返回 `null`，要准确页数用 `eh_batch_meta` / `eh_gallery`。
3. **`eh_pages` / 下载在页数未知时会一直翻到最后一屏**（空屏或不足 20 条即停），不会只拿第一页。
4. **`eh_download` 的并发/续传**：文件名 `001.webp` 递增，已存在且非空即跳过；`meta.json` 记下每张图的源 URL，`failed.json` 记失败项。
5. **`eh_archive action=request` 才下单**（默认 `dryRun` 只在 `info` 生效），另外 `request` 会真的消耗 GP。

## 已验证（真机、走 SOCKS5 代理）

- 搜索 25 条 / 详情解析（标题·页数·体积·评分·tag·归档链接）/ 多页链接 / 图片直链（185 字符带 keystamp，780×1200）
- `batchMeta`（`api.php` gdata）批量补全：体积、发布时间、tag（`ns:value` 数组）
- 完整下载 13 张（并发 3、0 失败），断点续传与 `meta.json` 落盘正常
- `eh_toplists(tl=all)` 37 条、`eh_popular` 71 条、`eh_thumb` 返回 `image/webp`
- 二进制通道：`client.getBinary()`（`http.js` 已内置），`eh_thumb` / 下载共用同一条代理链路
- 收藏夹：`eh_favorites(cat=0)` 列表 / `query` 站内搜（`takoro` 命中 1）/ `cache=true` 落缓存 → `eh_fav_local` 断网搜（`pixiv` 命中 3）
- 本地库：下载落 `C:\Users\deepd\.dsh\eh-downloads\exh-6829692\4317228-0a20c864cf`（11 张，meta 含 30 个 tag），`eh_local_search` 支持 `female:big breasts`（未加引号也能并）、`f:big breasts`、`character:astra yao`、`/pixiv|短篇/`
- 全套测试：smoke 46/46、`_t_core` / `_t_local` 56 / `_t_fav` 38 / `_t_dl` 78 / `_t_dl2` 58 / `_t_tags` 36 / `_t_comments` 11 / `_t_auth2` / `_t_compact` 全绿
