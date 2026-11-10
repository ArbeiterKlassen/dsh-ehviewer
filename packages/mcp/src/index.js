#!/usr/bin/env node
/**
 * eh-mcp —— e-hentai / exhentai 的 MCP server（stdio）
 *
 * 设计要点：
 * 1. 只做“接线”：协议层、参数校验、错误转人话，业务全在 config/http/auth/gallery/pages/browse/download/store/subs。
 * 2. 那八个模块由别的同学并行开发，这里**动态 import + 容错**：缺哪个就记一条警告，
 *    对应工具照常注册，被调用时返回一句“哪个模块还没就绪”，不会把整个 server 拖崩。
 * 3. 工具面 = 契约 25 个 + 从参考仓库移植的 8 个扩展 + 4 个一步到位的复合工具，
 *    一律注册，保证 agent 侧看到的工具面稳定。
 * 4. 输出统一压缩：默认只回必要字段、limit 默认 10、null/空串直接省略、format=tsv 可选。
 * 5. stdout 是 MCP 协议通道，任何日志只许写 stderr。
 */

import process from 'node:process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── 元信息 ────────────────────────────────────────────────────────────────
export const NAME = 'eh-mcp';
export const VERSION = '0.2.0';

/** 契约里固定的 25 个工具名 + 8 个扩展 + 4 个复合工具（共 37） */
export const TOOL_NAMES = [
  // —— 契约核心 25 个 ——
  'eh_config_get', 'eh_config_set', 'eh_login', 'eh_cookie_set', 'eh_cookie_status',
  'eh_site_switch', 'eh_search', 'eh_gallery', 'eh_popular', 'eh_recent',
  'eh_watched', 'eh_favorites', 'eh_fav_add', 'eh_pages', 'eh_image',
  'eh_download', 'eh_download_status', 'eh_download_cancel', 'eh_archive', 'eh_sub_add', 'eh_sub_list',
  'eh_sub_remove', 'eh_sub_check', 'eh_history', 'eh_tags', 'eh_thumb',
  // —— 移植自 Ehviewer_CN_SXJ（src/reference-notes.md）——
  'eh_toplists', 'eh_uploader', 'eh_tag_page', 'eh_batch_meta', 'eh_mytags',
  'eh_filter_list', 'eh_filter_add', 'eh_filter_remove',
  // —— 一步到位的复合工具（省掉 agent 手动两步）——
  'eh_find', 'eh_open', 'eh_read', 'eh_quick',
  // —— 以图搜图（upld 端点）——
  'eh_image_search',
  // —— 本地库 / 收藏夹离线 ——
  'eh_local_index', 'eh_local_search', 'eh_fav_local',
  'eh_comments', 'eh_note_save', 'eh_note_list', 'eh_note_remove',
];

const MODULE_NAMES = ['config', 'http', 'auth', 'gallery', 'pages', 'browse', 'download', 'store', 'subs', 'local-index', 'notes'];

// ── 模块装载（缺失不致命） ─────────────────────────────────────────────────
/** 已成功加载的兄弟模块 @type {Record<string, any>} */
const mods = {};
/** 缺失/加载失败的模块与原因 @type {{module: string, reason: string}[]} */
const loadWarnings = [];

for (const name of MODULE_NAMES) {
  try {
    mods[name] = await import(new URL(`./${name}.js`, import.meta.url).href);
  } catch (err) {
    loadWarnings.push({ module: name, reason: String(err?.message || err).split('\n')[0] });
  }
}

/** 拿模块，没有就抛一句人话（handler 里统一兜成 isError） */
function need(name) {
  const m = mods[name];
  if (!m) {
    const why = loadWarnings.find((w) => w.module === name);
    throw Object.assign(
      new Error(`模块 src/${name}.js 还没就绪（${why?.reason || '文件不存在'}），这个工具暂时用不了。`),
      { code: 'MODULE_MISSING' },
    );
  }
  return m;
}

/** tags.js 按需加载（不在契约的九模块里）：缺了就回落到站点补全 */
let tagsMod;
async function tagsModule() {
  if (tagsMod !== undefined) return tagsMod;
  try {
    tagsMod = await import(new URL('./tags.js', import.meta.url).href);
  } catch {
    tagsMod = null;
  }
  return tagsMod;
}

// ── 输出压缩层 ────────────────────────────────────────────────────────────
// 目标：像 ops 那套一样省 token。默认只回必要字段，null/空串不占位，tsv 最省。
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 50;
const MAX_TEXT = 300;      // 单字段截断
const MAX_ERR = 120;       // 错误一句话上限

/** 各工具的默认字段集 */
const LIST_FIELDS = 'gid,token,title,pages';                    // 通用列表
const FIND_FIELDS = 'gid,token,title,pages,category';           // 搜索（多一个 category）
const GALLERY_FIELDS = 'gid,token,title,category,pages,size,rating,language,favorite,tagsCount';
const META_FIELDS = 'gid,token,title,pages,rating,size';        // gdata 补全
const PAGE_FIELDS = 'index,url';                                // 看图页
const SUB_FIELDS = 'sub,gid,token,title,pages';                 // 订阅新作
const HIST_FIELDS = 'type,gid,token,title';

/** 长字符串截断，超长补省略号 */
function clip(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/** 字段参数：逗号分隔字符串或数组，落到数组；空则用默认集；最多 12 个 */
function parseFields(fields, fallback = LIST_FIELDS) {
  const src = Array.isArray(fields) ? fields.join(',') : (typeof fields === 'string' ? fields : '');
  const list = src.split(',').map((s) => s.trim()).filter(Boolean);
  return (list.length ? list : String(fallback).split(',')).slice(0, 12);
}

/** 按字段集裁剪一条记录；null / undefined / 空串 / 空数组 直接不出现 */
function shapeItem(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = typeof v === 'string' ? clip(v) : v;
  }
  return out;
}

/** 递归去掉 null / 空串 / 空数组 / 空对象（false 与 0 保留） */
function compact(v, depth = 0) {
  if (Array.isArray(v)) return v.map((x) => compact(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 4) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || x === null) continue;
      if (typeof x === 'string' && x === '') continue;
      if (Array.isArray(x) && x.length === 0) continue;
      const c = compact(x, depth + 1);
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return v;
}

/** 一行 TSV：首行是表头，一行一条（数组用 | 拼，对象压成 JSON） */
function toTsv(rows, cols) {
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.join('|');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).replace(/[\t\r\n]+/g, ' ');
  };
  const lines = [cols.join('\t')];
  for (const r of rows) lines.push(cols.map((k) => cell(r?.[k])).join('\t'));
  return lines.join('\n');
}

/** 统一的文本 content 包装 */
const textOf = (s) => ({ content: [{ type: 'text', text: s }] });

/**
 * 统一出口。
 * format=json（默认，紧凑无缩进）| tsv（表头 + 一行一条，列由 keys 决定）
 */
function out(payload, { format = 'json', keys } = {}) {
  if (format === 'tsv') {
    const raw = payload || {};
    // 空列表要能只回表头，所以 tsv 分支不能先 compact 掉 items
    const rows = (Array.isArray(raw.items) ? raw.items : [raw]).map((r) => compact(r));
    const cols = (Array.isArray(keys) && keys.length ? keys : Object.keys(rows[0] || raw))
      .filter((k) => k !== 'tool' && k !== 'site');
    return textOf(toTsv(rows, cols));
  }
  return textOf(JSON.stringify(compact(payload)));
}

/** 兼容旧写法：直接把对象压一压回出去 */
function ok(value) {
  return out(value);
}

/** 统一失败返回：一句话中文，≤120 字，带下一步 */
function fail(err) {
  return { isError: true, content: [{ type: 'text', text: humanize(err) }] };
}

/** 把各种异常翻译成一句能看懂的话（一行，≤120 字） */
function humanize(err) {
  const raw = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
  if (err?.code === 'MODULE_MISSING') return raw.slice(0, MAX_ERR);
  if (err?.name === 'EHBlocked' || /temporarily banned/i.test(raw)) {
    return '站点暂时封了本机，等 10~30 分钟或换代理再试。';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(raw)) {
    return '连不上站点：先 eh_config_get 看 proxy 是否在跑（socks5://127.0.0.1:10808）。';
  }
  if (/\b401\b|\b403\b/.test(raw)) return '站点拒绝访问（401/403）：cookie 可能过期，先 eh_cookie_status 再看。';
  if (/\b404\b/.test(raw)) return '目标不存在（404）：gid/token 或链接拼错了，回列表重新取。';
  if (/api\.php|gdata/i.test(raw)) return 'gdata 接口没回正常 JSON：多半被限流，等一会儿或 eh_cookie_status 检查登录。';
  const msg = raw || '未知错误';
  const line = `出错了：${msg}`;
  return line.length > MAX_ERR ? `${line.slice(0, MAX_ERR - 1)}…` : line;
}

/** limit 收敛到 1..50，默认 10 */
function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return LIMIT_DEFAULT;
  return Math.min(Math.floor(n), LIMIT_MAX);
}

/**
 * 列表统一出口：{tool, site, count, hasMore, items}，可选 tsv。
 * items 先按 offset/limit 切片，再按 fields 裁剪，最后丢空字段。
 */
function packList(tool, { site, items, limit, offset, fields, format, warnings, extra } = {}) {
  const all = Array.isArray(items) ? items : [];
  const lim = clampLimit(limit);
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const keys = parseFields(fields, LIST_FIELDS);
  const page = all.slice(off, off + lim);
  const shrunk = page.map((it) => shapeItem(it, keys));
  const hasMore = off + shrunk.length < all.length;
  const body = { tool, site, count: shrunk.length, hasMore, items: shrunk, ...(extra || {}) };
  if (hasMore) body.nextOffset = off + shrunk.length;
  if (Array.isArray(warnings) && warnings.length) body.warnings = warnings.slice(0, 4);
  return out(body, { format, keys });
}

// ── 配置 / 客户端 便捷封装 ────────────────────────────────────────────────
async function loadCfg() {
  return need('config').loadConfig();
}

const EXH_BASE = 'https://exhentai.org';
const EH_BASE = 'https://e-hentai.org';

/**
 * 判定实际生效站点：cfg.site 明确就照办；auto 时问一次 auth.mode()（会发一个请求），
 * 结果缓存 5 分钟，免得每次工具调用都多打一次首页。登录/cookie/切站会清缓存。
 */
let siteModeCache = { at: 0, site: null };
async function resolveSite(cfg, client) {
  if (cfg?.site && cfg.site !== 'auto') return cfg.site === 'exhentai' ? 'exhentai' : 'e-hentai';
  if (siteModeCache.site && Date.now() - siteModeCache.at < 5 * 60_000) return siteModeCache.site;
  try {
    const site = await need('auth').mode({ cfg, client });
    siteModeCache = { at: Date.now(), site };
    return site === 'exhentai' ? 'exhentai' : 'e-hentai';
  } catch {
    return siteModeCache.site || 'e-hentai';
  }
}

/** 清掉站点探测缓存（登录 / 换 cookie / 切站后必须清） */
function resetSiteCache() {
  siteModeCache = { at: 0, site: null };
}

/**
 * 建客户端 → 跑活 → 一定关掉。
 * 顺手把真实站点写回 cfg.base 与 site：所有 resolveBase(cfg) 的调用都会跟着走里站。
 */
async function withClient(fn) {
  const cfg = await loadCfg();
  const client = await need('http').createClient(cfg);
  try {
    const site = await resolveSite(cfg, client);
    cfg.base = site === 'exhentai' ? EXH_BASE : EH_BASE;
    return await fn({ cfg, client, base: cfg.base, site });
  } finally {
    try { client?.close?.(); } catch { /* 关不掉就算了 */ }
  }
}

/** 画廊参数：gid + token */
function galleryOf({ gid, token, title, base }) {
  const g = { gid, token };
  if (title) g.title = title;
  if (base) g.base = base;
  return g;
}

// ── 以图搜图上传：Header 辅助 ─────────────────────────────────────────────
// 图片/缩略图一律走 http.js 的 client.getBinary，这里不再自建 socks/https 通道。
/** 把配置里的 cookies 拼成请求头（rawPost 绕过 client 时才用） */
function cookieHeader(cfg) {
  const c = cfg?.cookies;
  if (!c) return undefined;
  if (typeof c === 'string') return c.trim() || undefined;
  const parts = Object.entries(c)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join('; ') : undefined;
}

// ── 以图搜图上传（upld 端点，multipart） ─────────────────────────────────
// http.js 只做 GET 文本，这里自己发 multipart；不改 http.js。
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
};

/** 扩展名 → MIME，认不出就用 image/jpeg */
function mimeOf(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return EXT_MIME[ext] || 'image/jpeg';
}

/** 手搓 multipart 体（socks5 代理只能走 node:https，没法用 undici 的 FormData） */
function buildMultipart(fields, file) {
  const boundary = `----eh${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sfile"; filename="${file.filename}"\r\n`
    + `Content-Type: ${file.contentType}\r\n\r\n`,
  ));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * 裸请求（可挂 socks 代理），回 {status, headers, text, finalUrl}。
 * 上传接口会 302 到结果页（?f_shash=...），所以自己跟跳转。
 */
function rawPost(url, { body, headers, agent, method = 'POST', redirects = 0 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method, agent, headers }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers?.location;
      if (status >= 300 && status < 400 && loc && redirects < 5) {
        res.resume();
        const next = new URL(loc, u).href;
        const h = { ...headers };
        delete h['content-length'];
        delete h['content-type'];
        resolve(rawPost(next, { headers: h, agent, method: 'GET', redirects: redirects + 1 }));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        finalUrl: next_(loc, u),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(90_000, () => req.destroy(new Error('上传超时（90s）')));
    req.end(body);
  });
}

/** 解析相对 location（没有就回原 URL） */
function next_(loc, base) {
  try { return loc ? new URL(loc, base).href : base.href; } catch { return base.href; }
}

/**
 * POST 一段 multipart 表单。
 * @param {{fields: object, file: {filename: string, contentType: string, buffer: Buffer}, headers: object, proxy?: string}} opts
 */
async function postMultipart(url, { fields, file, headers, proxy }) {
  const hdrs = {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  };
  if (proxy && /^socks/i.test(proxy)) {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    // socks5:// 会先在本地解析域名（这台机器 DNS 解析 upld.* 会失败，表现成 TLS 断连）；
    // 换成 socks5h:// 把域名交给代理解析
    const socksUrl = String(proxy)
      .replace(/^socks5:\/\//i, 'socks5h://')
      .replace(/^socks4:\/\//i, 'socks4a://');
    const { body, contentType } = buildMultipart(fields, file);
    const r = await rawPost(url, {
      body,
      agent: new SocksProxyAgent(socksUrl),
      headers: { ...hdrs, 'content-type': contentType, 'content-length': String(body.length) },
    });
    if (r.status >= 400) throw Object.assign(new Error(`上传失败 HTTP ${r.status}`), { status: r.status });
    return { text: r.text, finalUrl: r.finalUrl };
  }
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }
  fd.append('sfile', new Blob([file.buffer], { type: file.contentType }), file.filename);
  const init = { method: 'POST', headers: hdrs, body: fd, redirect: 'follow' };
  if (proxy) {
    const { ProxyAgent } = await import('undici');
    init.dispatcher = new ProxyAgent(proxy);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw Object.assign(new Error(`上传失败 HTTP ${res.status}`), { status: res.status });
  return { text: await res.text(), finalUrl: res.url };
}

/** 取要上传的图：本地 path 或远端 url，回 {buffer, filename, contentType} */
async function readUploadSource(client, { sourcePath, sourceUrl, referer }) {
  if (sourcePath) {
    const buffer = await readFile(sourcePath);
    if (!buffer.length) throw new Error(`本地文件是空的：${sourcePath}`);
    const filename = path.basename(sourcePath) || 'a.jpg';
    return { buffer, filename, contentType: mimeOf(filename) };
  }
  if (!sourceUrl) throw new Error('给 path 或 url 其中一个。');
  const { buffer, headers } = await client.getBinary(sourceUrl, { referer });
  if (!buffer || !buffer.length) throw new Error('远程图片是空的（0 字节）。');
  const ext = (String(sourceUrl).split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'jpg').toLowerCase();
  const declared = String(headers?.['content-type'] || '').split(';')[0].trim();
  return { buffer, filename: `a.${ext}`, contentType: declared || mimeOf(`a.${ext}`) };
}

// ── 下载进度（本进程内） ──────────────────────────────────────────────────
/** gid → 最新进度；串行给 agent 看 */
const downloadProgress = new Map();

// ── 列表 URL / 列表页（统一走 gallery.js，这里只做参数映射） ──────────────
// 分类掩码取反（toFCats）与 /g/ 链接兜底解析都已在 gallery.js 里，这里不留第二份。

/** 工具里的语义化开关 → gallery.buildListUrl 认的 ADV_FLAGS 名 */
const ADV_MAP = {
  name: 'sname',
  tags: 'stags',
  desc: 'sdesc',
  torrentName: 'storr',
  withTorrents: 'sto',
  expunged: 'sh',
  lowPower: 'sdt1',
  downvoted: 'sdt2',
  disableLang: 'sfl',
  disableUploader: 'sfu',
  disableTags: 'sft',
  // 旧名别名：映射到同一批站内字段
  torr: 'storr',
  del: 'sto',
  exp: 'sh',
  lang: 'sfl',
  uploader: 'sfu',
  fav: 'sft',
};

/** 工具 adv（布尔开关 + 数值区间）→ 模块 adv（flags + srdd/spf/spt） */
function advToModule(adv) {
  if (!adv || typeof adv !== 'object') return null;
  const on = (v) => {
    if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
    if (typeof v === 'string' && /^(off|false|0|no)$/i.test(v.trim())) return false;
    return true;
  };
  const flags = [...new Set(Object.entries(ADV_MAP).filter(([k]) => on(adv[k])).map(([, f]) => f))];
  const out = { flags };
  const rating = Number(adv.minRating);
  if (Number.isFinite(rating) && rating >= 1) out.srdd = Math.min(5, Math.floor(rating));
  const from = Number(adv.pageFrom);
  const to = Number(adv.pageTo);
  if (Number.isFinite(from) && from > 0) out.spf = Math.floor(from);
  if (Number.isFinite(to) && to > 0) out.spt = Math.floor(to);
  const any = flags.length || out.srdd !== undefined || out.spf !== undefined || out.spt !== undefined;
  return any ? out : null;
}

/**
 * 列表页 URL。实现只有一份：gallery.buildListUrl（分类取反、高级搜索、toplist/favorites 参数都在那边）。
 * 这个导出保留给调用方/测试当稳定入口。
 */
export function buildListUrl(base, { mode = 'search', query = '', page = 0, category, adv } = {}) {
  const g = mods.gallery;
  if (typeof g?.buildListUrl !== 'function') {
    throw Object.assign(new Error('模块 src/gallery.js 还没就绪，列表页 URL 拼不出来。'), { code: 'MODULE_MISSING' });
  }
  const modAdv = advToModule(adv) || {};
  if (mode === 'toplist') modAdv.tl = adv?.tl;
  if (mode === 'favorites') modAdv.favcat = adv?.favcat;
  const url = g.buildListUrl(base, { mode, keyword: query, page, category, adv: modAdv });
  // tag / uploader 页补尾斜杠：站点两种都认，只为出口形状稳定
  if ((mode === 'tag' || mode === 'uploader') && !String(url).endsWith('/')) return `${url}/`;
  return url;
}

/** 拉一个列表页并解析（解析与兜底抽取都在 gallery.parseGalleryList） */
async function fetchList(client, base, url) {
  const res = await client.get(url);
  const html = res.text || '';
  if (/Non-existing toplist/i.test(html)) {
    throw new Error('这个排行榜周期需要登录才能看（4h/1d/1w/1m/1y）；未登录只有 tl=all 可用，或先 eh_login。');
  }
  const warnings = Array.isArray(res.warnings) ? [...res.warnings] : [];
  const parsed = need('gallery').parseGalleryList(html, { base });
  const items = Array.isArray(parsed) ? parsed : [];
  return { url: res.finalUrl || url, count: items.length, items, warnings };
}

// ── 本地过滤规则（EhFilter 的等价实现） ──────────────────────────────────
// 优先用 store 里的同名能力；store 还没写这块时落 ~/.dsh-eh/filters.json。
function filterFilePath() {
  const home = process.env.DSH_EH_HOME || path.join(homedir(), '.dsh-eh');
  return path.join(home, 'filters.json');
}

async function readFilters() {
  if (typeof mods.store?.listFilters === 'function') {
    try { return await mods.store.listFilters(); } catch { /* 落到本地文件 */ }
  }
  try {
    const raw = await readFile(filterFilePath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (data.items || []);
  } catch {
    return [];
  }
}

async function writeFilters(items) {
  if (typeof mods.store?.saveFilters === 'function') {
    try { return await mods.store.saveFilters(items); } catch { /* 落到本地文件 */ }
  }
  const file = filterFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
  await rename(tmp, file); // 原子写
  return items;
}

/** 过滤器命中判断：field 决定看哪个字段 */
function filterHit(item, f) {
  const needle = String(f.pattern || '').toLowerCase().trim();
  if (!needle) return false;
  const pick = {
    title: [item.title],
    uploader: [item.uploader],
    tag: Array.isArray(item.tagsPreview) ? item.tagsPreview : [],
    any: [item.title, item.uploader, ...(Array.isArray(item.tagsPreview) ? item.tagsPreview : [])],
  }[f.field || 'any'] || [];
  return pick.filter(Boolean).some((s) => String(s).toLowerCase().includes(needle));
}

/** 按黑名单剔掉命中的条目，返回 {items, filtered} */
function applyFilters(items, filters) {
  if (!Array.isArray(filters) || !filters.length) return { items, filtered: 0 };
  const kept = items.filter((it) => !filters.some((f) => filterHit(it, f)));
  return { items: kept, filtered: items.length - kept.length };
}

// ── 复合工具的辅助 ────────────────────────────────────────────────────────
/** 详情对象拍平：默认只留精简字段，tags 折成 tagsCount */
function flattenDetail(d, { full = false } = {}) {
  if (!d || typeof d !== 'object') return {};
  const tags = d.tags && typeof d.tags === 'object' ? d.tags : {};
  let tagsCount = 0;
  for (const arr of Object.values(tags)) if (Array.isArray(arr)) tagsCount += arr.length;
  const flat = {
    gid: d.gid,
    token: d.token,
    title: d.title,
    jtitle: d.jtitle,
    category: d.category,
    posted: d.posted,
    uploader: d.uploader,
    pages: d.pages,
    size: d.size,
    rating: d.rating,
    language: d.language,
    favorite: d.favorite ? (d.favorite.slot ?? d.favorite.name ?? true) : null,
    tagsCount: tagsCount || null,
    torrents: Array.isArray(d.torrents) ? d.torrents.length : null,
    parent: d.parent || null,
    visible: d.visible,
    thumb: d.thumb,
    archiverUrl: d.archiverUrl,
    url: d.url,
  };
  if (full) flat.tags = tags;
  return flat;
}

/** gdata 结果合并进列表项（页数/评分/体积这类以 api 为准） */
function mergeMeta(item, meta) {
  if (!meta) return item;
  const out = { ...item };
  for (const k of ['title', 'jtitle', 'category', 'posted', 'uploader', 'pages', 'rating', 'size', 'thumb']) {
    const v = meta[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  if (Array.isArray(meta.tags) && meta.tags.length) out.tagsPreview = meta.tags.slice(0, 8);
  return out;
}

// ── 建 server ─────────────────────────────────────────────────────────────
/**
 * 注册全部工具并返回 { server, toolNames, warnings }。
 * 不连 transport —— 冒烟测试直接调它就能点清工具面。
 */
export async function buildServer() {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      instructions:
        'e-hentai / exhentai 画廊工具集。开场跑 eh_quick（登录+首页+订阅三合一），'
        + '找本用 eh_find（搜索+gdata 一步到位），要详情+图片直链用 eh_open，'
        + '只看内容用 eh_read。列表工具都支持 fields / format=tsv / limit / offset 省 token。',
    },
  );

  /** 注册小工具：统一包 try/catch，保证一个工具炸不影响别的 */
  const define = (name, config, handler) => {
    server.registerTool(name, config, async (args, extra) => {
      try {
        return await handler(args || {}, extra);
      } catch (err) {
        return fail(err);
      }
    });
  };

  // 列表类通用可选参数（所有列表工具共用同一套语义）
  const P_FIELDS = z.string().optional().describe('要回的字段，逗号分隔（如 "gid,title,pages,rating"）；默认精简集');
  const P_FORMAT = z.enum(['json', 'tsv']).optional().describe('json=紧凑 JSON（默认）；tsv=首行表头、一行一条，最省 token');
  const P_LIMIT = z.number().int().min(1).max(LIMIT_MAX).optional().describe(`返回条数，默认 ${LIMIT_DEFAULT}，最多 ${LIMIT_MAX}`);
  const P_OFFSET = z.number().int().min(0).optional().describe('跳过前 N 条，翻页用');
  const listParams = { fields: P_FIELDS, format: P_FORMAT, limit: P_LIMIT, offset: P_OFFSET };

  // ① 配置
  define('eh_config_get', {
    title: '读配置',
    description: '读配置：站点、代理、下载目录、限速。cookie 只回键名不回值。',
    inputSchema: {},
  }, async () => {
    const cfg = await loadCfg();
    const safe = { ...cfg };
    if (cfg?.cookies && typeof cfg.cookies === 'object') {
      safe.cookies = { count: Object.keys(cfg.cookies).length, keys: Object.keys(cfg.cookies) };
    } else if (typeof cfg?.cookies === 'string') {
      safe.cookies = { count: cfg.cookies.split(';').filter(Boolean).length, keys: [] };
    }
    return ok({ path: mods.config?.getConfigPath?.() || '~/.dsh-eh/config.json', config: safe });
  });

  define('eh_config_set', {
    title: '改配置',
    description: '改配置并落盘。换站/代理/下载目录/并发/限速时用，只传要改的字段。',
    inputSchema: {
      site: z.enum(['auto', 'e-hentai', 'exhentai']).optional().describe('默认站点：auto 自动探测 / e-hentai / exhentai'),
      proxy: z.string().optional().describe('代理，如 socks5://127.0.0.1:10808；空串表示直连'),
      cookies: z.union([z.string(), z.record(z.string(), z.string())]).optional().describe('cookie 字符串或键值对象'),
      downloadDir: z.string().optional().describe('下载根目录，如 D:/eh-dl'),
      concurrency: z.number().int().min(1).max(16).optional().describe('下载并发数，1~16'),
      rateLimitMs: z.number().int().min(0).max(60_000).optional().describe('每次请求最小间隔（毫秒）'),
    },
  }, async (args) => {
    const patch = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) patch[k] = v;
    if (!Object.keys(patch).length) throw new Error('没给要改的字段。至少带一个：site / proxy / cookies / downloadDir / concurrency / rateLimitMs。');
    const cfg = await need('config').saveConfig(patch);
    resetSiteCache();
    const safe = { ...cfg };
    if (safe.cookies) safe.cookies = typeof safe.cookies === 'string'
      ? { count: safe.cookies.split(';').filter(Boolean).length }
      : { count: Object.keys(safe.cookies).length };
    return ok({ saved: Object.keys(patch), config: safe });
  });

  // ② 登录 / cookie / 切站
  define('eh_login', {
    title: '账号密码登录',
    description: '账号密码登录，存 cookie。首次使用或 cookie 失效时用。',
    inputSchema: {
      username: z.string().min(1).describe('账号名'),
      password: z.string().min(1).describe('密码'),
    },
  }, async ({ username, password }) => {
    const cfg = await loadCfg();
    const res = await need('auth').login({ cfg, username, password });
    resetSiteCache();
    return ok({ ok: true, ...(res || {}) });
  });

  define('eh_cookie_set', {
    title: '导入 cookie',
    description: '直接塞 cookie（整串或键值对象）。不想给密码时用。',
    inputSchema: {
      cookieString: z.string().optional().describe('整串 cookie，形如 "ipb_member_id=1; ipb_pass_hash=xxx; igneous=yyy"'),
      cookies: z.record(z.string(), z.string()).optional().describe('键值对象形式的 cookie'),
    },
  }, async ({ cookieString, cookies }) => {
    if (!cookieString && !cookies) throw new Error('给 cookieString 或 cookies 其中一个。');
    const cfg = await loadCfg();
    const res = await need('auth').setCookies({ cfg, cookieString, cookies });
    resetSiteCache();
    return ok({ ok: true, ...(res || {}) });
  });

  define('eh_cookie_status', {
    title: '登录状态',
    description: '看登录状态与实际可用站点。开新会话先跑这个。',
    inputSchema: {},
  }, async () => withClient(async ({ cfg, client, site }) => {
    const st = await need('auth').status({ cfg, client });
    return ok({ ...(st || {}), site });
  }));

  define('eh_site_switch', {
    title: '切站点',
    description: '切默认站点 auto/e-hentai/exhentai。切完跑 eh_cookie_status 验。',
    inputSchema: {
      target: z.enum(['auto', 'e-hentai', 'exhentai']).describe('目标站点'),
    },
  }, async ({ target }) => {
    const cfg = await loadCfg();
    const saved = await need('auth').switchSite({ cfg, target });
    resetSiteCache();
    return ok({ switchedTo: target, config: { site: saved?.site || target, proxy: saved?.proxy } });
  });

  // ③ 浏览
  define('eh_search', {
    title: '搜索画廊',
    description: '按关键词/tag 搜画廊，要翻页或高级条件时用；只要一屏摘要用 eh_find。',
    inputSchema: {
      query: z.string().describe('搜索词，可直接写 tag 语法；mode=uploader/tag 时传名字或 tag'),
      mode: z.enum(['search', 'uploader', 'tag', 'watched']).optional().describe('搜索模式，默认 search'),
      page: z.number().int().min(0).max(2000).optional().describe('页码，从 0 开始'),
      category: z.union([z.number().int(), z.string(), z.array(z.string())]).optional().describe('分类掩码：数字位掩码，或 "doujinshi,manga" 这类名字，或名字数组'),
      adv: z.object({
        name: z.boolean().optional().describe('搜画廊名称（f_sname）'),
        tags: z.boolean().optional().describe('搜画廊标签（f_stags）'),
        desc: z.boolean().optional().describe('搜画廊描述（f_sdesc）'),
        torrentName: z.boolean().optional().describe('搜种子文件名（f_storr）'),
        withTorrents: z.boolean().optional().describe('仅有种子的（f_sto）'),
        expunged: z.boolean().optional().describe('含已删除的（f_sh）'),
        lowPower: z.boolean().optional().describe('低愿力标签（f_sdt1）'),
        downvoted: z.boolean().optional().describe('差评标签（f_sdt2）'),
        disableLang: z.boolean().optional().describe('禁用语言过滤（f_sfl）'),
        disableUploader: z.boolean().optional().describe('禁用上传者过滤（f_sfu）'),
        disableTags: z.boolean().optional().describe('禁用标签过滤（f_sft）'),
        minRating: z.number().int().min(1).max(5).optional().describe('最低评分（f_sr+f_srdd）'),
        pageFrom: z.number().int().min(1).optional().describe('页数下限（f_spf）'),
        pageTo: z.number().int().min(1).optional().describe('页数上限（f_spt）'),
        torr: z.boolean().optional().describe('旧名，等同 torrentName'),
        del: z.boolean().optional().describe('旧名，等同 withTorrents'),
        exp: z.boolean().optional().describe('旧名，等同 expunged'),
        lang: z.union([z.boolean(), z.string()]).optional().describe('旧名，等同 disableLang'),
        uploader: z.union([z.boolean(), z.string()]).optional().describe('旧名，等同 disableUploader'),
        fav: z.union([z.boolean(), z.string()]).optional().describe('旧名，等同 disableTags'),
      }).optional().describe('高级搜索；出现任意一项就带 advsearch=1'),
      filter: z.boolean().optional().describe('是否套用本地黑名单过滤，默认 false'),
      ...listParams,
    },
  }, async ({ query, mode, page, category, adv, filter, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const m = mode || 'search';
    const browse = mods.browse || {};
    const filters = filter ? await readFilters() : [];

    /** 收口：过滤 + 分页 + 精简输出 */
    const pack = (items, extra = {}) => {
      const { items: kept, filtered } = applyFilters(Array.isArray(items) ? items : [], filters);
      return packList('eh_search', {
        site,
        items: kept,
        limit,
        offset,
        fields: fields || (m === 'search' ? FIND_FIELDS : LIST_FIELDS),
        format,
        warnings: extra.warnings,
        extra: { mode: m, ...(filtered ? { filtered } : {}), ...(extra.url ? { url: extra.url } : {}) },
      });
    };

    // ① 普通搜索：走 browse.search（契约路径）
    if (m === 'search' && !adv && category === undefined && typeof browse.search === 'function') {
      const r = await browse.search(client, { base, query, page, category: null });
      const list = Array.isArray(r) ? r : (r?.items || []);
      return pack(list, { warnings: Array.isArray(r?.warnings) ? r.warnings : [] });
    }
    // ② 只搜「我的画廊」
    if (m === 'watched' && typeof browse.watched === 'function') {
      const r = await browse.watched(client, { base, query, page: page || 0 });
      const list = Array.isArray(r) ? r : (r?.items || []);
      return pack(list, { warnings: Array.isArray(r?.warnings) ? r.warnings : [] });
    }
    // ③ 分类掩码 / 高级搜索 / uploader / tag：本地按参考仓库规则拼 URL
    //    （不直接调 gallery.buildListUrl：它把 f_cats 当成「包含」掩码，与参考实现的取反语义相反）
    const url = buildListUrl(base, { mode: m, query, page, category, adv });
    const res = await fetchList(client, base, url);
    return pack(res.items, { url: res.url, warnings: res.warnings });
  }));

  define('eh_gallery', {
    title: '画廊详情',
    description: '画廊详情。只要标题页数评分就够用；要看图用 eh_open。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id（URL 里 /g/<gid>/<token>/ 的前一段）'),
      token: z.string().min(1).describe('画廊 token（URL 后一段，10 位十六进制）'),
      full: z.boolean().optional().describe('true 才回完整 tag 与解析警告，默认只回精简字段'),
      fields: P_FIELDS,
      format: P_FORMAT,
    },
  }, async ({ gid, token, full, fields, format }) => withClient(async ({ client, base, site }) => {
    const r = await need('browse').galleryDetail(client, { base, gid, token });
    const detail = r?.detail || null;
    if (!detail) {
      const why = Array.isArray(r?.warnings) && r.warnings.length ? `（${r.warnings[0]}）` : '';
      throw new Error(`拿不到 gid=${gid} 的详情${why}：链接可能失效或要登录，先 eh_cookie_status。`);
    }
    const keys = parseFields(fields, GALLERY_FIELDS);
    const body = { tool: 'eh_gallery', site: r?.site || site, ...shapeItem(flattenDetail(detail, { full }), keys) };
    if (full) {
      // 警告只在 full=true 时回，且去重（详情页解析警告会被两条链路各说一次）
      const warn = [...new Set([...(r?.warnings || []), ...(detail.warnings || [])].filter(Boolean))];
      if (warn.length) body.warnings = warn.slice(0, 4);
    }
    return out(body, { format, keys });
  }));

  define('eh_popular', {
    title: '热门',
    description: '热门：/popular 通栏页，或传 period 走排行榜。想扫当下热度时用。',
    inputSchema: {
      period: z.enum(['4h', '1d', '1w', '1m', '1y', 'all']).optional().describe('时间窗口；不传=走 /popular'),
      ...listParams,
    },
  }, async ({ period, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    if (typeof mods.browse?.popular === 'function') {
      const r = await mods.browse.popular(client, { base, period: period || null });
      const items = Array.isArray(r) ? r : (r?.items || []);
      if (items.length) {
        return packList('eh_popular', {
          site, items, limit, offset, fields, format,
          warnings: r?.warnings, extra: { period: period || null },
        });
      }
    }
    const host = String(base).replace(/\/+$/, '');
    // toplist 只有 EH 有；/popular 两边都在
    const topHost = site === 'exhentai' ? EH_BASE : host;
    const url = period
      ? buildListUrl(topHost, { mode: 'toplist', page: 0, adv: { tl: period } })
      : buildListUrl(host, { mode: 'popular' });
    const res = await fetchList(client, period ? topHost : base, url);
    return packList('eh_popular', { site, items: res.items, limit, offset, fields, format, warnings: res.warnings, extra: { period: period || null } });
  }));

  define('eh_recent', {
    title: '首页最新',
    description: '首页最新一屏。追新上架时用，比搜索快。',
    inputSchema: { ...listParams },
  }, async ({ limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const r = await need('browse').recent(client, { base });
    const items = Array.isArray(r) ? r : (r?.items || []);
    return packList('eh_recent', { site, items, limit, offset, fields, format, warnings: r?.warnings });
  }));

  define('eh_watched', {
    title: '我的画廊',
    description: '我的画廊（watched），需登录。接着看上次没看完的用它。',
    inputSchema: { ...listParams },
  }, async ({ limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const r = await need('browse').watched(client, { base });
    const items = Array.isArray(r) ? r : (r?.items || []);
    return packList('eh_watched', { site, items, limit, offset, fields, format, warnings: r?.warnings });
  }));

  define('eh_favorites', {
    title: '收藏夹',
    description: '收藏夹列表/夹内搜索（cat=0~9 或 all）。query 非空时搜名字+标签+备注。',
    inputSchema: {
      cat: z.union([z.number().int().min(0).max(9), z.literal('favdel'), z.literal('all')]).optional().describe('收藏夹序号 0~9 / "all" / "favdel"'),
      query: z.string().optional().describe('夹内搜索词，空=全部'),
      page: z.number().int().min(0).max(2000).optional().describe('页码，从 0 开始'),
      cache: z.boolean().optional().describe('true=把这一页存进本地缓存，供 eh_fav_local 离线搜'),
      ...listParams,
    },
  }, async ({ cat, query, page, cache, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const r = await need('browse').favorites(client, { base, cat: cat ?? 0, page: page ?? 0, query });
    const items = Array.isArray(r) ? r : (r?.items || []);
    if (cache) {
      try { await mods.store?.saveFavorites?.(items); } catch { /* 缓存失败不影响结果 */ }
    }
    return packList('eh_favorites', {
      site, items, limit, offset, fields, format,
      warnings: r?.warnings, extra: { cat: cat ?? 0, ...(query ? { query } : {}) },
    });
  }));

  define('eh_fav_add', {
    title: '加收藏',
    description: '把画廊加进收藏夹槽位 0~9。别手动点网页。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      slot: z.number().int().min(0).max(9).optional().describe('目标收藏夹 0~9，默认 0'),
    },
  }, async ({ gid, token, slot }) => withClient(async ({ client, base }) =>
    ok(await need('browse').favAdd(client, { base, gid, token, slot: slot ?? 0 }))));

  // ④ 看图
  define('eh_pages', {
    title: '列出看图页',
    description: '列看图页链接，可用 from/to 取区间。要真图片地址用 eh_open。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      from: z.number().int().min(0).optional().describe('起始页（含），从 0 开始'),
      to: z.number().int().min(0).optional().describe('结束页（含）'),
      ...listParams,
    },
  }, async ({ gid, token, from, to, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const list = await need('pages').listPages(client, { gallery: galleryOf({ gid, token, base }), from, to });
    const items = Array.isArray(list) ? list : (list?.items || []);
    return packList('eh_pages', {
      site, items, limit, offset, fields: fields || PAGE_FIELDS, format,
      warnings: Array.isArray(list?.warnings) ? list.warnings : [],
    });
  }));

  define('eh_image', {
    title: '解析图片地址',
    description: '看图页 URL → 真图片地址（含重载/showkey）。只解单页。',
    inputSchema: {
      pageUrl: z.string().min(1).describe('看图页 URL，形如 https://e-hentai.org/s/<ihash>/<pageToken>-<n>'),
    },
  }, async ({ pageUrl }) => withClient(async ({ client }) =>
    ok(await need('pages').resolveImage(client, pageUrl))));

  // ⑤ 下载
  define('eh_download', {
    title: '下载画廊',
    description: '整本下载，并发+断点续传。离线收藏用它，图多先看 eh_archive。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      title: z.string().optional().describe('画廊标题，用作子目录名；不传就用 gid'),
      dir: z.string().optional().describe('下载根目录，默认取配置里的 downloadDir'),
      concurrency: z.number().int().min(1).max(16).optional().describe('并发数，默认取配置'),
    },
  }, async ({ gid, token, title, dir, concurrency }) => withClient(async ({ cfg, client, site, base }) => {
    // 账号归档：默认 <downloadDir>/<exh|eh>-<memberId>，memberId 直接从 cookie 读，不再打一次网络
    let targetDir = dir;
    if (!targetDir) {
      const memberId = cfg?.cookies?.ipb_member_id ? String(cfg.cookies.ipb_member_id) : null;
      targetDir = mods.config?.resolveDownloadDir
        ? mods.config.resolveDownloadDir(cfg, { memberId, site })
        : cfg?.downloadDir;
    }
    if (!targetDir) throw new Error('没指定下载目录：传 dir，或先 eh_config_set 设 downloadDir。');
    // 目录对账：dir 可能是根、可能是这本的目录、也可能是老版本（换账号前）留下的位置，
    // 统一收编到 <root>/<gid>-<token>，避免同一本被下成两份、老目录永远不更新。
    let dlRoot = targetDir;
    const dirWarnings = [];
    try {
      const dlMod = need('download');
      if (typeof dlMod.normalizeGalleryTarget === 'function') {
        const t0 = dlMod.normalizeGalleryTarget({ dir: targetDir, gid, token });
        let outDir = t0.outDir;
        if (!t0.wasGalleryDir && typeof dlMod.adoptExistingGalleryDir === 'function') {
          const ad = await dlMod.adoptExistingGalleryDir({
            root: t0.root,
            gid,
            token,
            // 老版本 / 换账号前的目录可能在下载根上，也可能在别的账号桶里，都搜一遍
            searchRoots: [cfg?.downloadDir, t0.root && path.dirname(t0.root)].filter(Boolean),
          });
          if (Array.isArray(ad.warnings)) dirWarnings.push(...ad.warnings);
          if (ad.outDir) outDir = ad.outDir;
        }
        dlRoot = path.dirname(outDir);
      }
    } catch { /* 对账是加分项，失败照常下 */ }
    const gallery = galleryOf({ gid, token, title });
    // 顺手把详情元数据补齐（1 次请求）：本地库索引靠 title/tags/uploader 才能搜得动，
    // 拿不到详情也照下，不阻断。
    let gal = gallery;
    try {
      const d = await need('browse').galleryDetail(client, { base, gid, token });
      const det = d?.detail || d;
      if (det && (det.title || det.tags)) {
        gal = {
          ...gallery,
          title: det.title || gallery.title,
          titleJpn: det.jtitle || null,
          url: det.url || gallery.url,
          category: det.category || null,
          uploader: det.uploader || null,
          tags: det.tags || {},
          pages: det.pages || gallery.pages,
          site,
        };
      }
    } catch { /* 详情拿不到就算了 */ }
    const key = `${gid}`;
    downloadProgress.set(key, { gid, state: 'running', startedAt: new Date().toISOString() });
    try {
      const res = await need('download').downloadGallery({
        client,
        gallery: gal,
        dir: dlRoot,
        concurrency: concurrency ?? cfg?.concurrency,
        onProgress: (p) => downloadProgress.set(key, { gid, state: 'running', ...(p || {}) }),
      });
      // 被 eh_download_cancel 打断时如实标 cancelled，别让上层以为下完了
      const state = res && res.cancelled ? 'cancelled' : 'done';
      downloadProgress.set(key, { gid, state, finishedAt: new Date().toISOString(), ...(res || {}) });
      // 顺手记历史（store 没就绪就算了）
      const outDir = path.join(dlRoot, `${gid}-${token}`);
      try { await mods.store?.addHistory?.({ type: 'download', gid, token, title, dir: outDir }); } catch { /* 可选 */ }
      return ok({
        gid,
        dir: outDir,
        ...(dirWarnings.length ? { dirWarnings } : {}),
        ...(res || {}),
      });
    } catch (err) {
      downloadProgress.set(key, { gid, state: 'failed', error: humanize(err) });
      throw err;
    }
  }));

  define('eh_download_status', {
    title: '下载进度',
    description: '本进程下载进度。重启后清空，但文件还在。',
    inputSchema: {},
  }, async () => textOf(JSON.stringify({ tasks: [...downloadProgress.values()] })));

  define('eh_download_cancel', {
    title: '取消下载',
    description: '停掉正在跑的下载：不再开新图，在飞的那张跑完就收，已下完的文件保留（meta 里标 cancelled，下次可续）。',
    inputSchema: {
      gid: z.number().int().positive().describe('要取消的画廊 id'),
    },
  }, async ({ gid }) => {
    const mod = need('download');
    const stopped = typeof mod.cancelDownload === 'function' && mod.cancelDownload(gid);
    const key = `${gid}`;
    const cur = downloadProgress.get(key);
    if (stopped && cur) downloadProgress.set(key, { ...cur, state: 'cancelling' });
    return ok({ gid, cancelled: !!stopped, state: (cur && cur.state) || null });
  });

  define('eh_archive', {
    title: '归档下载',
    description: '归档信息或下单（耗 GP）。图太多别一张张拉时用。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      action: z.enum(['info', 'request']).optional().describe('info=只看归档信息，request=下单（耗 GP）'),
      res: z.enum(['org', 'resample']).optional().describe('request 时的清晰度，默认 org'),
    },
  }, async ({ gid, token, action, res }) => withClient(async ({ client }) => {
    const gallery = galleryOf({ gid, token });
    const act = action || 'info';
    if (act === 'request') {
      // 只有显式 request 才真的下单（会消耗 GP），info 永远只读
      return ok(await need('download').requestArchive(client, { gallery, res: res || 'org', dryRun: false }));
    }
    return ok(await need('download').archiveInfo(client, { gallery }));
  }));

  // ⑥ 订阅
  define('eh_sub_add', {
    title: '加订阅',
    description: '存一条搜索式订阅。之后 eh_sub_check 只拉新作品。',
    inputSchema: {
      query: z.string().min(1).describe('订阅用的搜索词 / tag 组合'),
      type: z.string().optional().describe('订阅类型标记，默认 search'),
    },
  }, async ({ query, type }) => {
    const r = await need('store').addSub({ query, type: type || 'search' });
    return ok(r ? { added: true, id: r.id, query: r.query } : { added: false, query });
  });

  define('eh_sub_list', {
    title: '订阅列表',
    description: '列订阅与 id。删订阅前先看它。',
    inputSchema: { ...listParams },
  }, async ({ limit, offset, fields, format }) => {
    const list = await need('store').listSubs();
    const items = (Array.isArray(list) ? list : []).map((s) => ({
      id: s?.id,
      query: s?.query,
      seen: Array.isArray(s?.seen) ? s.seen.length : 0,
      at: s?.lastCheckAt,
    }));
    return packList('eh_sub_list', {
      site: undefined, items, limit, offset, fields: fields || 'id,query,seen,at', format,
    });
  });

  define('eh_sub_remove', {
    title: '删订阅',
    description: '按 id 删订阅。id 从 eh_sub_list 拿。',
    inputSchema: {
      id: z.string().min(1).describe('订阅 id'),
    },
  }, async ({ id }) => {
    const removed = await need('store').removeSub(id);
    const left = await need('store').listSubs();
    return ok({ removed: id, ok: !!removed, total: Array.isArray(left) ? left.length : 0 });
  });

  define('eh_sub_check', {
    title: '检查订阅更新',
    description: '跑全部订阅，只回新作品。别一条条 eh_search。',
    inputSchema: { ...listParams },
  }, async ({ limit, offset, fields, format }) => withClient(async ({ cfg, client, base, site }) => {
    const results = await need('subs').checkSubs({ client, base, cfg });
    const rows = [];
    const errors = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (r?.error) errors.push({ sub: r.query, error: String(r.error).slice(0, 60) });
      for (const it of (r?.newItems || [])) rows.push({ sub: r.query, ...it });
    }
    return packList('eh_sub_check', {
      site, items: rows, limit, offset, fields: fields || SUB_FIELDS, format,
      extra: { subsChecked: Array.isArray(results) ? results.length : 0, ...(errors.length ? { errors } : {}) },
    });
  }));

  // ⑦ 历史 / tag
  define('eh_history', {
    title: '本地历史',
    description: '本地历史：浏览/搜索/下载。想找「上次那个」时用。',
    inputSchema: {
      type: z.string().optional().describe('历史类型过滤，如 gallery / search / download'),
      query: z.string().optional().describe('按关键词过滤'),
      ...listParams,
    },
  }, async ({ limit, type, query, offset, fields, format }) => {
    const list = await need('store').listHistory({ limit: 200, type, query });
    const items = Array.isArray(list) ? list : (list?.items || []);
    return packList('eh_history', { items, limit, offset, fields: fields || HIST_FIELDS, format });
  });

  define('eh_tags', {
    title: 'tag 补全',
    description: 'tag 前缀补全，本地 4.4 万条零网络；aliases 列别名，ns 限命名空间。',
    inputSchema: {
      q: z.string().optional().describe('tag 前缀或片段，如 "fem" / "巨乳"'),
      ns: z.string().optional().describe('只出某个 namespace，如 female / male / language'),
      aliases: z.boolean().optional().describe('true = 列口语别名表（不看 q）'),
      ...listParams,
    },
  }, async ({ q, ns, aliases, limit, offset, fields, format }) => {
    const T = await tagsModule();

    // ① 别名表：中文/口语 → 站内 tag
    if (aliases) {
      const list = (T?.listAliases?.() || []).map((a) => ({ alias: a.alias, tag: a.tag }));
      return packList('eh_tags', {
        items: list, limit, offset, fields: fields || 'alias,tag', format, extra: { mode: 'aliases' },
      });
    }
    if (!q) throw new Error('给 q（前缀），或 aliases:true 看别名表。');

    // ② 本地优先：44861 条，零网络、不受限速
    if (typeof T?.suggestTags === 'function') {
      const local = T.suggestTags(q, { ns, limit: clampLimit(limit) }) || [];
      if (local.length) {
        return packList('eh_tags', {
          items: local.map((t) => ({ tag: t })), limit, offset,
          fields: fields || 'tag', format, extra: { source: 'local', ns },
        });
      }
    }

    // ③ 本地查不到才问站点
    return withClient(async ({ client, base, site }) => {
      const r = await need('browse').tagSuggest(client, { base, q });
      const items = (Array.isArray(r) ? r : (r?.items || []))
        .map((x) => (typeof x === 'string' ? { tag: x } : x));
      return packList('eh_tags', {
        site, items, limit, offset, fields: fields || 'tag,count', format,
        warnings: r?.warnings, extra: { source: 'site' },
      });
    });
  });

  // ⑧ 移植能力（参考仓库 Ehviewer_CN_SXJ）
  define('eh_toplists', {
    title: '排行榜',
    description: '排行榜，tl 选周期、p 翻页；4h~1y 需登录，未登录用 all。',
    inputSchema: {
      tl: z.enum(['4h', '1d', '1w', '1m', '1y', 'all']).optional().describe('时间窗，默认 1d'),
      p: z.number().int().min(0).max(199).optional().describe('页码，0 起，最多到 199'),
      ...listParams,
    },
  }, async ({ tl, p, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const period = tl || '1d';
    const page = p || 0;
    // 排行榜只有 EH 有：EXH 上 /toplist.php 一律 404，直接打 EH
    if (site === 'exhentai') {
      const url = buildListUrl(EH_BASE, { mode: 'toplist', page, adv: { tl: period } });
      const res = await fetchList(client, EH_BASE, url);
      return packList('eh_toplists', {
        site, items: res.items, limit, offset, fields, format,
        warnings: res.warnings, extra: { tl: period, p: page },
      });
    }
    if (typeof mods.browse?.toplists === 'function') {
      const r = await mods.browse.toplists(client, { base, period, page });
      const list = Array.isArray(r) ? r : (r?.items || []);
      if (list.length) {
        return packList('eh_toplists', {
          site, items: list, limit, offset, fields, format,
          warnings: r?.warnings, extra: { tl: period, p: page },
        });
      }
    }
    const host = String(base).replace(/\/+$/, '');
    const res = await fetchList(client, base, buildListUrl(host, { mode: 'toplist', page, adv: { tl: period } }));
    return packList('eh_toplists', {
      site, items: res.items, limit, offset, fields, format,
      warnings: res.warnings, extra: { tl: period, p: page },
    });
  }));

  define('eh_uploader', {
    title: '上传者作品',
    description: '某上传者的全部作品，名字从 eh_gallery 取。',
    inputSchema: {
      name: z.string().min(1).describe('上传者名字（原样，不需转义）'),
      page: z.number().int().min(0).max(2000).optional().describe('页码，从 0 开始'),
      ...listParams,
    },
  }, async ({ name, page, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const p = page || 0;
    if (typeof mods.browse?.uploaderGallery === 'function') {
      const r = await mods.browse.uploaderGallery(client, { base, name, page: p });
      const items = Array.isArray(r) ? r : (r?.items || []);
      return packList('eh_uploader', { site, items, limit, offset, fields, format, warnings: r?.warnings, extra: { uploader: name, p } });
    }
    const res = await fetchList(client, base, buildListUrl(base, { mode: 'uploader', query: name, page: p }));
    return packList('eh_uploader', { site, items: res.items, limit, offset, fields, format, warnings: res.warnings, extra: { uploader: name, p } });
  }));

  define('eh_tag_page', {
    title: 'tag 页',
    description: '站点原生 tag 页，比 f_search 更贴点标签。顺着 tag 翻页用它。',
    inputSchema: {
      tag: z.string().min(1).describe('tag，如 "female:sole_female" 或 "language:chinese"'),
      page: z.number().int().min(0).max(2000).optional().describe('页码，从 0 开始'),
      ...listParams,
    },
  }, async ({ tag, page, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const p = page || 0;
    if (typeof mods.browse?.tagGallery === 'function') {
      const r = await mods.browse.tagGallery(client, { base, tag, page: p });
      const items = Array.isArray(r) ? r : (r?.items || []);
      return packList('eh_tag_page', { site, items, limit, offset, fields, format, warnings: r?.warnings, extra: { tag, p } });
    }
    const res = await fetchList(client, base, buildListUrl(base, { mode: 'tag', query: tag, page: p }));
    return packList('eh_tag_page', { site, items: res.items, limit, offset, fields, format, warnings: res.warnings, extra: { tag, p } });
  }));

  define('eh_batch_meta', {
    title: '批量补元数据',
    description: 'gdata 批量补元数据，一次 ≤25 条。列表缺字段时用，别逐个开详情。',
    inputSchema: {
      items: z.array(z.object({
        gid: z.number().int().positive().describe('画廊 id'),
        token: z.string().min(1).describe('画廊 token'),
      })).min(1).max(25).describe('最多 25 条，超了要分批'),
      ...listParams,
    },
  }, async ({ items, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    if (typeof mods.browse?.batchMeta === 'function') {
      const r = await mods.browse.batchMeta(client, { base, items });
      const arr = Array.isArray(r) ? r : (r?.items || []);
      return packList('eh_batch_meta', {
        site: r?.site || site, items: arr, limit, offset, fields: fields || META_FIELDS, format,
        warnings: r?.warnings, extra: { requested: items.length },
      });
    }
    const host = String(base).replace(/\/+$/, '');
    const body = JSON.stringify({
      method: 'gdata',
      gidlist: items.map((i) => [i.gid, i.token]),
      namespace: 1,
    });
    const res = await client.post(`${host}/api.php`, {
      body,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      referer: `${host}/`,
    });
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error('api.php 回的不是 JSON：可能被限流，或 cookie 失效要重新登录。');
    }
    const list = (data?.gmetadata || []).map((g) => ({
      gid: g.gid,
      token: g.token,
      title: g.title,
      jtitle: g.title_jpn,
      category: g.category,
      posted: g.posted,
      uploader: g.uploader,
      pages: g.filecount,
      size: g.filesize,
      rating: Number(g.rating) || 0,
      torrents: g.torrentcount ?? (Array.isArray(g.torrents) ? g.torrents.length : 0),
      tags: Array.isArray(g.tags) ? g.tags.slice(0, 40) : [],
      thumb: g.thumb,
    }));
    return packList('eh_batch_meta', {
      site, items: list, limit, offset, fields: fields || META_FIELDS, format, extra: { requested: items.length },
    });
  }));

  define('eh_mytags', {
    title: '我的 tag 列表',
    description: '我用过的 tag 及次数，需登录。搭订阅前看口味。',
    inputSchema: { ...listParams },
  }, async ({ limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    if (typeof mods.browse?.myTags === 'function') {
      const r = await mods.browse.myTags(client, { base });
      const arr = Array.isArray(r) ? r : (r?.tags || []);
      return packList('eh_mytags', { site, items: arr, limit, offset, fields: fields || 'tag,count', format });
    }
    const host = String(base).replace(/\/+$/, '');
    const res = await client.get(`${host}/mytags`);
    const seen = new Map();
    // 页面里 tag 全是 /tag/<name> 链接，按出现顺序去重
    for (const m of res.text.matchAll(/\/tag\/([^"'\s>]+)/g)) {
      const raw = m[1].replace(/\+/g, ' ');
      let tag = raw;
      try { tag = decodeURIComponent(raw); } catch { /* 保底用原文 */ }
      if (!seen.has(tag)) seen.set(tag, 0);
    }
    const tags = [...seen.keys()].map((tag) => ({ tag }));
    return packList('eh_mytags', { site, items: tags, limit, offset, fields: fields || 'tag', format });
  }));

  define('eh_filter_list', {
    title: '看黑名单',
    description: '看本地黑名单。搜不出东西先查这里。',
    inputSchema: { ...listParams },
  }, async ({ limit, offset, fields, format }) => {
    const items = await readFilters();
    return packList('eh_filter_list', { items, limit, offset, fields: fields || 'id,field,pattern', format, extra: { path: filterFilePath() } });
  });

  define('eh_filter_add', {
    title: '加黑名单',
    description: '加一条黑名单关键词（title/tag/uploader）。eh_search filter=true 生效。',
    inputSchema: {
      pattern: z.string().min(1).describe('关键词（大小写不敏感，子串匹配）'),
      field: z.enum(['title', 'tag', 'uploader', 'any']).optional().describe('命中哪个字段，默认 any'),
      note: z.string().optional().describe('备注，方便以后认'),
    },
  }, async ({ pattern, field, note }) => {
    const f = field || 'any';
    const id = createHash('sha1').update(`${f}|${pattern.toLowerCase()}`).digest('hex').slice(0, 8);
    const items = await readFilters();
    if (items.some((x) => x.id === id)) {
      return ok({ added: false, reason: '已经有同样的规则了', item: items.find((x) => x.id === id) });
    }
    const item = { id, field: f, pattern, note: note || '', createdAt: new Date().toISOString() };
    items.push(item);
    await writeFilters(items);
    return ok({ added: true, item, total: items.length });
  });

  define('eh_filter_remove', {
    title: '删黑名单',
    description: '按 id 删黑名单规则，id 从 eh_filter_list 拿。',
    inputSchema: {
      id: z.string().min(1).describe('规则 id（eh_filter_list 里的 8 位哈希）'),
    },
  }, async ({ id }) => {
    const items = await readFilters();
    const next = items.filter((x) => x.id !== id);
    if (next.length === items.length) throw new Error(`没有 id=${id} 的规则，先 eh_filter_list 看看。`);
    await writeFilters(next);
    return ok({ removed: id, total: next.length });
  });

  // ⑨ 缩略图（返回 image content）
  define('eh_thumb', {
    title: '看缩略图',
    description: '回一张图片二进制给模型看。校验封面或图链是否有效时用。',
    inputSchema: {
      url: z.string().url().describe('图片 URL（http/https）'),
      referer: z.string().url().optional().describe('Referer，图片站防盗链时需要；默认用站点首页'),
    },
  }, async ({ url, referer }) => withClient(async ({ base, client }) => {
    // 二进制统一走 http.js 的 client.getBinary（cookie / 代理 / Referer 都在那边）
    const { buffer, headers, status } = await client.getBinary(url, { referer: referer || `${base}/` });
    if (!buffer || !buffer.length) throw new Error(`图片是空的（HTTP ${status}），地址可能失效了。`);
    const mimeType = String(headers?.['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!/^image\//.test(mimeType)) {
      throw new Error(`拿到的不是图片（Content-Type: ${mimeType}），可能要登录或地址过期。`);
    }
    return {
      content: [
        { type: 'image', data: buffer.toString('base64'), mimeType },
        { type: 'text', text: JSON.stringify({ bytes: buffer.length, mimeType, url }) },
      ],
    };
  }));

  /* ================================================================== */
  /* ⑩ 一步到位的复合工具                                                */
  /* ================================================================== */

  define('eh_find', {
    title: '找本（搜索+补全）',
    description: '搜索并用 gdata 补全，一步回精简列表。找本就先用它。',
    inputSchema: {
      query: z.string().describe('搜索词 / tag 组合'),
      category: z.union([z.number().int(), z.string(), z.array(z.string())]).optional().describe('分类掩码或名字，如 "doujinshi,manga"'),
      enrich: z.boolean().optional().describe('是否用 gdata 补页数/评分/体积，默认 true'),
      page: z.number().int().min(0).max(2000).optional().describe('站点页码，0 起'),
      filter: z.boolean().optional().describe('套用本地黑名单，默认 false'),
      ...listParams,
    },
  }, async ({ query, category, enrich, page, filter, limit, offset, fields, format }) => withClient(async ({ client, base, site }) => {
    const browse = need('browse');
    const r = await browse.search(client, { base, query, page: page || 0, category: category ?? null });
    let items = Array.isArray(r) ? r : (r?.items || []);
    const warnings = Array.isArray(r?.warnings) ? [...r.warnings] : [];

    if (filter) {
      const ap = applyFilters(items, await readFilters());
      items = ap.items;
    }

    // 只给要回的那几页补元数据：limit 条，gdata 上限 25
    if (enrich !== false && items.length) {
      const off = Math.max(0, Math.floor(Number(offset) || 0));
      const want = items.slice(off, off + Math.min(clampLimit(limit), 25));
      if (want.length) {
        try {
          const bm = await browse.batchMeta(client, { base, items: want.map((it) => galleryOf({ gid: it.gid, token: it.token })) });
          const map = new Map((bm?.items || []).map((m) => [String(m.gid), m]));
          const head = items.slice(0, off);
          const mid = want.map((it) => mergeMeta(it, map.get(String(it.gid))));
          items = [...head, ...mid, ...items.slice(off + want.length)];
        } catch (e) {
          warnings.push(`gdata 补全失败：${String(e?.message || e).slice(0, 50)}`);
        }
      }
    }

    return packList('eh_find', {
      site: r?.site || site, items, limit, offset,
      fields: fields || FIND_FIELDS, format, warnings,
    });
  }));

  define('eh_open', {
    title: '打开画廊（详情+图片直链）',
    description: '详情 + 前 N 页图片直链，一次拿全。要动手看图/下载前用它。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      pages: z.number().int().min(1).max(5).optional().describe('取前几页图片，默认 3，最多 5'),
      format: P_FORMAT,
    },
  }, async ({ gid, token, pages, format }) => withClient(async ({ client, base, site }) => {
    const d = await need('browse').galleryDetail(client, { base, gid, token });
    const detail = d?.detail || null;
    if (!detail) throw new Error(`拿不到 gid=${gid} 的详情：链接可能失效或要登录，先 eh_cookie_status。`);

    const n = Math.min(Math.max(Number(pages) || 3, 1), 5);
    const entries = await need('pages').listPages(client, { gallery: galleryOf({ gid, token, base }), from: 1, to: n });
    const images = [];
    const missed = [];
    for (const e of (Array.isArray(entries) ? entries : []).slice(0, n)) {
      const img = await need('pages').resolveImage(client, e.url);
      if (img?.url && !/509\.gif/.test(img.url)) images.push(img.url);
      else missed.push(e.index);
    }

    const body = {
      tool: 'eh_open', site: d?.site || site,
      gid, token, title: detail.title, pages: detail.pages,
      count: images.length, images,
    };
    if (missed.length) body.missed = missed;
    if (format === 'tsv') return out({ items: images.map((url, i) => ({ i: i + 1, url })) }, { format, keys: ['i', 'url'] });
    return out(body);
  }));

  define('eh_read', {
    title: '看内容（详情+缩略图）',
    description: '详情 + 前几页缩略图。先判断这本是什么再用它。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      count: z.number().int().min(1).max(3).optional().describe('最多回几张图，默认 3（含封面）'),
    },
  }, async ({ gid, token, count }) => withClient(async ({ cfg, client, base, site }) => {
    const d = await need('browse').galleryDetail(client, { base, gid, token });
    const detail = d?.detail || null;
    if (!detail) throw new Error(`拿不到 gid=${gid} 的详情：链接可能失效或要登录，先 eh_cookie_status。`);

    const want = Math.min(Math.max(Number(count) || 3, 1), 3);
    const galleryUrl = `${String(base).replace(/\/+$/, '')}/g/${gid}/${token}/`;

    // 封面 + 前几页真图。#gdt 里只有懒加载占位符（真图是 CSS 精灵），拿不到小图，
    // 所以页图走 resolveImage 解真链；count 越小越省 token。
    let urls = [];
    if (want > 1) {
      try {
        const entries = await need('pages').listPages(client, {
          gallery: galleryOf({ gid, token, base }), from: 1, to: want - 1,
        });
        for (const e of (Array.isArray(entries) ? entries : []).slice(0, want - 1)) {
          const img = await need('pages').resolveImage(client, e.url);
          if (img?.url && !/509\.gif/.test(img.url)) urls.push(img.url);
        }
      } catch { /* 页图拿不到就只回封面 */ }
    }
    const cover = detail.thumb || null;
    if (cover) urls = [cover, ...urls];
    urls = [...new Set(urls)].slice(0, want);

    const parts = [];
    for (const u of urls) {
      try {
        const { buffer, headers } = await client.getBinary(u, { referer: galleryUrl });
        const mimeType = String(headers?.['content-type'] || 'image/jpeg').split(';')[0].trim();
        if (!buffer?.length || !/^image\//.test(mimeType)) continue;
        parts.push({ type: 'image', data: buffer.toString('base64'), mimeType });
      } catch { /* 单张失败不影响整组 */ }
    }

    const meta = {
      tool: 'eh_read', site: d?.site || site,
      gid, token, title: detail.title, category: detail.category,
      pages: detail.pages, size: detail.size, rating: detail.rating,
      tagsCount: flattenDetail(detail).tagsCount, images: parts.length,
    };
    if (!parts.length) meta.warnings = ['没取到图，可能是登录墙或图链过期；先 eh_thumb 验一张。'];
    parts.push({ type: 'text', text: JSON.stringify(compact(meta)) });
    return { content: parts };
  }));

  define('eh_quick', {
    title: '开场三合一',
    description: '登录状态 + 首页最新 5 条 + 订阅新作。会话开头跑一次。',
    inputSchema: {
      limit: P_LIMIT,
    },
  }, async ({ limit }) => withClient(async ({ cfg, client, base, site }) => {
    const body = { tool: 'eh_quick', site };

    // ① 登录状态（也是站点连通性探测）
    try {
      const st = await need('auth').status({ cfg, client });
      body.loggedIn = Boolean(st?.loggedIn);
      if (st?.username) body.username = st.username;
    } catch (e) {
      body.loginError = humanize(e);
    }

    // ② 首页最新
    try {
      const r = await need('browse').recent(client, { base });
      const items = (Array.isArray(r) ? r : (r?.items || [])).slice(0, Math.min(clampLimit(limit), 5));
      body.recent = items.map((it) => shapeItem(it, ['gid', 'token', 'title', 'pages']));
    } catch (e) {
      body.recentError = humanize(e);
    }

    // ③ 订阅有没有新
    if (mods.subs && mods.store) {
      try {
        const list = await mods.store.listSubs();
        const subs = { count: Array.isArray(list) ? list.length : 0 };
        if (subs.count) {
          const res = await mods.subs.checkSubs({ client, base, cfg });
          const rows = [];
          for (const r of Array.isArray(res) ? res : []) {
            for (const it of (r?.newItems || [])) rows.push({ sub: r.query, ...shapeItem(it, ['gid', 'title']) });
          }
          subs.newCount = rows.length;
          if (rows.length) subs.items = rows.slice(0, 5);
          const errs = (Array.isArray(res) ? res : []).filter((r) => r?.error);
          if (errs.length) subs.errors = errs.slice(0, 3).map((r) => ({ sub: r.query, error: String(r.error).slice(0, 50) }));
        }
        body.subs = subs;
      } catch (e) {
        body.subs = { error: humanize(e) };
      }
    }

    return ok(body);
  }));

  define('eh_image_search', {
    title: '以图搜图',
    description: '上传一张图反查画廊，图源 path 或 url。手上有图没出处时用。',
    inputSchema: {
      path: z.string().optional().describe('本地图片路径'),
      url: z.string().url().optional().describe('图片 URL（先下载再上传）'),
      similar: z.boolean().optional().describe('相似图搜索，默认 true（fs_similar）'),
      includeExpunged: z.boolean().optional().describe('含已删除画廊（fs_exp）'),
      ...listParams,
    },
  }, async ({ path: sourcePath, url: sourceUrl, similar, includeExpunged, limit, offset, fields, format }) => withClient(async ({ cfg, client, base, site }) => {
    if (!sourcePath && !sourceUrl) throw new Error('给 path 或 url 其中一个。');
    const root = String(base).replace(/\/+$/, '');
    // EXH 的上传端点常年在 TLS 握手阶段被掐（本项目实测），失败就回落 EH 端点
    const endpoints = site === 'exhentai'
      ? ['https://upld.exhentai.org/upld/image_lookup.php', 'https://upld.e-hentai.org/image_lookup.php']
      : ['https://upld.e-hentai.org/image_lookup.php'];

    const file = await readUploadSource(client, { sourcePath, sourceUrl, referer: `${root}/` });

    const form = { f_sfile: 'File Search' }; // 固定字段，缺了站点不认
    if (similar !== false) form.fs_similar = 'on';
    if (includeExpunged) form.fs_exp = 'on';

    const headers = {
      referer: `${root}/`,
      origin: root,
      'user-agent': cfg?.userAgent
        || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    };
    const cookie = cookieHeader(cfg);
    if (cookie) headers.cookie = cookie;

    let got = null;
    let lastErr = null;
    for (const ep of endpoints) {
      try {
        got = await postMultipart(ep, { fields: form, file, headers, proxy: cfg?.proxy });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!got) throw lastErr || new Error('上传失败：两个上传端点都没通。');

    // 结果页可能被 302 到另一个站点（?f_shash=...），base 跟着跳转后的 origin 走
    const where = got.finalUrl || root;
    const parseBase = (() => { try { return new URL(where).origin; } catch { return root; } })();
    const realSite = mods.gallery?.siteFromBase?.(parseBase) || site;

    const parsed = need('gallery').parseGalleryList(got.text || '', { base: parseBase });
    const items = Array.isArray(parsed) ? parsed : [];
    if (!items.length) throw new Error('没解析到结果：这张图可能没被索引到，换张清晰的或先登录再试。');

    return packList('eh_image_search', {
      site: realSite, items, limit: limit ?? 10, offset,
      fields: fields || FIND_FIELDS, format,
      extra: { uploaded: file.filename },
    });
  }));

  // ⑨ 本地库（下载目录索引）+ 收藏夹离线
  define('eh_local_index', {
    title: '本地库索引',
    description: '扫下载目录建索引（action=rebuild），或看统计（action=stats）。本地搜索前先建一次。',
    inputSchema: {
      action: z.enum(['rebuild', 'stats']).optional().describe('rebuild=重建/增量，stats=看统计'),
      root: z.string().optional().describe('下载根目录，默认取配置的 downloadDir'),
      force: z.boolean().optional().describe('true=忽略 mtime 缓存全量重扫'),
    },
  }, async ({ action, root, force }) => withClient(async ({ cfg }) => {
    const li = need('local-index');
    const targetRoot = root || cfg?.downloadDir;
    if (action === 'stats') return ok(await li.indexStats());
    if (!targetRoot) throw new Error('没有可扫的目录：传 root，或先 eh_config_set 设 downloadDir。');
    return ok(await li.rebuildIndex({ root: targetRoot, force: !!force }));
  }));

  define('eh_local_search', {
    title: '本地库搜索',
    description: '在下好的画廊里搜：关键词/tag/缩写/正则，如 f:tentacles、-loli。',
    inputSchema: {
      query: z.string().min(1).describe('查询串：裸关键词、ns:value、f:缩写、/正则/、-排除、| 或'),
      sort: z.enum(['downloadedAt', 'pages', 'size', 'title']).optional().describe('排序，默认 downloadedAt desc'),
      ...listParams,
    },
  }, async ({ query, sort, limit, offset, fields, format }) => {
    const li = need('local-index');
    const r = li.searchWithMeta ? li.searchWithMeta(query, { limit: limit ?? LIMIT_DEFAULT, offset: offset ?? 0, sort })
      : { items: li.search(query, { limit: limit ?? LIMIT_DEFAULT, offset, sort }), total: null, warnings: [] };
    return ok({
      tool: 'eh_local_search',
      count: (r.items || []).length,
      ...(r.total != null ? { total: r.total } : {}),
      ...(r.items || []).length === (limit ?? LIMIT_DEFAULT) ? { hasMore: true } : {},
      items: (r.items || []).map((it) => compact(it, fields || 'gid,token,title,pages,dir', format)),
      ...(r.warnings && r.warnings.length ? { warnings: r.warnings.slice(0, 3) } : {}),
    });
  });

  define('eh_fav_local', {
    title: '收藏夹离线搜',
    description: '搜本地缓存的收藏（先 eh_favorites cache=true 存过），断网也能用。',
    inputSchema: {
      query: z.string().optional().describe('搜索词，支持 title:/tags:/note:/gid:/cat: 前缀'),
      ...listParams,
    },
  }, async ({ query, limit, offset, fields, format }) => {
    const st = need('store');
    if (typeof st.searchFavorites !== 'function') throw new Error('store.js 还没有离线搜（版本偏旧）。');
    const items = await st.searchFavorites(query || '', { limit: LIMIT_MAX });
    return packList('eh_fav_local', {
      items, limit, offset, fields: fields || 'gid,token,title', format,
    });
  });

  // ⑩ 评论区与本地笔记（线上/离线都写同一份库，按 gid 对齐）
  define('eh_comments', {
    title: '评论区',
    description: '读这本的在线评论（作者/评分/正文），有没有下载过都行。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      token: z.string().min(1).describe('画廊 token'),
      limit: z.number().int().min(1).max(200).optional().describe('最多几条，默认 20；评论多的本子用 offset 翻'),
      offset: z.number().int().min(0).optional().describe('跳过前 N 条，默认 0'),
      full: z.boolean().optional().describe('true 连投票明细一起回'),
    },
  }, async ({ gid, token, limit, offset, full }) => withClient(async ({ client, base, site }) => {
    const r = await need('gallery').galleryComments(client, { gid, token, base });
    const all = r.comments || [];
    const off = offset ?? 0;
    const take = limit ?? 20;
    const items = all.slice(off, off + take).map((c) => ({
      id: c.id, at: c.at, author: c.author, score: c.score, text: c.text,
      ...(full && c.votes ? { votes: c.votes } : {}),
    }));
    // 顺手缓存一份，面板离线也能看评论区（失败不影响返回）
    try {
      await mods.store?.saveComments?.({ gid, token, title: r.title || '', url: r.url, comments: r.comments });
    } catch { /* 缓存是加分项 */ }

    return ok({
      tool: 'eh_comments', site, count: items.length, total: all.length,
      ...(off + take < all.length ? { nextOffset: off + take } : {}),
      items,
      ...(Array.isArray(r.warnings) && r.warnings.length ? { warnings: r.warnings.slice(0, 3) } : {}),
    });
  }));

  define('eh_note_save', {
    title: '写笔记',
    description: '给这本留感想（线上看的、下载后看的都行，按 gid 存）。',
    inputSchema: {
      gid: z.number().int().positive().describe('画廊 id'),
      note: z.string().min(1).describe('感想正文'),
      token: z.string().optional().describe('token，带上后面板能直接跳转'),
      title: z.string().optional().describe('标题；不传沿用已存的'),
      rating: z.number().min(1).max(10).optional().describe('自己的打分 1~10'),
      source: z.enum(['online', 'local']).optional().describe('online=线上看的，local=下载后看的'),
    },
  }, async (args) => {
    const rec = await need('notes').saveNote(args);
    return ok({ tool: 'eh_note_save', gid: rec.gid, updatedAt: rec.updatedAt, saved: true });
  });

  define('eh_note_list', {
    title: '笔记列表',
    description: '列 / 搜本地笔记，新的在前。',
    inputSchema: {
      query: z.string().optional().describe('按标题、正文、tag 模糊搜'),
      limit: z.number().int().min(1).max(100).optional().describe('默认 20'),
    },
  }, async ({ query, limit }) => {
    const r = await need('notes').listNotes({ query: query || '', limit: limit ?? 20 });
    return ok({ tool: 'eh_note_list', count: r.items.length, total: r.total, items: r.items });
  });

  define('eh_note_remove', {
    title: '删笔记',
    description: '删掉这本的笔记。',
    inputSchema: { gid: z.number().int().positive().describe('画廊 id') },
  }, async ({ gid }) => {
    const removed = await need('notes').removeNote(gid);
    return ok({ tool: 'eh_note_remove', gid, removed });
  });

  return { server, toolNames: TOOL_NAMES.slice(), warnings: loadWarnings };
}

// ── 直接运行时启动 stdio ──────────────────────────────────────────────────
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return pathToFileURL(entry).href === import.meta.url; } catch { return false; }
})();

if (isMain) {
  const { server, toolNames, warnings } = await buildServer();

  for (const w of warnings) {
    process.stderr.write(`[eh-mcp] 警告：src/${w.module}.js 未就绪（${w.reason}），相关工具调用会返回提示。\n`);
  }
  // stdio 协议占着 stdout，日志一律走 stderr
  process.stderr.write(
    `[eh-mcp] v${VERSION} 已启动 · 工具 ${toolNames.length}/${TOOL_NAMES.length} 个 · node ${process.version}\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (sig) => {
    process.stderr.write(`[eh-mcp] 收到 ${sig}，退出。\n`);
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ── 给离线测试用的纯函数出口（不联网） ────────────────────────────────────
export const __compact = {
  shapeItem,
  compact,
  toTsv,
  parseFields,
  packList,
  flattenDetail,
  mergeMeta,
  clampLimit,
  humanize,
  DEFAULTS: {
    LIST_FIELDS, FIND_FIELDS, GALLERY_FIELDS, META_FIELDS, PAGE_FIELDS, SUB_FIELDS, HIST_FIELDS,
    LIMIT_DEFAULT, LIMIT_MAX,
  },
};
