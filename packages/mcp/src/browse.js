/**
 * browse.js — 搜索 / 热门 / 首页最新 / watched / 收藏 / 标签补全 / gdata 批量元数据
 *
 * 一律走 http.js 的 client（契约第 1 条），返回值统一带 `site` 与 `warnings`：
 *   列表类 -> { items, site, warnings, ... }
 *   详情类 -> { detail, site, warnings }
 *
 * 网络错误除 EHBlocked 外都降级为 warnings，不抛（解析层更不能抛）。
 * EHBlocked 原样上抛，让上层能提示「站点临时封禁」。
 */

import {
  absUrl,
  buildListUrl,
  buildSearchUrl,
  galleryUrl,
  parseGalleryDetail,
  parseGalleryList,
  parseNextPage,
  siteFromBase,
} from './gallery.js';
import { suggestTags as localSuggestTags } from './tags.js';

const DEFAULT_BASE = 'https://e-hentai.org';

/** 联想结果的条数上限：搜索框里再多也没人看，模型也会照着塞满 */
const TAG_SUGGEST_LIMIT = 25;

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function isBlocked(e) {
  return !!e && (e.name === 'EHBlocked' || e.constructor?.name === 'EHBlocked');
}

/**
 * GET 一个页面并解析列表。
 * @returns {{ok: boolean, items: any[], html: string, warnings: string[]}}
 */
async function fetchList(client, url, base) {
  const warnings = [];
  let res;
  try {
    res = await client.get(url);
  } catch (e) {
    if (isBlocked(e)) throw e;
    return { ok: false, items: [], html: '', warnings: [`请求失败: ${e.message}`] };
  }
  if (!res?.text) {
    return { ok: false, items: [], html: '', warnings: [`响应为空（status=${res?.status ?? 'unknown'}）`] };
  }
  if (res.status && res.status >= 400) warnings.push(`HTTP ${res.status}`);

  const items = parseGalleryList(res.text, { base });
  for (const w of items.warnings || []) warnings.push(w);
  return { ok: true, items, html: res.text, warnings, status: res.status, finalUrl: res.finalUrl };
}

function jsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch {
    // 兼容响应前后有 BOM / 空白
    try {
      return JSON.parse(String(str).replace(/^\uFEFF/, '').trim());
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* gdata 批量元数据（最重要的性能项）                                   */
/* ------------------------------------------------------------------ */

// 记录哪种 POST 形态被服务端接受了，后续调用不再逐个试探
let postJsonMode = null;

/**
 * POST JSON 到 api.php。
 * http.js 契约只写了 {form}，所以这里按 json → body → form 三级退让，
 * 第一次成功后记住可用形态。
 */
async function postJson(client, url, payload, referer) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const modes = postJsonMode ? [postJsonMode] : ['json', 'body', 'form'];
  const errs = [];

  for (const mode of modes) {
    const opts = { headers };
    if (referer) opts.referer = referer;
    if (mode === 'json') opts.json = payload;
    else if (mode === 'body') opts.body = JSON.stringify(payload);
    else opts.form = { json: JSON.stringify(payload) };

    let res;
    try {
      res = await client.post(url, opts);
    } catch (e) {
      if (isBlocked(e)) throw e;
      errs.push(`${mode}: ${e.message}`);
      continue;
    }
    if (!res?.text) {
      errs.push(`${mode}: 空响应 (status=${res?.status ?? '?'})`);
      continue;
    }
    const parsed = jsonSafe(res.text);
    if (parsed && (parsed.gmetadata || parsed.error || parsed.errorcode)) {
      postJsonMode = mode;
      return { ok: !parsed.error, json: parsed, status: res.status, mode };
    }
    errs.push(`${mode}: 非 JSON 响应 (status=${res?.status ?? '?'})`);
  }
  return { ok: false, json: null, error: errs.join(' | ') };
}

/** 字节数 → "83.28 MiB"（gdata 的 filesize 是字节数字符串） */
function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${i === 0 ? x : x.toFixed(2)} ${units[i]}`;
}

/** unix 秒 → "YYYY-MM-DD HH:mm"（站点按 UTC 显示，实测 posted 与详情页一致） */
function formatPosted(v) {
  const s = String(v ?? '');
  if (/^\d{9,11}$/.test(s)) {
    const d = new Date(Number(s) * 1000);
    if (!Number.isNaN(d.getTime())) {
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    }
  }
  return s;
}

/** 把 gdata 的一条元数据合并进列表项（不覆盖已有的非空字段以外的东西，只补/纠偏） */
function applyMeta(item, m) {
  if (!m) return item;
  const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t)) : [];
  const tagsByNs = {};
  for (const t of tags) {
    const i = t.indexOf(':');
    const ns = i > 0 ? t.slice(0, i).toLowerCase() : 'other';
    const v = i > 0 ? t.slice(i + 1) : t;
    (tagsByNs[ns] = tagsByNs[ns] || []).push(v);
  }
  return {
    ...item,
    title: m.title || item.title || '',
    titleJpn: m.title_jpn || '',
    category: m.category || item.category || '',
    thumb: m.thumb ? absUrl(m.thumb) : item.thumb || '',
    uploader: m.uploader || item.uploader || '',
    posted: m.posted ? formatPosted(m.posted) : item.posted || '',
    pages: Number.isFinite(Number(m.filecount)) && Number(m.filecount) > 0 ? Number(m.filecount) : item.pages ?? null,
    size: m.filesize ? formatBytes(m.filesize) : item.size || '',
    sizeBytes: Number(m.filesize) || null,
    rating: Number.isFinite(Number(m.rating)) && Number(m.rating) > 0 ? Number(m.rating) : item.rating ?? null,
    tags,
    tagsByNs,
    torrentCount: Number(m.torrentcount || 0),
    torrents: Array.isArray(m.torrents) ? m.torrents.map((t) => ({ name: t.name || '', url: t.hash ? absUrl(`/torrent/${t.hash}`) : t.url || '' })) : [],
  };
}

/**
 * 用 api.php 的 gdata 批量补全列表项（比逐个请求详情页快一个数量级）。
 * @param {{base?: string, items: object[]}} opts
 * @returns {Promise<{items: object[], site: string, warnings: string[]}>}
 */
export async function batchMeta(client, { base = DEFAULT_BASE, items = [] } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const site = siteFromBase(b);
  const warnings = [];
  const list = Array.isArray(items) ? items.filter((i) => i && i.gid && i.token) : [];

  if (!list.length) {
    return { items: [], site, warnings: ['items 为空或都缺 gid/token，未请求 api.php'] };
  }

  const apiUrl = `${b}/api.php`;
  const CHUNK = 25; // 站点硬限制：每批最多 25 条
  const merged = new Map();
  let okBatches = 0;

  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const payload = {
      method: 'gdata',
      gidlist: chunk.map((x) => [Number(x.gid), String(x.token)]),
      namespace: 1,
    };
    const r = await postJson(client, apiUrl, payload, `${b}/`);
    if (!r.ok) {
      warnings.push(`gdata 第 ${i / CHUNK + 1} 批失败：${r.error || r.json?.error || '未知错误'}`);
      continue;
    }
    okBatches += 1;
    const meta = r.json.gmetadata || [];
    for (const m of meta) merged.set(String(m.gid), m);
    if (meta.length < chunk.length) {
      warnings.push(`gdata 第 ${i / CHUNK + 1} 批只回 ${meta.length}/${chunk.length} 条（可能已删除/私有）`);
    }
  }

  const out = list.map((it) => applyMeta(it, merged.get(String(it.gid))));
  if (!okBatches) warnings.push('所有 gdata 批次都失败，items 未经补全');
  if (postJsonMode && postJsonMode !== 'json') {
    warnings.push(`api.php 只接受 {${postJsonMode}} 形态的 POST（http.js 的 post 需要支持它）`);
  }

  return { items: out, site, warnings, batches: Math.ceil(list.length / CHUNK) };
}

/* ------------------------------------------------------------------ */
/* 详情 / 列表                                                         */
/* ------------------------------------------------------------------ */

/**
 * 画廊详情页。
 * @returns {Promise<{detail: object|null, site: string, warnings: string[]}>}
 */
export async function galleryDetail(client, { base = DEFAULT_BASE, gid, token } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const site = siteFromBase(b);
  const warnings = [];
  const url = galleryUrl(gid, token, b);
  if (!url) return { detail: null, site, warnings: ['gid/token 缺失'] };

  let res;
  try {
    res = await client.get(url);
  } catch (e) {
    if (isBlocked(e)) throw e;
    return { detail: null, site, warnings: [`请求失败: ${e.message}`] };
  }
  if (!res?.text) return { detail: null, site, warnings: [`响应为空（status=${res?.status ?? 'unknown'}）`] };
  if (res.status && res.status >= 400) warnings.push(`HTTP ${res.status}`);

  const detail = parseGalleryDetail(res.text, { base: b, gid, token });
  if (!detail) warnings.push('详情页解析失败（可能是登录墙/失效链接）');
  else for (const w of detail.warnings || []) warnings.push(w);

  // 未登录访问 exhentai 会 302 回 e-hentai，这里把真实站点回传
  const realSite = res.finalUrl ? siteFromBase(res.finalUrl) : site;
  if (res.finalUrl && !String(res.finalUrl).includes(new URL(b).host)) {
    warnings.push(`被重定向到 ${res.finalUrl}`);
  }

  // 记一条浏览历史（agent 看过什么，后面 DSH-EH 面板要展示）：失败不影响主流程
  if (detail) {
    import('./store.js')
      .then((st) => st.addHistory?.({
        type: 'view',
        gid: Number(gid) || detail.gid || null,
        token: token || detail.token || '',
        title: detail.title || '',
        jtitle: detail.jtitle || '',
        pages: detail.pages ?? null,
        site: realSite,
        url: res.finalUrl || url,
      }))
      .catch(() => {});
  }

  return { detail, site: realSite, warnings };
}

/** 搜索 */
export async function search(client, { base = DEFAULT_BASE, query = '', page = 0, category = null } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const url = buildSearchUrl({ base: b }, { query, page, category });
  const r = await fetchList(client, url, b);
  const nav = r.html ? parseNextPage(r.html, { base: b }) : { next: '', prev: '' };
  return { items: r.items, site: siteFromBase(b), warnings: r.warnings, url, ...nav };
}

/**
 * 热门。
 * - 不传 period：`/popular`（"what's hot" 通栏页，和 toplist 不是一个页面）
 * - 传 period（4h/1d/1w/1m/1y/all）：走 `/toplist.php?tl=<period>`
 */
export async function popular(client, { base = DEFAULT_BASE, period = null } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const url = period
    ? buildListUrl(b, { mode: 'toplist', adv: { tl: period } })
    : `${b}/popular`;
  const r = await fetchList(client, url, b);
  const warnings = [...r.warnings];
  if (!r.items.length) warnings.push(`没解析到条目（${period ? 'toplist' : '/popular'} 页面结构可能变化）`);
  return { items: r.items, site: siteFromBase(b), warnings, url };
}

/** 排行榜（toplist.php），周期 + 页码 */
export async function toplists(client, { base = DEFAULT_BASE, period = '1d', page = 0 } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const url = buildListUrl(b, { mode: 'toplist', page, adv: { tl: period } });
  const r = await fetchList(client, url, b);
  return { items: r.items, site: siteFromBase(b), warnings: r.warnings, url, period };
}

/** 首页最新 */
export async function recent(client, { base = DEFAULT_BASE } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const r = await fetchList(client, `${b}/`, b);
  return { items: r.items, site: siteFromBase(b), warnings: r.warnings, url: `${b}/` };
}

/** 我订阅的画廊（需要登录） */
export async function watched(client, { base = DEFAULT_BASE, query = '', page = 0 } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const url = buildListUrl(b, { mode: 'watched', keyword: query, page });
  const r = await fetchList(client, url, b);
  const warnings = [...r.warnings];
  if (!r.items.length) warnings.push('watched 没有条目：未登录时会 302 到登录页');
  return { items: r.items, site: siteFromBase(b), warnings, url };
}

/* ------------------------------------------------------------------ */
/* 收藏夹                                                              */
/* ------------------------------------------------------------------ */

/**
 * 收藏夹分类归一：0..9 是槽位，'all' 是全部（站点也接受 -1，效果同 all）。
 * 非法值退回 0，别把 favcat=NaN 甩给站点换一页 400。
 */
function normalizeFavCat(cat) {
  const s = String(cat ?? '').trim().toLowerCase();
  if (!s) return '0';
  if (s === 'all' || s === '-1') return 'all';
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? String(n) : '0';
}

/**
 * 收藏夹 URL。参数照抄 Ehviewer 的 FavListUrlBuilder：
 *   favcat=<0-9|all>&f_search=<urlenc>&sn=on&st=on&sf=on&page=<n>
 * sn/st/sf 分别表示「搜名称 / 搜标签 / 搜收藏备注」，三个都必须给：
 * 少给一个，站点就少搜一个字段，用户的备注就搜不出来。
 * 没有 query 时不带 sn/st/sf，跟旧行为一致。
 */
export function buildFavoritesUrl(base, { cat = 0, page = 0, query = '' } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const q = String(query ?? '').trim();
  const p = Math.max(0, Math.floor(Number(page) || 0));

  const params = [`favcat=${encodeURIComponent(normalizeFavCat(cat))}`];
  if (q) {
    params.push(`f_search=${encodeURIComponent(q)}`, 'sn=on', 'st=on', 'sf=on');
  }
  params.push(`page=${p}`);
  return `${b}/favorites.php?${params.join('&')}`;
}

/** 收藏夹列表；query 非空时在收藏夹内搜索（名称 + 标签 + 收藏备注） */
export async function favorites(client, { base = DEFAULT_BASE, cat = 0, page = 0, query = '' } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const q = String(query ?? '').trim();
  const catNorm = normalizeFavCat(cat);
  const url = buildFavoritesUrl(b, { cat: catNorm, page, query: q });
  const r = await fetchList(client, url, b);
  const warnings = [...r.warnings];
  if (!r.items.length) {
    warnings.push(
      q
        ? `收藏夹里没有匹配「${q}」的条目（搜的是名称/标签/备注）`
        : '收藏夹为空或未登录（favcat=0..9，favdel=已删除）',
    );
  }
  return { items: r.items, site: siteFromBase(b), warnings, url, cat: catNorm, query: q };
}

/**
 * 收藏备注（favnote）在页面上的容器换过几版：老布局是 .glft，
 * 新表格布局塞在 td.gl3c 里，镜像站还可能用 [class*=note]。
 * 这里逐层试，抓不到就整体返回空对象 + warning（契约第 4 条：解析层不抛）。
 */
const NOTE_SELECTORS = ['.glft', '.glfnote', '.glfavnote', '.favnote', '.glnote', '[class*="favnote"]', '[class*="glft"]'];

/** 从收藏页 HTML 里抠 {gid: note}（导出的内部件，测试直接用） */
export async function parseFavNotes(html) {
  const notes = {};
  if (typeof html !== 'string' || !html.trim()) return { notes, warnings: ['收藏页 HTML 为空'] };

  let $;
  try {
    const { load } = await import('cheerio');
    $ = load(html);
  } catch (e) {
    return { notes, warnings: [`HTML 解析失败: ${e.message}`] };
  }

  /** 画廊所在的最小容器：表格行 / 卡片 / 退化到父节点 */
  const cellOf = (el) => {
    const cell = $(el).closest('.gl1t, .gl1e, tr').first();
    return cell.length ? cell : $(el).parent();
  };

  const noteOf = (cell) => {
    for (const sel of NOTE_SELECTORS) {
      const node = cell.find(sel).first();
      if (!node.length) continue;
      const t = node.text().replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return '';
  };

  $('a[href*="/g/"]').each((_, a) => {
    const m = String($(a).attr('href') || '').match(/\/g\/(\d+)\/([0-9a-z]+)/i);
    if (!m || notes[m[1]]) return;
    const note = noteOf(cellOf(a));
    if (note) notes[m[1]] = note;
  });

  // 反向兜底：备注节点不在容器里（结构又变了），就从备注节点找最近的画廊链接
  if (!Object.keys(notes).length) {
    $(NOTE_SELECTORS.join(',')).each((_, el) => {
      const node = $(el);
      const t = node.text().replace(/\s+/g, ' ').trim();
      if (!t) return;
      const scope = node.closest('.gl1t, .gl1e, tr').length ? node.closest('.gl1t, .gl1e, tr') : node.parent();
      const href = String(scope.find('a[href*="/g/"]').first().attr('href') || '');
      const m = href.match(/\/g\/(\d+)\/([0-9a-z]+)/i);
      if (m && !notes[m[1]]) notes[m[1]] = t;
    });
  }

  return { notes, warnings: [] };
}

/**
 * 拉一个收藏槽位并解析每本的收藏备注。
 * @returns {Promise<{notes: Record<string,string>, site: string, warnings: string[], url: string}>}
 */
export async function favNotes(client, { base = DEFAULT_BASE, cat = 0, page = 0 } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const catNorm = normalizeFavCat(cat);
  const url = buildFavoritesUrl(b, { cat: catNorm, page });

  let res;
  try {
    res = await client.get(url);
  } catch (e) {
    if (isBlocked(e)) throw e;
    return { notes: {}, site: siteFromBase(b), warnings: [`请求失败: ${e.message}`], url };
  }
  if (!res?.text) {
    return { notes: {}, site: siteFromBase(b), warnings: [`响应为空（status=${res?.status ?? 'unknown'}）`], url };
  }

  const parsed = await parseFavNotes(res.text);
  const warnings = [...parsed.warnings];
  if (res.status && res.status >= 400) warnings.push(`HTTP ${res.status}`);
  if (!Object.keys(parsed.notes).length) {
    warnings.push('收藏页里没解析到备注（可能没人写备注，或页面结构变了）');
  }
  return { notes: parsed.notes, site: siteFromBase(b), warnings, url };
}

/** 上传者画廊 */
export async function uploaderGallery(client, { base = DEFAULT_BASE, name = '', page = 0 } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  if (!name) return { items: [], site: siteFromBase(b), warnings: ['name 缺失'] };
  const url = buildListUrl(b, { mode: 'uploader', keyword: name, page });
  const r = await fetchList(client, url, b);
  return { items: r.items, site: siteFromBase(b), warnings: r.warnings, url };
}

/** 标签页画廊 */
export async function tagGallery(client, { base = DEFAULT_BASE, tag = '', page = 0 } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  if (!tag) return { items: [], site: siteFromBase(b), warnings: ['tag 缺失'] };
  const url = buildListUrl(b, { mode: 'tag', keyword: tag, page });
  const r = await fetchList(client, url, b);
  return { items: r.items, site: siteFromBase(b), warnings: r.warnings, url };
}

/** 我的标签（/mytags，需要登录） */
export async function myTags(client, { base = DEFAULT_BASE } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const url = `${b}/mytags`;
  const warnings = [];
  let res;
  try {
    res = await client.get(url);
  } catch (e) {
    if (isBlocked(e)) throw e;
    return { items: [], tags: [], site: siteFromBase(b), warnings: [`请求失败: ${e.message}`] };
  }
  if (!res?.text) return { items: [], tags: [], site: siteFromBase(b), warnings: ['响应为空'] };

  const { load } = await import('cheerio');
  const $ = load(res.text);
  const seen = new Set();
  const items = [];
  $('a[href*="/tag/"]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    const m = href.match(/\/tag\/([^/?#]+)/i);
    if (!m) return;
    const tag = decodeURIComponent(m[1].replace(/\+/g, ' '));
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    // 行尾常有计数，取所在行文本里的数字
    const rowText = $(a).closest('tr, div').text().replace(/\s+/g, ' ');
    const count = Number(rowText.match(/(\d+)\s*$/)?.[1] || 0);
    items.push({ tag, url: absUrl(href, b), count });
  });
  if (!items.length) warnings.push('mytags 里没有标签（未登录或没有 watch 的标签）');
  return { items, tags: items.map((i) => i.tag), site: siteFromBase(b), warnings };
}

/* ------------------------------------------------------------------ */
/* 收藏写入                                                            */
/* ------------------------------------------------------------------ */

/**
 * 加入收藏。
 * 首选 POST gallerypopups.php（站点真实表单），失败再退 GET `?fav=<slot>`。
 * @param slot 0-9；`favdel` 或 -1 表示移除
 */
export async function favAdd(client, { base = DEFAULT_BASE, gid, token, slot = 0 } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const site = siteFromBase(b);
  const warnings = [];
  if (!gid || !token) return { ok: false, slot, site, warnings: ['gid/token 缺失'] };

  const gUrl = galleryUrl(gid, token, b);
  const isDel = String(slot) === 'favdel' || Number(slot) < 0;

  // 1) 真实表单提交
  const popup = `${b}/gallerypopups.php?gid=${encodeURIComponent(gid)}&t=${encodeURIComponent(token)}&act=addfav`;
  try {
    const res = await client.post(popup, {
      form: { favcat: isDel ? '-1' : String(slot), favnote: '', apply: 'Apply Changes' },
      referer: gUrl,
    });
    if (res && res.status && res.status < 400) {
      return { ok: true, slot: isDel ? -1 : Number(slot), site, warnings, via: 'gallerypopups' };
    }
    warnings.push(`gallerypopups POST 返回 ${res?.status ?? '无响应'}，改用 ?fav=`);
  } catch (e) {
    if (isBlocked(e)) throw e;
    warnings.push(`gallerypopups POST 失败: ${e.message}，改用 ?fav=`);
  }

  // 2) 退化路径：直接 GET ?fav=<slot>
  try {
    const res = await client.get(`${gUrl}?fav=${encodeURIComponent(isDel ? 'favdel' : slot)}`);
    const ok = !!res && (!res.status || res.status < 400);
    if (!ok) warnings.push(`?fav= 返回 ${res?.status ?? '无响应'}`);
    return { ok, slot: isDel ? -1 : Number(slot), site, warnings, via: 'querystring' };
  } catch (e) {
    if (isBlocked(e)) throw e;
    warnings.push(`?fav= 失败: ${e.message}`);
    return { ok: false, slot: isDel ? -1 : Number(slot), site, warnings };
  }
}

/* ------------------------------------------------------------------ */
/* 标签补全                                                            */
/* ------------------------------------------------------------------ */

/** 远端补全整体失败过一次就别再试了：联想是高频输入，反复打站点只会换来限速 */
let remoteSuggestDead = false;

/** 本地字典兜底（不联网）。字典坏了也只是返回空数组，不影响远端那条路 */
function localSuggest(query, limit) {
  try {
    return localSuggestTags(query, { limit });
  } catch {
    return [];
  }
}

/** 远端补全接口：不同站点/版本路径不一，按顺序试，第一个有结果的赢 */
async function remoteApiSuggest(client, base, query) {
  const candidates = [
    `${base}/api.php?method=tags&q=${encodeURIComponent(query)}`,
    `${base}/api.php?method=tagsuggest&q=${encodeURIComponent(query)}`,
  ];
  for (const url of candidates) {
    let res;
    try {
      res = await client.get(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      if (isBlocked(e)) throw e;   // 封站点要让上层知道
      continue;
    }
    const parsed = res?.text ? jsonSafe(res.text) : null;
    if (!parsed) continue;
    const arr = Array.isArray(parsed) ? parsed : parsed.tags || parsed.suggestions || parsed.data;
    if (!Array.isArray(arr) || !arr.length) continue;
    const list = arr.map((it) => (typeof it === 'string' ? it : it?.tag || it?.name || it?.value));
    return normalizeTags(list);
  }
  return [];
}

/** 退化路径：抓搜索页里的 tag 块（`#taglist a` / `.gt` / 标签页链接） */
async function remotePageSuggest(client, base, query) {
  const r = await fetchList(client, buildSearchUrl({ base }, { query, page: 0 }), base);
  if (!r.html) return { tags: [], warnings: r.warnings };

  const { load } = await import('cheerio');
  const $ = load(r.html);
  const q = query.toLowerCase();
  const tags = [];
  const take = (raw) => {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t || !t.toLowerCase().includes(q)) return;
    tags.push(t);
  };

  $('.gt, #taglist a').each((_, el) => take($(el).attr('title') || $(el).text()));
  $('a[href*="/tag/"]').each((_, a) => {
    const m = String($(a).attr('href')).match(/\/tag\/([^/?#]+)/i);
    if (m) take(decodeURIComponent(m[1].replace(/\+/g, ' ')));
  });
  return { tags: normalizeTags(tags), warnings: [] };
}

/** 去空、去重、限长 25（站点与模型都只需要这么多） */
function normalizeTags(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const v = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= TAG_SUGGEST_LIMIT) break;
  }
  return out;
}

/**
 * 标签补全：本地字典优先，远端只用来补本地没有的。
 *
 * 为什么本地优先：中文输入（"巨乳"）站点补全根本不认识，而 4.5 万条的本地字典能直接答；
 * 远端 /mytags 与 api.php 的补全接口经常挂（要登录/已下线），失败时用本地兜底而不是给空结果。
 *
 * @returns {Promise<string[]>} 数组上挂不可枚举的 .warnings
 */
export async function tagSuggest(client, { base = DEFAULT_BASE, q = '' } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const query = String(q || '').trim();
  const warnings = [];

  if (!query) {
    return withWarnings([], ['q 为空']);
  }

  const local = localSuggest(query, TAG_SUGGEST_LIMIT);
  if (local.length >= TAG_SUGGEST_LIMIT || remoteSuggestDead) {
    return withWarnings(local, local.length ? [] : ['本地无命中，且远端补全已放弃']);
  }

  let remote = [];
  try {
    remote = await remoteApiSuggest(client, b, query);
    if (!remote.length) {
      const page = await remotePageSuggest(client, b, query);
      remote = page.tags;
      warnings.push(...page.warnings);
      if (!remote.length) warnings.push('站点补全无结果，已用本地标签库兜底');
    }
  } catch (e) {
    if (isBlocked(e)) throw e;
    remoteSuggestDead = true;
    warnings.push(`远端补全不可用（${e.message}），改用本地标签库`);
  }

  // 本地在前、远端补位（远端可能给出本地没收录的新 tag）
  const merged = normalizeTags([...local, ...remote]);
  if (!merged.length) warnings.push('本地与远端都没有命中');
  return withWarnings(merged, warnings);
}

/** 保持老契约：warnings 挂在数组上但不参与 JSON 序列化 */
function withWarnings(list, warnings) {
  Object.defineProperty(list, 'warnings', { value: warnings, enumerable: false });
  return list;
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

/** 不发网络的形状自检：验证导出齐全 + batchMeta 的分批与字段合并 */
export async function __selftest() {
  const out = { module: 'browse', ok: true, checks: [], warnings: [] };
  try {
    out.checks.push([
      '导出齐全',
      ['galleryDetail', 'search', 'popular', 'toplists', 'recent', 'watched', 'favorites', 'uploaderGallery', 'tagGallery', 'myTags', 'favAdd', 'tagSuggest', 'batchMeta'].every(
        (n) => typeof browseExports[n] === 'function'
      ),
    ]);
    // 用假 client 验证 batchMeta 的分批与字段合并（0 次网络）
    const calls = [];
    const fake = {
      async post(url, opts) {
        calls.push({ url, opts });
        const body = opts.json || JSON.parse(opts.body || '{}');
        return {
          status: 200,
          text: JSON.stringify({
            gmetadata: body.gidlist.map(([gid]) => ({
              gid: String(gid),
              token: 'x',
              title: `T${gid}`,
              filecount: 30,
              filesize: '10 MiB',
              rating: 4.5,
              tags: ['female:big breasts', 'language:japanese'],
              torrentcount: 0,
            })),
          }),
        };
      },
    };
    const items = Array.from({ length: 27 }, (_, i) => ({ gid: String(1000 + i), token: 'tok', title: '' }));
    const r = await batchMeta(fake, { base: 'https://e-hentai.org', items });
    out.checks.push(['batchMeta 分批=2 次', calls.length === 2]);
    out.checks.push(['batchMeta 字段合并', r.items[0].title === 'T1000' && r.items[0].pages === 30 && r.items[0].tagsByNs.female?.[0] === 'big breasts']);
    // 本地标签库接入：空 client（不联网）也要能答出中文联想
    const fakeClient = { async get() { return { status: 0, text: '' }; } };
    const localOnly = await tagSuggest(fakeClient, { base: 'https://e-hentai.org', q: '巨乳' });
    out.checks.push(['本地标签兜底', localOnly.some((t) => t.startsWith('female:big breasts'))]);
    out.facts = { batches: r.batches, merged: r.items.length };
  } catch (e) {
    out.ok = false;
    out.warnings.push(`自检异常: ${e.message}`);
  }
  out.ok = out.ok && out.checks.every(([, pass]) => !!pass);
  return out;
}

/** 本模块导出表（__selftest 用它检查导出齐全，也方便 index.js 反射） */
const browseExports = {
  galleryDetail,
  search,
  popular,
  toplists,
  recent,
  watched,
  favorites,
  uploaderGallery,
  tagGallery,
  myTags,
  favAdd,
  tagSuggest,
  batchMeta,
  __selftest,
};
