# 移植笔记（来源：xiaojieonly/Ehviewer_CN_SXJ，本地副本 <参考仓库本地副本>）

所有结论都来自该仓库 `app/src/main/java/com/hippo/ehviewer/client/` 下的真实实现，可直接照抄。

## 1. 站点常量（EhUrl.java）
```
DOMAIN_E  = e-hentai.org        DOMAIN_EX = exhentai.org
HOST_E    = https://e-hentai.org/    HOST_EX = https://exhentai.org/
API_E     = HOST_E+"api.php"          API_EX  = HOST_EX+"api.php"
URL_POPULAR_E   = https://e-hentai.org/popular      （"what's hot"，通栏大图）
URL_TOP_LIST_E  = HOST_E+"toplist.php"              参数 tl=<4h|1d|1w|1m|1y|all>，翻页 &p=<n>（n<200）
URL_WATCHED_E   = HOST_E+"watched"
URL_FAVORITES_E = HOST_E+"favorites.php"
URL_MY_TAGS_E   = HOST_E+"mytags"
URL_UCONFIG_E   = HOST_E+"uconfig.php"
URL_IMAGE_SEARCH_E = https://upld.e-hentai.org/image_lookup.php   （multipart 上传，反查）
API_SIGN_IN     = https://forums.e-hentai.org/index.php?act=Login&CODE=01
```
缩略图前缀：EH `https://ehgt.org/`，EXH `https://exhentai.org/t/`。

## 2. 列表页 URL 构造（data/ListUrlBuilder.java）
- 普通搜索：`{host}?f_search=<urlenc>[&page=<n>][&f_cats=<(~cats)&ALL_CATEGORY>]`
- 上传者：`{host}uploader/<urlenc name>[/<page>]`
- 标签页：`{host}tag/<urlenc tag>[/<page>]`
- 过滤：`{host}?page=<n>&f_search=<urlenc>`
- 热门：`/popular`；排行榜：`/toplist.php?<tl,x>`
- 订阅（watched 里的搜索）：`{host}watched` + 同样的 f_search/page 参数

### 高级搜索全参数（advsearch=1 时）
```
f_sname 名称 / f_stags 标签 / f_sdesc 描述 / f_storr 种子名 / f_sto 已删除
f_sdt1 低质量 / f_sdt2 被标记 / f_sh 已删图库 / f_sfl 语言 / f_sfu 上传者 / f_sft 收藏数
f_sr on + f_srdd <1..5>            最低评分
f_sp on + f_spf <from> + f_spt <to> 页数区间
f_cats = (~cats) & ALL_CATEGORY     分类掩码（ALL_CATEGORY 在 EhConfig）
```

## 3. gdata 批量元数据 API（EhEngine.doFillGalleryListByApi）
```
POST {site}/api.php
Content-Type: application/json
Referer: {site}/  (或详情页)
{"method":"gdata","gidlist":[[<gid>,"<token>"],...],"namespace":1}
```
- 每批最多 **25 条**，超了要分批。
- 返回 JSON：`{"gmetadata":[{"gid":..,"token":..,"title":..,"title_jpn":..,"category":..,"thumb":..,"uploader":..,"posted":..,"filecount":..,"filesize":..,"rating":..,"tags":[...],"torrentcount":..,"torrents":[{...}]}]}`
- 用途：搜索结果/本地列表批量补全，比解析 25 个详情页快得多。**必须实现。**

## 4. 归档下载三步（EhEngine.downloadArchiver / getArchive）
1. GET `/archiver.php?gid=<gid>&token=<token>` → 页面里有费用表与各类 `?or=<原图|重采样>` 链接、当前 GP。
2. POST 该链接 `hathdl_xres=<org|resample>`（`EhEngine` line 928）→ 返回一个表单页。
3. 从表单页取 `dltype` 与 `dlcheck`，POST 到下载地址（line 968-985）→ 得到 `/archive/...zip` 直链（可能排队）。
- 无 GP 时 archiver 页会给出 H@H 客户端提示（`NoHAtHClientException`）。

## 5. 登录（EhEngine.signIn）
```
POST https://forums.e-hentai.org/index.php?act=Login&CODE=01
form: UserName=<user>& PassWord=<pass> & CookieDate=1 & submit=Log me in
```
成功后 Set-Cookie 里拿到：`ipb_member_id`、`ipb_pass_hash`、`session_id`；访问 exhentai 还需 **`igneous`**（论坛域下发），缺它 exhentai 会 302 回 e-hentai（`EhCookieStore` 三个 key：ipb_member_id / ipb_pass_hash / igneous）。

## 6. 解析要点
- 列表：`div.itg > .gl1t`，名字 `a`，分类 `.cs`，时间 `.ir` 里的 `t5`，上传者 `t3`，评分 `.ir` 里的 `div`。
- 详情：`#gn` 名、`#gj` 原名、`#gdc` 信息块、`#gdd` 发布时间、`#gdn` 页数、`#gds` 体积、`#rating_label`、`#taglist`（`td.tc` 是 namespace）、`#gd5` 归档、`#gd4` 种子、`#gnd` 父画廊（"this gallery is a parent of"）。
- 多页：`#gdt .gdtm a`（普通）/`.gdtl a`（大图），href `/s/<ihash>/<token>-<n>`。
- 图片页：`#img` src、`#i3 a` 重载、`#loadfail` 需重载、`#i6 a` 里带 `showkey`。
- 搜索页尾：`#unext` / `#unext2` 下一页链接，`#uprev` 上一页。

## 7. 本地能力（EhDB / download 包）
- 收藏夹 10 个槽位（favcat 0-9 + favdel），槽位名可自定义（`favorites.php` 页面里改）。
- 下载队列：分页下载、断点续传、失败重试、`SpiderInfo`（本仓库的 CBOR spider 是它自己的后端，**不要照搬**，我们用标准 HTTP）。
- 过滤规则（EhFilter）：标题/标签/上传者 关键词黑名单，可移植成 `eh_filter_*` 工具。
