/**
 * /api/browse/* —— 浏览类接口（主页 / 热门 / 收藏 / 订阅 / 搜索 / tag 补全 / 缩略图 / 登录态）。
 * 由 server.mjs 动态 import 后调用 handle(req,res,url,pathname)。
 *
 * 直接复用 dsh-ehviewer 的模块（同一份 cookie / 代理 / 限速）；包在部分部署里
 * 没有软链到本仓库，所以先按包名 import，失败再按同级目录的相对路径兜底。
 */

import zlib from 'node:zlib';
import { getImage } from './fetch-cache.mjs';

const MCP_SRC = new URL('../../dsh-ehviewer/packages/mcp/src/', import.meta.url);
const EH_BASE = 'https://e-hentai.org';
const ALLOWED_THUMB_HOSTS = ['ehgt.org', 'e-hentai.org', 'exhentai.org'];

let modulesPromise = null;

async function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const names = ['browse', 'gallery', 'subs', 'store', 'tags', 'auth', 'http', 'config'];
      const out = {};
      for (const name of names) {
        try {
          out[name] = await import(`dsh-ehviewer/${name}`);
        } catch (err) {
          if (err && err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
          out[name] = await import(new URL(`${name}.js`, MCP_SRC).href);
        }
      }
      return out;
    })().catch((err) => {
      modulesPromise = null;
      throw err;
    });
  }
  return modulesPromise;
}

/* ------------------------------------------------------------------ 通用 */

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  const req = res.req;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': buf.length,
  };
  let out = buf;
  if (buf.length > 1024) {
    headers.vary = 'Accept-Encoding';
    if (req && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      out = zlib.gzipSync(buf);
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = out.length;
    }
  }
  res.writeHead(status, headers);
  if (req && req.method === 'HEAD') return res.end();
  res.end(out);
}

function fail(res, err, status = 502) {
  sendJson(res, status, { error: String((err && err.message) || err || '未知错误') });
}

function intParam(value, fallback = 0, min = 0, max = 100000) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function uniq(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean))];
}

function cleanWarnings(list, hasItems) {
  const noisy = /列表页无文字评分|未匹配到列表行.*退化为/;
  return uniq(list).filter((w) => !(hasItems && noisy.test(String(w))));
}

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
  torr: 'storr',
  del: 'sto',
  exp: 'sh',
  lang: 'sfl',
  uploader: 'sfu',
  fav: 'sft',
};

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

function normalizeItem(it, site) {
  if (!it || it.gid == null) return null;
  const out = {
    gid: /^\d+$/.test(String(it.gid)) ? Number(it.gid) : String(it.gid),
    token: it.token || '',
    title: it.title || '',
  };
  if (it.pages != null) out.pages = Number(it.pages);
  if (it.thumb) out.thumb = String(it.thumb);
  if (it.category) out.category = String(it.category);
  if (it.uploader) out.uploader = String(it.uploader);
  if (it.posted) out.posted = String(it.posted);
  if (it.rating != null) out.rating = Number(it.rating);
  if (site) out.site = site;
  return out;
}

function mapItems(items, site) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const item = normalizeItem(it, site);
    if (item) out.push(item);
  }
  return out;
}

async function withClient(fn) {
  const M = await modules();
  const cfg = await M.config.loadConfig();
  const client = await M.http.createClient(cfg);
  const base = M.gallery.resolveBase(cfg, 'https://exhentai.org');
  try {
    return await fn({ M, cfg, client, base });
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

const TTL_CACHE = new Map();
const TTL_INFLIGHT = new Map();

function trimTtlCache() {
  if (TTL_CACHE.size <= 300) return;
  const rows = [...TTL_CACHE.entries()].sort((a, b) => a[1].at - b[1].at);
  for (let i = 0; i < rows.length - 240; i += 1) TTL_CACHE.delete(rows[i][0]);
}

function withOverallTimeout(promise, ms = 20000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('上游超时（20s）'), { status: 504 })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 站点侧 TTL 缓存 + 同 key 并发合并。
 * 命中（含等待别人结果）返回 cached:true；打站点的请求返回 cached:false。
 */
async function runCached(key, ttlMs, fn) {
  const hit = TTL_CACHE.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return { ...hit.data, cached: true, tookMs: 0 };
  }

  if (TTL_INFLIGHT.has(key)) {
    const started = Date.now();
    const data = await TTL_INFLIGHT.get(key);
    return { ...data, cached: true, tookMs: Date.now() - started };
  }

  const started = Date.now();
  const task = (async () => {
    const data = await withOverallTimeout(Promise.resolve().then(fn), 20000);
    TTL_CACHE.set(key, { at: Date.now(), data });
    trimTtlCache();
    return data;
  })();
  TTL_INFLIGHT.set(key, task);
  try {
    const data = await task;
    return { ...data, cached: false, tookMs: Date.now() - started };
  } finally {
    TTL_INFLIGHT.delete(key);
  }
}

async function fetchListPage(client, url, base, gallery) {
  const res = await client.get(url, { redirect: true });
  const html = (res && res.text) || '';
  const warnings = [];
  if (!html) warnings.push(`响应为空（status=${res && res.status != null ? res.status : 'unknown'}）`);
  else if (res.status && res.status >= 400) warnings.push(`HTTP ${res.status}`);
  const items = gallery.parseGalleryList(html, { base }) || [];
  for (const w of items.warnings || []) warnings.push(w);
  const nav = gallery.parseNextPage(html, { base });
  return {
    items,
    warnings: uniq(warnings),
    hasMore: Boolean(nav.next),
    url: (res && res.finalUrl) || url,
  };
}

/* --------------------------------------------------------------- 各接口 */

async function apiHome(url) {
  const page = intParam(url.searchParams.get('page'), 0, 0, 500);
  return runCached(`home|${page}`, 90000, () => withClient(async ({ M, client, base }) => {
    const target = page > 0 ? `${base}/?page=${page}` : `${base}/`;
    const r = await fetchListPage(client, target, base, M.gallery);
    const items = mapItems(r.items, M.gallery.siteFromBase(base));
    return {
      items,
      hasMore: r.hasMore,
      warnings: cleanWarnings(r.warnings, items.length > 0),
    };
  }));
}

async function apiPopular(url) {
  const periodRaw = String(url.searchParams.get('period') || 'all').toLowerCase();
  const period = ['4h', '1d', '1w', '1m', '1y', 'all'].includes(periodRaw) ? periodRaw : 'all';
  const page = intParam(url.searchParams.get('page'), 0, 0, 200);
  return runCached(`popular|${period}|${page}`, 90000, () => withClient(async ({ M, client }) => {
    // toplist 在 exhentai 上 404，统一落到 e-hentai 主机。
    const r = await M.browse.toplists(client, { base: EH_BASE, period, page });
    const warnings = uniq(r.warnings || []);

    // toplist 页面只有标题，没有分类/页数/缩略图；用 gdata 补一次（每批 25 条）。
    let rawItems = r.items;
    if (rawItems.some((it) => !it.category || !it.thumb)) {
      try {
        const meta = await M.browse.batchMeta(client, { base: EH_BASE, items: rawItems });
        if (Array.isArray(meta.items) && meta.items.length) rawItems = meta.items;
        for (const w of meta.warnings || []) warnings.push(w);
        // toplist 页面本来就没有评分/分类列，gdata 已补齐，这几条解析告警对用户没意义。
        const noisy = /列表页无文字评分|未匹配到列表行/;
        for (let i = warnings.length - 1; i >= 0; i -= 1) if (noisy.test(warnings[i])) warnings.splice(i, 1);
      } catch (err) {
        warnings.push(`gdata 补全失败：${(err && err.message) || err}`);
      }
    }

    const items = mapItems(rawItems, 'e-hentai');
    if (!items.length && period !== 'all') {
      warnings.unshift(`时间窗 ${period} 需要 e-hentai 登录态；当前会话可能只有 exhentai，先看「全部」。`);
    }
    return {
      items,
      hasMore: items.length >= 25,
      warnings,
      period,
      page,
    };
  }));
}

async function apiFavs(url) {
  const catRaw = String(url.searchParams.get('cat') || '0').toLowerCase();
  const cat = catRaw === 'all' ? 'all' : String(intParam(catRaw, 0, 0, 9));
  const page = intParam(url.searchParams.get('page'), 0, 0, 500);
  const q = String(url.searchParams.get('q') || '');
  return runCached(`favs|${cat}|${page}|${q}`, 90000, () => withClient(async ({ M, client, base }) => {
    const r = await M.browse.favorites(client, { base, cat, page, query: q });
    const items = mapItems(r.items, M.gallery.siteFromBase(base));
    return {
      items,
      hasMore: items.length >= 25,
      warnings: cleanWarnings(r.warnings, items.length > 0),
      cat,
      query: q,
    };
  }));
}

async function apiSubs() {
  const started = Date.now();
  const { store } = await modules();
  const subs = await store.listSubs();
  const items = (Array.isArray(subs) ? subs : []).map((s) => ({
    id: s.id,
    query: s.query,
    category: s.category || null,
    lastCheckAt: s.lastCheckAt || null,
    seenCount: Array.isArray(s.seen) ? s.seen.length : 0,
    createdAt: s.createdAt || null,
  }));
  return { items, total: items.length, tookMs: Date.now() - started };
}

async function apiSubsCheck() {
  const started = Date.now();
  return withClient(async ({ M, cfg, client, base }) => {
    const task = M.subs.checkSubs({
      client,
      base,
      cfg,
      _deps: {
        search: M.browse.search,
        buildSearchUrl: M.gallery.buildSearchUrl,
        parseGalleryList: M.gallery.parseGalleryList,
      },
    });
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('订阅检查超时（20s）')), 20000);
    });
    let results;
    try {
      results = await Promise.race([task, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const list = Array.isArray(results) ? results : [];
    const newItems = [];
    const rows = list.map((r) => {
      const fresh = Array.isArray(r.newItems) ? r.newItems : [];
      for (const it of fresh) {
        const norm = normalizeItem(it, M.gallery.siteFromBase(base));
        if (norm) newItems.push(norm);
      }
      return {
        id: r.id,
        query: r.query,
        newCount: fresh.length,
        newItems: fresh,
        pagesFetched: r.pagesFetched,
        error: r.error || r.lastError || null,
      };
    });
    return { results: rows, newItems, totalNew: newItems.length, tookMs: Date.now() - started };
  });
}

async function apiSearch(url) {
  const q = String(url.searchParams.get('q') || '');
  const page = intParam(url.searchParams.get('page'), 0, 0, 500);
  const category = url.searchParams.get('category') || null;
  const advRaw = url.searchParams.get('adv');

  let adv = null;
  if (advRaw) {
    try {
      adv = JSON.parse(advRaw);
    } catch {
      throw Object.assign(new Error('adv 不是合法 JSON'), { status: 400 });
    }
  }
  if (adv && typeof adv !== 'object') adv = null;

  return runCached(`search|${q}|${page}|${category || ''}|${advRaw || ''}`, 45000, () => withClient(async ({ M, client, base }) => {
    if (!adv) {
      const r = await M.browse.search(client, { base, query: q, page, category: category || null });
      const items = mapItems(r.items, M.gallery.siteFromBase(base));
      return {
        items,
        hasMore: Boolean(r.next),
        warnings: cleanWarnings(r.warnings, items.length > 0),
        page,
        query: q,
      };
    }

    const modAdv = advToModule(adv) || {};
    const target = M.gallery.buildListUrl(base, {
      mode: 'search',
      keyword: q,
      page,
      category: category || null,
      adv: modAdv,
    });
    const r = await fetchListPage(client, target, base, M.gallery);
    const items = mapItems(r.items, M.gallery.siteFromBase(base));
    return {
      items,
      hasMore: r.hasMore,
      warnings: cleanWarnings(r.warnings, items.length > 0),
      page,
      query: q,
    };
  }));
}

async function apiTags(url) {
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) return { items: [] };
  return runCached(`tags|${q}`, 600000, async () => {
    const { tags } = await modules();
    const items = tags.suggestTags(q, { limit: 20 });
    return { items: Array.isArray(items) ? items : [] };
  });
}

function thumbHostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return ALLOWED_THUMB_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function etagMatches(header, etag) {
  if (!header) return false;
  return String(header)
    .split(',')
    .some((v) => v.trim().replace(/^W\//, '') === etag);
}

async function apiThumb(req, res, url) {
  const raw = url.searchParams.get('u');
  if (!raw) return sendJson(res, 400, { error: '缺少 u 参数' });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return sendJson(res, 400, { error: 'u 不是合法 URL' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return sendJson(res, 403, { error: '只允许 http/https' });
  }
  if (!thumbHostAllowed(target.hostname)) {
    return sendJson(res, 403, { error: 'host 不在白名单' });
  }

  const rawW = url.searchParams.get('w');
  const width = rawW === '0' || rawW === 'none' ? 0 : intParam(rawW, 320, 64, 2000);
  const want = url.searchParams.get('want') === 'original' ? 'original' : 'webp';
  const referer = /\.exhentai\.org$/i.test(target.hostname)
    ? 'https://exhentai.org/'
    : 'https://e-hentai.org/';

  let out;
  try {
    out = await getImage({ url: target.href, referer, width, want });
  } catch (err) {
    const status = Number(err && err.status) || 502;
    if (status === 429) {
      res.setHeader('Retry-After', '30');
      return sendJson(res, 429, { error: 'upstream rate limited', hint: '站点限流，30 秒后重试' });
    }
    if (status === 504) {
      return sendJson(res, 504, { error: 'upstream timeout', hint: '上游 15 秒未响应' });
    }
    return sendJson(res, status === 400 ? 400 : 502, {
      error: String((err && err.message) || err || '缩略图拉取失败'),
      hint: '缩略图代理失败；检查代理与站点登录态',
    });
  }

  const etag = `"${out.etag}"`;
  const headers = {
    'content-type': out.mime,
    'cache-control': 'public, max-age=604800, immutable',
    etag,
    'x-cache': out.cached ? 'hit' : 'miss',
    'x-resized': out.resized ? '1' : '0',
    'x-resize-backend': out.backend || 'none',
    'x-content-type-options': 'nosniff',
  };

  res.on('close', () => {
    if (!res.writableEnded) {
      /* 客户端断开，静默 */
    }
  });

  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['content-length'] = out.buffer.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  if (res.destroyed) return;
  try {
    res.end(out.buffer);
  } catch {
    if (!res.destroyed) res.destroy();
  }
}

async function apiStatus() {
  const started = Date.now();
  return withClient(async ({ M, cfg, client }) => {
    const s = await M.auth.status({ cfg, client });
    return {
      loggedIn: Boolean(s && s.loggedIn),
      memberId: (s && s.memberId) || null,
      site: (s && s.site) || (cfg && cfg.site === 'exhentai' ? 'exhentai' : 'e-hentai'),
      cookieAgeDays: s && s.cookieAgeDays != null ? s.cookieAgeDays : null,
      ...(s && s.username ? { username: s.username } : {}),
      ...(s && s.needsRelogin ? { needsRelogin: true } : {}),
      tookMs: Date.now() - started,
    };
  });
}

/* ------------------------------------------------------------------ 路由 */

export async function handle(req, res, url, pathname) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: '只支持 GET' });
    }

    if (pathname === '/api/browse/home') return sendJson(res, 200, await apiHome(url));
    if (pathname === '/api/browse/popular') return sendJson(res, 200, await apiPopular(url));
    if (pathname === '/api/browse/favs') return sendJson(res, 200, await apiFavs(url));
    if (pathname === '/api/browse/subs') return sendJson(res, 200, await apiSubs());
    if (pathname === '/api/browse/subs/check') return sendJson(res, 200, await apiSubsCheck());
    if (pathname === '/api/browse/search') return sendJson(res, 200, await apiSearch(url));
    if (pathname === '/api/browse/tags') return sendJson(res, 200, await apiTags(url));
    if (pathname === '/api/browse/thumb') return await apiThumb(req, res, url);
    if (pathname === '/api/browse/status') return sendJson(res, 200, await apiStatus());

    return sendJson(res, 404, { error: '未知 browse 接口', path: pathname });
  } catch (err) {
    const status = err && Number(err.status) ? Number(err.status) : 502;
    try {
      sendJson(res, status, {
        error: String((err && err.message) || err || '未知错误'),
        hint: status === 504 ? '上游超时（20s），稍后重试' : '站点请求失败；检查网络/代理/登录态',
      });
    } catch {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}
