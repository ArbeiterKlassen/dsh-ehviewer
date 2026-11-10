// src/subs.js —— 订阅轮询：按页往后拉，遇到「整页都见过」就停
// 说明：
//   · 每页 25 条；最多翻 MAX_PAGES 页，避免一次轮询把限额打光。
//   · 早停两种：整页 gid 全在 seen 里（没更新了）、或拿到短页（压根没下一页）。
//   · 每页拉完就把 gid 记进 seen：中途出错也不会下次把同一批重报一遍。
//   · 单个订阅失败只记 error / lastError，不中断其余订阅。
//   · newItems 只回 {gid, token, title, pages} —— 上层不需要 tagsPreview 那堆。
import { listSubs, markSeen } from './store.js';

const PAGE_SIZE = 25;
const MAX_PAGES = 3;
const INTERVAL_MS = 1500;

// gallery.js / browse.js 由别人并行写：动态 import，缺文件时给出明确错误而不是模块加载失败。
let _mods = null;
async function mods() {
  if (_mods) return _mods;
  const load = async (p) => {
    try {
      return await import(p);
    } catch {
      return null;
    }
  };
  _mods = { gallery: await load('./gallery.js'), browse: await load('./browse.js') };
  return _mods;
}

/** 把 base / cfg.site 归一成真实站点根，避免把 'auto' 当 URL 用 */
function normalizeBase(base, cfg) {
  if (typeof base === 'string' && /^https?:\/\//.test(base)) return base.replace(/\/+$/, '');
  const site = String((cfg && cfg.site) || '').toLowerCase();
  if (site === 'exhentai' || site === 'ex') return 'https://exhentai.org';
  return 'https://e-hentai.org';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 纯函数：从列表里挑出没见过的 gid。gid 统一按字符串比较。
 * @param {Array<{gid:any}>} items
 * @param {Iterable<string|number>} seen
 */
export function diffNew(items, seen) {
  const known = new Set(Array.isArray(seen) ? seen.map(String) : []);
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.gid == null) continue;
    const gid = String(it.gid);
    if (known.has(gid)) continue;
    known.add(gid); // 同一页里重复出现的 gid 只算一次
    out.push(it);
  }
  return out;
}

/** 只留上层要用的四个字段，别把整条 GalleryListItem 塞回去（省 token）。 */
export function compactItem(it) {
  return {
    gid: it && it.gid != null ? it.gid : null,
    token: (it && it.token) ?? null,
    title: (it && it.title) ?? null,
    pages: (it && it.pages) ?? null,
  };
}

/** 拉一页并归一成数组：browse.search 返回的是 {items}，不是裸数组。 */
async function fetchPage({ client, base, sub, page, search, buildSearchUrl, parseGalleryList }) {
  if (typeof search === 'function') {
    const res = await search(client, { base, query: sub.query, page, category: sub.category || undefined });
    return Array.isArray(res) ? res : (res && res.items) || [];
  }
  if (typeof buildSearchUrl === 'function' && typeof parseGalleryList === 'function') {
    const url = buildSearchUrl({ base }, { query: sub.query, page, category: sub.category || undefined });
    const resp = await client.get(url);
    return parseGalleryList(resp && resp.text, { base }) || [];
  }
  throw new Error('subs: 缺少 browse.search / gallery.buildSearchUrl');
}

/**
 * 检查全部订阅（增量）。
 * @param {object} opts
 * @param {object} opts.client  http.js 的 client
 * @param {string} [opts.base]  站点根（'https://e-hentai.org' 或 'https://exhentai.org'）
 * @param {object} [opts.cfg]   有 cfg 时优先用 gallery.buildSearchUrl 拼 URL；没有就走 browse.search
 * @param {object} [opts._deps] 测试注入：{search, buildSearchUrl, parseGalleryList}
 * @returns {Promise<Array<{id:string, query:string, newItems:Array, pagesFetched:number, lastError:string|null}>>}
 */
export async function checkSubs({ client, base, cfg, _deps } = {}) {
  const subs = await listSubs();
  if (!subs.length) return [];

  const M = await mods();
  const search = (_deps && _deps.search) || (M.browse && M.browse.search) || null;
  const buildSearchUrl = (_deps && _deps.buildSearchUrl) || (M.gallery && M.gallery.buildSearchUrl) || null;
  const parseGalleryList = (_deps && _deps.parseGalleryList) || (M.gallery && M.gallery.parseGalleryList) || null;

  const siteBase = normalizeBase(base, cfg);
  const results = [];

  for (let i = 0; i < subs.length; i += 1) {
    const sub = subs[i];
    if (!sub || !sub.id) continue;

    const seen = new Set((Array.isArray(sub.seen) ? sub.seen : []).map(String));
    const fresh = [];
    const reported = new Set(); // 本次已报过的 gid，防跨页重复
    let pagesFetched = 0;
    let lastError = null;

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const items = await fetchPage({ client, base: siteBase, sub, page, search, buildSearchUrl, parseGalleryList });
        pagesFetched += 1;
        if (!items.length) break; // 空页：到底了

        const pageGids = items.map((it) => (it && it.gid != null ? String(it.gid) : null)).filter(Boolean);
        const pageNew = items.filter((it) => {
          const gid = it && it.gid != null ? String(it.gid) : null;
          return gid && !seen.has(gid) && !reported.has(gid);
        });

        for (const it of pageNew) {
          reported.add(String(it.gid));
          fresh.push(it);
        }
        // 先把本页 gid 记进 seen：早停判断要用「本页已见过」，
        // 而且下一页出错时这一页也不会下次重报。
        if (pageGids.length) await markSeen(sub.id, pageGids);
        for (const gid of pageGids) seen.add(gid);

        if (items.length < PAGE_SIZE) break; // 短页 = 没有下一页
        if (pageNew.length === 0) break; // 整页都是旧的 = 增量到头了
      }

      results.push({ id: sub.id, query: sub.query, newItems: fresh.map(compactItem), pagesFetched, lastError: null });
    } catch (err) {
      lastError = err?.message ?? String(err);
      // 已经拉到的部分照样回给上层：第 2 页崩了不该把第 1 页的新作吞掉
      results.push({
        id: sub.id,
        query: sub.query,
        newItems: fresh.map(compactItem),
        pagesFetched,
        error: lastError,
        lastError,
      });
    }

    if (i < subs.length - 1) await sleep(INTERVAL_MS);
  }

  return results;
}

// ── 自检（纯逻辑，不联网） ─────────────────────────────────────────────────

export async function __selftest() {
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });

  try {
    const items = [
      { gid: 1, title: 'a' },
      { gid: 2, title: 'b' },
      { gid: 2, title: 'b dup' },
      { gid: 3, title: 'c' },
    ];
    const fresh = diffNew(items, ['1', 2]);
    ok('diffNew 只留未见', fresh.length === 1 && String(fresh[0].gid) === '3', { fresh });
    ok('diffNew 去重同页 gid', diffNew(items, []).length === 3);
    ok('diffNew 空输入', diffNew(null, null).length === 0);

    const c = compactItem({ gid: 9, token: 't', title: 'x', pages: 12, tagsPreview: ['a'], uploader: 'u' });
    ok('compactItem 只留四字段', Object.keys(c).sort().join(',') === 'gid,pages,title,token', { c });
  } catch (err) {
    checks.push({ name: 'selftest 异常', ok: false, extra: { message: err?.message ?? String(err) } });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
