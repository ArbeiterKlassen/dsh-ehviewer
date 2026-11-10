# 给 agent 的调用示例（eh-mcp 0.2）

所有示例都是真机跑出来的（走 `socks5://127.0.0.1:10808`，登录态 exhentai）。
「≈N tok」是按 `中文字数 + 其他字符/3.6` 粗估的，用来横向比较，不是账单。

先说结论：**开场 `eh_quick`、找本 `eh_find`、要图 `eh_open`、看内容 `eh_read`**。
四个复合工具把「搜索 → 补元数据 → 详情 → 翻页 → 解析图片」这些往返压成了一次调用。

---

## 0. 输出约定（先记住这个，能省一半 token）

- 列表返回体固定 `{tool, site, count, hasMore, items}`；`hasMore=true` 时多一个 `nextOffset`。
- `site` 是**这次实际生效**的站点（`exhentai` / `e-hentai`），不是配置里的 `auto`。
- 默认字段：`gid,token,title,pages`（`eh_find` 多一个 `category`）。
- `null` / 空串 / 空数组的字段直接不出现；`warnings` 只在非空时出现。
- `url` 不回：`gid + token` 自己拼 `{site}/g/<gid>/<token>/`。
- 通用参数：`fields="gid,title,rating"`、`format="tsv"`、`limit`（默认 10，上限 50）、`offset`。

---

## 1. `eh_quick` —— 会话开场（1 次调用 = 3 件事）

```json
{"tool":"eh_quick"}
```

```json
{"tool":"eh_quick","site":"exhentai","loggedIn":true,
 "recent":[{"gid":"4317739","token":"96777ea1a8","title":"[Machina Ai] Chie Hoshinomiya | 星之宮知恵 Extra 214p (Patreon) [AI Generated]","pages":214}],
 "subs":{"count":1,"newCount":3,"items":[{"sub":"female:\"sole female\"$ language:chinese$","gid":"4317599","title":"..."}]}}
```

- 733 B ≈ **183 tok**（订阅没有新作时）到 1581 B ≈ **421 tok**（有 3 条新作时），约 2~3 s（登录探测 + 首页 + 每条订阅一次搜索）。
- 取代了以前「`eh_cookie_status` → `eh_recent` → `eh_sub_check`」三次调用（≈3 次往返、3 份 JSON）。

---

## 2. `eh_find` —— 找本第一步（搜索 + gdata 补全）

```json
{"tool":"eh_find","query":"language:chinese$","limit":10}
```

```json
{"tool":"eh_find","site":"exhentai","count":10,"hasMore":true,"nextOffset":10,
 "items":[{"gid":"4317645","token":"a1159d5aac","title":"全球冰封：我在末日庇护所养母畜 [中文插画小说] Vol.3 [AI Generated]","pages":33,"category":"Misc"}]}
```

- 2083 B ≈ **573 tok**，约 2.2 s（1 次列表页 + 1 次 gdata 批量）。
- 以前：`eh_search`（25 条、带 url/thumb/tagsPreview）≈ 3~4k tok，再 `eh_batch_meta` 又一份。

## 3. `eh_find` + `format:"tsv"` —— 只要一张表

```json
{"tool":"eh_find","query":"language:chinese$","limit":10,"format":"tsv"}
```

```text
gid	token	title	pages	category
4317645	a1159d5aac	全球冰封：我在末日庇护所养母畜 [中文插画小说] Vol.3 [AI Generated]	33	Misc
4317643	68f26d8464	在介绍所里请多加小心（梅露可物语）	16	Doujinshi
```

- 1418 B ≈ **385 tok**（比同内容 JSON 省 ~33%），首行是表头，列序 = `fields`。

---

## 4. `eh_open` —— 详情 + 前 N 页图片直链

```json
{"tool":"eh_open","gid":4317643,"token":"68f26d8464","pages":3}
```

```json
{"tool":"eh_open","site":"exhentai","gid":"4317643","token":"68f26d8464",
 "title":"在介绍所里请多加小心（梅露可物语）","pages":16,"count":3,
 "images":["https://suxhcje....hath.network:37890/h/...keystamp=.../00000001.webp"]}
```

- 729 B ≈ **205 tok**，约 3.7 s（详情 1 + 多页视图 1 + 每页解析 1）。
- 图片直链带 `keystamp`，**有时效**，拿到就立刻下载。

---

## 5. `eh_gallery` —— 只要元数据（最省）

```json
{"tool":"eh_gallery","gid":4317643,"token":"68f26d8464"}
```

```json
{"tool":"eh_gallery","site":"exhentai","gid":"4317643","token":"68f26d8464","title":"在介绍所里请多加小心（梅露可物语）",
 "category":"Doujinshi","pages":16,"size":"71.58 MiB","rating":1.57,"language":"Chinese TR","tagsCount":13}
```

- 244 B ≈ **71 tok**（以前 ~800 字，含完整 tag 与解析警告）。
- 要完整 tag 与警告才加 `"full":true`（371 B ≈ 108 tok）。

---

## 6. `eh_search` —— 带分类 + 高级条件（对齐手机端面板）

```json
{"tool":"eh_search","query":"language:chinese$","category":"doujinshi,manga",
 "adv":{"minRating":4,"pageFrom":10},"limit":5}
```

```json
{"tool":"eh_search","site":"exhentai","count":5,"hasMore":true,"mode":"search",
 "items":[{"gid":"4317613","token":"4b7aa7fe68","title":"デイドリームメモリ","category":"Doujinshi"}]}
```

- 923 B ≈ **233 tok**，约 0.6 s。
- `adv` 的键就是面板上的开关，出现任意一项自动带 `advsearch=1`：
  `name/tags/desc/torrentName/withTorrents/expunged/lowPower/downvoted/disableLang/disableUploader/disableTags`（布尔）、
  `minRating`（1~5）、`pageFrom/pageTo`（页数区间）。
  旧名 `torr/del/exp/lang/uploader/fav` 仍收，映射到同一批站内字段。
- `category` 写「想要哪些」，取反（`f_cats`）在 `gallery.toFCats` 里做。

---

## 7. `eh_toplists` / `eh_popular` —— 扫热度

```json
{"tool":"eh_toplists","tl":"all","limit":5}
```

```json
{"tool":"eh_toplists","site":"exhentai","count":5,"hasMore":true,"nextOffset":5,"tl":"all","p":0,
 "items":[{"gid":"596447","token":"3894f02c20","title":"[LemonFont] Shapeshifter Part 1-3"}]}
```

- 510 B ≈ **150 tok**。
- 注意：`toplist.php` **只在 e-hentai 有**，EXH 上一律 404；本 server 在 EXH 会话里会用 EH 主机去取。
- `eh_popular` 不传 `period` 走 `/popular`（两边都有），传 `4h/1d/1w/1m/1y/all` 走排行榜（除 `all` 外要登录）。

---

## 8. `eh_tags` —— 本地 tag 补全（零网络）

```json
{"tool":"eh_tags","q":"巨","limit":5}
```

```json
{"tool":"eh_tags","count":5,"hasMore":false,"source":"local",
 "items":[{"tag":"female:growth 巨大化"},{"tag":"female:giantess 女巨人"},{"tag":"female:big breasts 巨乳"}]}
```

- 253 B ≈ **80 tok**，几毫秒（本地 `tags-db.json`，44861 条）。
- `ns:"female"` 限命名空间；`aliases:true` 列中文/口语别名表（`{"alias":"NTR","tag":"female:netorare"}`）。
- 本地查不到才回站点 `tagSuggest`（`source:"site"`）。

---

## 9. `eh_read` —— 先看看这本是什么

```json
{"tool":"eh_read","gid":4317643,"token":"68f26d8464","count":2}
```

```json
{"tool":"eh_read","site":"exhentai","gid":"4317643","title":"在介绍所里请多加小心（梅露可物语）",
 "category":"Doujinshi","pages":16,"size":"71.58 MiB","rating":1.57,"tagsCount":13,"images":2}
```

- 文字 226 B ≈ **66 tok**；图片按像素另算（2 张 ≈ 2~3k tok），所以 `count` 默认 3、要省就传 1。
- 图源：封面 + 前几页真图（`#gdt` 里只有懒加载占位符，小图拿不到）。

---

## 10. `eh_image_search` —— 手上有图没出处

```json
{"tool":"eh_image_search","path":"D:/tmp/a.webp","limit":5}
```

```json
{"tool":"eh_image_search","site":"e-hentai","count":1,"hasMore":false,
 "items":[{"gid":"4317643","token":"68f26d8464","title":"在介绍所里请多加小心（梅露可物语）","category":"Doujinshi"}],
 "uploaded":"a.webp"}
```

- 229 B ≈ **60 tok**，但耗时长（≈14 s，上传 400 KB 走代理）。
- 上传接口会 302 到 `?f_shash=...` 结果页，server 自己跟跳转后按普通列表页解析。
- EXH 的上传端点常年 TLS 握手被掐，会自动回落 `upld.e-hentai.org`（此时 `site` 会显示 `e-hentai`）。

---

## 11. 分页与翻页

```json
{"tool":"eh_recent"}
→ {"count":10,"hasMore":true,"nextOffset":10}

{"tool":"eh_recent","offset":10}
→ 下 10 条
```

- `hasMore` 只表示**已取回的这页**里还有没有；到站点下一页要自己加 `page`（`eh_search`/`eh_toplists`/`eh_favorites`）。

---

## 12. 组合套路（照抄）

| 目标 | 调用序列 |
| --- | --- |
| 开场摸底 | `eh_quick {}` |
| 找本并挑一本 | `eh_find {query,limit:10}` → `eh_gallery {gid,token}` |
| 直接看内容 | `eh_find` → `eh_read {gid,token,count:2}` |
| 下载 | `eh_find` → `eh_open {gid,token,pages:1}`（验图链）→ `eh_download` |
| 追更新 | `eh_quick`（含订阅新作）→ 有新的再 `eh_find` 细看 |
| 按 tag 深挖 | `eh_tags {q:"fem"}` → `eh_tag_page {tag}` |
| 以图找源 | `eh_image_search {url}` → `eh_gallery` |

---

## 坑（实测）

- `eh_find` 的 `enrich:false` 跳过 gdata，只回列表页本身有的字段（最快，但 `rating/size` 没有）。
- `eh_read` 的图是**真图**，不是缩略图；`count` 调到 3 就明显吃 token。
- `eh_open` 的直链有 `keystamp`，几分钟后就失效，别存着以后用。
- 排行榜在 EXH 会话里走 EH 主机，返回的 `url` 是 `e-hentai.org`，属正常。
- 所有工具的 `warnings` 只在非空时出现，别按固定位置取。

## 按分类决定读多少页

`category` 现在在所有列表、详情、下载返回、历史与本地库里都有。拿到它就别再一刀切地整本翻：

- `Doujinshi` / `Manga` → 连续叙事，逐页读值得。
- `Artist CG` / `Game CG` / `Image Set` → 差分画廊，抽 1、中间、最后各 2~3 页就够（`eh_pages {from,to}`）。
- `Cosplay` / `Asian Porn` → 照片，跳页。
- `Misc` → AI 生成居多，默认可跳过。
- `Non-H` → 与成人向任务无关时直接跳过。
- `Western` / `Unknown` → 看标题和页数再定。

判断「是不是同一套构图」比数页数更省：先取 3 页，如果人物/机位几乎一致，后面大概率也是差分。
