// src/store.js —— 本地存储：历史 / 搜索记录 / 订阅
// 设计：只用 JSON 文件，不引入数据库依赖；所有写盘一律「临时文件 + rename」原子替换。
//       dataDir 优先取 config.js 的 loadConfig().dataDir，取不到回落 ~/.dsh-eh。
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const F_HISTORY = 'history.jsonl';
const F_SEARCH = 'search.json';
const F_SUBS = 'subs.json';
const F_FAV = 'fav.json'; // 收藏夹本地缓存（整份覆盖写，量级 1e3~1e4 条，不值得上索引）

const SEARCH_MAX = 500; // search.json 最多保留多少条
const SEEN_MAX = 3000; // 单个订阅最多记住多少个 gid，防止文件无限膨胀
const HISTORY_MAX = 5000; // history.jsonl 超过这个行数就裁剪
const HISTORY_KEEP = 3000; // 裁剪后只留最近多少行
const HISTORY_DEFAULT_LIMIT = 50;

let _dirOverride = null; // 测试用：强制数据目录
let _dirResolved = null; // 解析结果缓存
let _dirWarning = null; // 数据目录建不起来时的记录（stats() 会带出去）
let _historyCount = null; // history.jsonl 的行数缓存；null = 还没数过

// ── 目录解析 ────────────────────────────────────────────────────────────────

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 显式指定数据目录（测试 / 特殊场景）；传 null 恢复自动解析。 */
export function __setDataDir(dir) {
  _dirOverride = dir ? path.resolve(expandHome(dir)) : null;
  _dirResolved = null;
  _historyCount = null; // 换了目录，行数缓存作废
  _dirWarning = null;
}

/** 建目录：已存在 / 并发创建都算成功；真建不了返回 false，交给上层回落。 */
async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return true; // 两个调用同时首建，后到的收这条
    _dirWarning = `数据目录不可用（${dir}）：${err?.code || err?.message || err}`;
    return false;
  }
}

/**
 * 当前使用的数据目录（会自动建目录）。
 * 首次运行 / 目录被删 / 配置写了个不可写的路径都走这里：
 * 先试配置里的，再回落 ~/.dsh-eh，都不行才抛——不让 store 因为一个坏配置整个塌掉。
 */
export async function getDataDir() {
  if (_dirOverride) {
    await fsp.mkdir(_dirOverride, { recursive: true });
    return _dirOverride;
  }
  if (_dirResolved) return _dirResolved;

  let configured = null;
  // config.js 可能还没写好 / 写坏了，这里失败就回落，不往外抛。
  try {
    const mod = await import('./config.js');
    if (typeof mod.loadConfig === 'function') {
      const cfg = await mod.loadConfig();
      if (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir.trim()) {
        configured = expandHome(cfg.dataDir.trim());
      }
    }
  } catch {
    /* 忽略：走默认目录 */
  }

  const candidates = [configured, path.join(os.homedir(), '.dsh-eh')]
    .filter(Boolean)
    .map((d) => path.resolve(d));

  for (const cand of candidates) {
    if (await ensureDir(cand)) {
      _dirResolved = cand;
      return cand;
    }
  }
  throw new Error(_dirWarning || '无法创建数据目录，检查 ~/.dsh-eh 的权限');
}

// ── 原子写 / 读 ─────────────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

/** 同 key 的读改写串行化，避免并发调用互相覆盖。 */
const _locks = new Map();
function withLock(key, fn) {
  const prev = _locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  _locks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

async function atomicWrite(file, text) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file); // Windows 上 rename 覆盖已存在文件是允许的
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 读 JSON 数组；文件缺失当空数组，解析失败也当空数组（不让单个坏文件拖垮调用方）。 */
async function readJsonArray(file) {
  const text = await readText(file);
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeJsonArray(file, arr) {
  await atomicWrite(file, JSON.stringify(arr, null, 2) + '\n');
}

/** 数非空行；文件不存在当 0。 */
async function countLines(file) {
  const text = (await readText(file)) || '';
  let n = 0;
  for (const line of text.split('\n')) if (line.trim()) n += 1;
  return n;
}

/**
 * history 裁剪：超过 HISTORY_MAX 行就只留最近 HISTORY_KEEP 行。
 * 为什么用「进程内计数 + 越线才读全文件」：每次 append 都全量数一遍是 O(n)，
 * 长期跑会越来越慢；只在越线那一次读整份文件。
 */
async function compactHistory(file) {
  const before = _historyCount ?? (await countLines(file));
  if (before <= HISTORY_MAX) {
    _historyCount = before;
    return { before, after: before, trimmed: false };
  }
  const lines = ((await readText(file)) || '').split('\n').filter((l) => l.trim());
  const keep = lines.slice(-HISTORY_KEEP);
  await atomicWrite(file, keep.length ? keep.join('\n') + '\n' : '');
  _historyCount = keep.length;
  return { before: lines.length, after: keep.length, trimmed: true };
}

function fileFor(name) {
  return getDataDir().then((dir) => path.join(dir, name));
}

function normStr(v) {
  return v == null ? '' : String(v);
}

// ── 历史（history.jsonl，追加一行一条） ────────────────────────────────────

/**
 * 追加一条历史；越线自动裁剪，保证长期跑文件不会无限长。
 * @param {{type?: 'search'|'browse'|'download', at?: string, [k: string]: any}} entry
 * @returns {Promise<object|null>} 实际写入的记录
 */
export async function addHistory(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rec = { ...entry };
  rec.type = rec.type || 'browse';
  rec.at = rec.at || nowISO();

  const file = await fileFor(F_HISTORY);
  await withLock(F_HISTORY, async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 进程内第一次写才数一遍，之后靠计数器跟上，避免每次 append 都读全文件
    if (_historyCount == null) _historyCount = await countLines(file);
    // 一条记录的 append 在本地文件系统上是原子的，不需要 tmp+rename。
    await fsp.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
    _historyCount += 1;
    if (_historyCount > HISTORY_MAX) await compactHistory(file); // 越线就裁，别等用户发现
  });
  return rec;
}

/**
 * 列出历史（新的在前）。
 * @param {{limit?: number, type?: string, query?: string}} opts query 对 title/jtitle/query/url/gid 做模糊匹配
 */
export async function listHistory({ limit = HISTORY_DEFAULT_LIMIT, type, query } = {}) {
  const file = await fileFor(F_HISTORY);
  const text = (await readText(file)) || '';
  const lines = text.split('\n');
  const out = [];

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      continue; // 半行 / 坏行直接跳过，不影响整批
    }
    if (!rec || typeof rec !== 'object') continue;
    if (type && rec.type !== type) continue;
    if (query) {
      const q = String(query).toLowerCase();
      const hay = [rec.title, rec.jtitle, rec.query, rec.url, rec.gid]
        .filter((v) => v !== undefined && v !== null && v !== '')
        .map((v) => String(v).toLowerCase())
        .join('\n');
      if (!hay.includes(q)) continue;
    }
    out.push(rec);
  }

  out.reverse(); // 文件是时间正序，返回最近优先
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HISTORY_DEFAULT_LIMIT;
  return out.slice(0, n);
}

// ── 搜索记录（search.json，去重 + 最近优先 + 上限 500） ────────────────────

/**
 * 记一次搜索；同 query（忽略大小写）只保留一条，命中则 count+1 并提到最前。
 * @param {string} query
 * @returns {Promise<{query: string, at: string, count: number}|null>}
 */
export async function addSearch(query) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return null;

  const file = await fileFor(F_SEARCH);
  return withLock(F_SEARCH, async () => {
    const list = await readJsonArray(file);
    const key = q.toLowerCase();
    const idx = list.findIndex((it) => it && typeof it.query === 'string' && it.query.toLowerCase() === key);

    let item;
    if (idx >= 0) {
      item = { ...list[idx], query: list[idx].query || q, at: nowISO() };
      item.count = (Number(item.count) || 0) + 1;
      list.splice(idx, 1);
    } else {
      item = { query: q, at: nowISO(), count: 1 };
    }
    list.unshift(item);

    await writeJsonArray(file, list.slice(0, SEARCH_MAX));
    return item;
  });
}

/** 列出搜索记录（最近优先）。 */
export async function listSearch({ limit = 50 } = {}) {
  const file = await fileFor(F_SEARCH);
  const list = await readJsonArray(file);
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return list.slice(0, n);
}

// ── 收藏夹缓存（fav.json） ─────────────────────────────────────────────────

const FAV_DEFAULT_LIMIT = 100;
const FAV_FIELDS = new Set(['title', 'tag', 'tags', 'note', 'gid', 'cat']);

/**
 * 一条收藏记录收敛成固定六字段。
 * tags 兼容传数组或「空格分隔的字符串」，cat 统一成字符串（'all' 和 '0'..'9' 都能存）。
 */
function normalizeFav(item) {
  if (!item || typeof item !== 'object') return null;
  const gid = normStr(item.gid).trim();
  if (!gid) return null; // 没 gid 的记录没法定位，直接丢

  let tags = [];
  if (Array.isArray(item.tags)) tags = item.tags.map((t) => normStr(t).trim()).filter(Boolean);
  else if (typeof item.tags === 'string' && item.tags.trim()) tags = [item.tags.trim()]; // 不按空格切：标签本身带空格

  const cat = item.cat === undefined || item.cat === null || item.cat === '' ? '' : String(item.cat);
  return { gid, token: normStr(item.token), title: normStr(item.title), tags, note: normStr(item.note), cat };
}

/**
 * 整份覆盖写收藏缓存。
 * 为什么覆盖而不是合并：这份缓存是对站点收藏夹的快照，
 * 合并会把用户已经在站点上取消收藏的条目永远留在本地。
 * @param {object[]} items [{gid, token, title, tags, note, cat}]
 */
export async function saveFavorites(items) {
  const list = (Array.isArray(items) ? items : []).map(normalizeFav).filter(Boolean);
  const file = await fileFor(F_FAV);
  const payload = { version: 1, updatedAt: nowISO(), items: list };
  return withLock(F_FAV, async () => {
    await atomicWrite(file, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  });
}

/** 读收藏缓存；文件缺失 / 坏了返回空壳，不抛。 */
export async function loadFavorites() {
  const file = await fileFor(F_FAV);
  const empty = { version: 1, updatedAt: null, items: [] };
  const text = await readText(file);
  if (!text) return empty;
  try {
    const data = JSON.parse(text);
    const items = Array.isArray(data?.items) ? data.items.map(normalizeFav).filter(Boolean) : [];
    return { version: 1, updatedAt: data?.updatedAt ?? null, items };
  } catch {
    return empty;
  }
}

/**
 * 解析查询串：支持 `field:value`（title/tag/tags/note/gid/cat），
 * 其他 `ns:value`（如 female:big breasts）按标签整串查。
 * 不做正则——正则检索留给 local-index 那一套，这里只做子串。
 */
function parseFavQuery(query) {
  const q = normStr(query).trim();
  if (!q) return { field: 'any', text: '' };
  const i = q.indexOf(':');
  if (i > 0) {
    const head = q.slice(0, i).trim().toLowerCase();
    const val = q.slice(i + 1).trim();
    if (FAV_FIELDS.has(head)) return { field: head === 'tag' ? 'tags' : head, text: val };
    return { field: 'tags', text: q }; // namespace:value
  }
  return { field: 'any', text: q };
}

/** 某个字段的可搜文本（小写由调用方统一转） */
function favHaystack(item, field) {
  switch (field) {
    case 'title':
      return item.title;
    case 'tags':
      return item.tags.join(' ');
    case 'note':
      return item.note;
    case 'gid':
      return item.gid;
    case 'cat':
      return item.cat;
    default:
      return [item.title, item.tags.join(' '), item.note].join('\n');
  }
}

/**
 * 本地子串搜索（不联网）：空格分隔的多个词按 AND 处理。
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Promise<object[]>} 精简条目 {gid, token, title, tags, note, cat}
 */
export async function searchFavorites(query, { limit = FAV_DEFAULT_LIMIT } = {}) {
  const { field, text } = parseFavQuery(query);
  const { items } = await loadFavorites();
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : FAV_DEFAULT_LIMIT;
  if (n === 0) return [];

  const out = [];
  for (const item of items) {
    const hay = favHaystack(item, field).toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

// ── 订阅（subs.json） ──────────────────────────────────────────────────────

function subId(query, category) {
  const raw = `${normStr(category)}::${normStr(query).trim().toLowerCase()}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

function normalizeSub(sub) {
  if (typeof sub === 'string') return { query: sub.trim(), category: '' };
  if (!sub || typeof sub !== 'object') return null;
  const query = normStr(sub.query).trim();
  if (!query) return null;
  return { query, category: normStr(sub.category).trim() };
}

/**
 * 新增订阅；按 query 去重，已存在则原样返回已有项（不重置 seen）。
 * @param {{query: string, category?: string}|string} sub
 */
export async function addSub(sub) {
  const base = normalizeSub(sub);
  if (!base) return null;

  const file = await fileFor(F_SUBS);
  return withLock(F_SUBS, async () => {
    const list = await readJsonArray(file);
    const key = base.query.toLowerCase();
    const exist = list.find((it) => it && normStr(it.query).toLowerCase() === key);
    if (exist) return exist;

    const item = {
      id: subId(base.query, base.category),
      query: base.query,
      category: base.category,
      seen: [],
      lastCheckAt: null,
      createdAt: nowISO(),
    };
    list.push(item);
    await writeJsonArray(file, list);
    return item;
  });
}

/** 列出全部订阅。 */
export async function listSubs() {
  const file = await fileFor(F_SUBS);
  return readJsonArray(file);
}

/** 删除订阅；返回是否真的删掉了。 */
export async function removeSub(id) {
  if (!id) return false;
  const file = await fileFor(F_SUBS);
  return withLock(F_SUBS, async () => {
    const list = await readJsonArray(file);
    const next = list.filter((it) => it && it.id !== id);
    if (next.length === list.length) return false;
    await writeJsonArray(file, next);
    return true;
  });
}

/**
 * 标记订阅已见（把 gid 并进 seen），同时更新 lastCheckAt。
 * @param {string} id 订阅 id
 * @param {Iterable<string|number>|string|number} ids
 */
export async function markSeen(id, ids) {
  if (!id) return null;
  const arr = (Array.isArray(ids) ? ids : [ids]).map((v) => normStr(v)).filter(Boolean);

  const file = await fileFor(F_SUBS);
  return withLock(F_SUBS, async () => {
    const list = await readJsonArray(file);
    const sub = list.find((it) => it && it.id === id);
    if (!sub) return null;

    if (arr.length) {
      const merged = new Set(Array.isArray(sub.seen) ? sub.seen.map(String) : []);
      for (const v of arr) merged.add(v);
      const next = [...merged];
      sub.seen = next.length > SEEN_MAX ? next.slice(next.length - SEEN_MAX) : next;
    }
    sub.lastCheckAt = nowISO();

    await writeJsonArray(file, list);
    return sub;
  });
}

// ── 容量治理 ───────────────────────────────────────────────────────────────

/**
 * 一次性把三个文件收回上限内：history 留最近 HISTORY_KEEP 行、search 留 SEARCH_MAX 条、
 * 每个订阅的 seen 收到 SEEN_MAX。返回各文件 before/after，便于上层回报。
 */
export async function compactStore() {
  const dir = await getDataDir();
  const out = { dir, history: null, search: null, subs: null };

  const historyFile = path.join(dir, F_HISTORY);
  await withLock(F_HISTORY, async () => {
    out.history = await compactHistory(historyFile);
  });

  const searchFile = path.join(dir, F_SEARCH);
  await withLock(F_SEARCH, async () => {
    const list = await readJsonArray(searchFile);
    const kept = list.slice(0, SEARCH_MAX);
    if (kept.length !== list.length) await writeJsonArray(searchFile, kept);
    out.search = { before: list.length, after: kept.length, trimmed: kept.length !== list.length };
  });

  const subsFile = path.join(dir, F_SUBS);
  await withLock(F_SUBS, async () => {
    const list = await readJsonArray(subsFile);
    let seenTrimmed = 0;
    for (const sub of list) {
      if (sub && Array.isArray(sub.seen) && sub.seen.length > SEEN_MAX) {
        sub.seen = sub.seen.slice(-SEEN_MAX);
        seenTrimmed += 1;
      }
    }
    if (seenTrimmed) await writeJsonArray(subsFile, list);
    out.subs = { subs: list.length, seenTrimmed };
  });

  return out;
}

/** 各文件有多大 / 有多少条 —— 用来看 store 是不是又长胖了。 */

// ── 评论缓存（详情页评论区，按 gid 存最近一次读到的样子） ──────────────────
const F_COMMENTS = 'comments.json';

/**
 * 存一份评论快照（每本只留最新一次）。面板离线也能展示评论区。
 * @param {{gid:number, token?:string, title?:string, comments:Array, url?:string}} input
 */
export async function saveComments(input = {}) {
  const gid = Number(input.gid);
  if (!Number.isFinite(gid) || gid <= 0) return null;
  const file = await fileFor(F_COMMENTS);
  let db = { version: 1, items: {} };
  await withLock(F_COMMENTS, async () => {
    try {
      db = JSON.parse(await fsp.readFile(file, 'utf8')) || db;
      if (!db.items || typeof db.items !== 'object') db.items = {};
    } catch { /* 首次写 / 坏文件：重建 */ }
    const prev = db.items[gid] || {};
    db.items[gid] = {
      gid,
      token: input.token || prev.token || '',
      title: input.title || prev.title || '',
      url: input.url || prev.url || '',
      comments: Array.isArray(input.comments) ? input.comments.slice(0, 500) : [],
      count: Array.isArray(input.comments) ? input.comments.length : 0,
      at: nowISO(),
    };
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db), 'utf8');
    await fsp.rename(tmp, file);
  });
  return db.items[gid];
}

/** 读一本的评论快照；没有返回 null */
export async function loadComments(gid) {
  const id = Number(gid);
  if (!Number.isFinite(id)) return null;
  const file = await fileFor(F_COMMENTS);
  try {
    const db = JSON.parse((await readText(file)) || '{}');
    return db?.items?.[id] || null;
  } catch {
    return null;
  }
}

export async function stats() {
  const dir = await getDataDir();

  const one = async (name) => {
    const file = path.join(dir, name);
    let bytes = 0;
    let exists = false;
    try {
      const st = await fsp.stat(file);
      exists = st.isFile();
      bytes = exists ? st.size : 0;
    } catch {
      exists = false;
    }
    let records = 0;
    if (exists) {
      if (name.endsWith('.jsonl')) records = await countLines(file);
      else if (name === F_FAV) records = (await loadFavorites()).items.length; // fav.json 是对象不是数组
      else records = (await readJsonArray(file)).length;
    }
    return { file: name, exists, bytes, records };
  };

  const history = await one(F_HISTORY);
  const search = await one(F_SEARCH);
  const subs = await one(F_SUBS);
  const fav = await one(F_FAV);

  return {
    dir,
    files: { history, search, subs, fav },
    bytes: history.bytes + search.bytes + subs.bytes + fav.bytes,
    records: history.records + search.records + subs.records + fav.records,
    limits: { historyLines: HISTORY_MAX, historyKeep: HISTORY_KEEP, search: SEARCH_MAX, subSeen: SEEN_MAX },
    ...(_dirWarning ? { warning: _dirWarning } : {}),
  };
}

// ── 自检（test/smoke.mjs 用） ──────────────────────────────────────────────

export async function __selftest() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
  const prev = _dirOverride;
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });

  try {
    __setDataDir(tmp);

    // 历史
    await addHistory({ type: 'search', query: 'blue archive', title: 'Blue Archive' });
    await addHistory({ type: 'download', gid: 123, title: 'Test Gallery' });
    const all = await listHistory({ limit: 10 });
    ok('history 写入/读取', all.length === 2, { got: all.length });
    ok('history 最近优先', all[0] && all[0].type === 'download');
    ok('history 按类型过滤', (await listHistory({ type: 'search' })).length === 1);
    ok('history 模糊过滤', (await listHistory({ query: 'archive' })).length === 1);

    // 搜索
    await addSearch('touhou');
    await addSearch('TOUHOU');
    const s = await listSearch({});
    ok('search 去重', s.length === 1, { got: s.length });
    ok('search count 累加', s[0] && s[0].count === 2, { count: s[0] && s[0].count });

    // 订阅
    const a = await addSub({ query: 'fate', category: 'doujinshi' });
    const b = await addSub({ query: 'FATE' });
    ok('addSub 去重返回已有项', !!a && !!b && a.id === b.id);
    ok('listSubs 长度', (await listSubs()).length === 1);

    const marked = await markSeen(a.id, ['11', 12]);
    ok('markSeen 合并', !!marked && marked.seen.length === 2, { seen: marked && marked.seen });
    ok('markSeen 去重', (await markSeen(a.id, ['11'])).seen.length === 2);

    ok('removeSub', await removeSub(a.id));
    ok('removeSub 不存在返回 false', (await removeSub('nope')) === false);

    // 收藏缓存
    const saved = await saveFavorites([
      { gid: 1, token: 'aa', title: 'Alpha', tags: ['female:sole female'], note: '我的备注', cat: '0' },
      { gid: 2, token: 'bb', title: 'Beta', tags: ['male:sole male'], note: '', cat: 1 },
      { title: '没有 gid 的脏记录' },
    ]);
    ok('saveFavorites 过滤脏记录', saved.items.length === 2, { got: saved.items.length });
    ok('loadFavorites 回读', (await loadFavorites()).items.length === 2);
    ok('searchFavorites 标题', (await searchFavorites('alpha')).length === 1);
    ok('searchFavorites note 字段', (await searchFavorites('note:备注')).length === 1);
    ok('searchFavorites 标签 namespace', (await searchFavorites('female:sole female')).length === 1);
    ok('searchFavorites 无命中返回空', (await searchFavorites('nope')).length === 0);

    // 原子性：目录里不应残留 .tmp
    const files = await fsp.readdir(tmp);
    ok('无 .tmp 残留', !files.some((f) => f.endsWith('.tmp')), { files });
    ok('subs.json 可解析', Array.isArray(JSON.parse(await fsp.readFile(path.join(tmp, F_SUBS), 'utf8'))));
  } catch (err) {
    checks.push({ name: 'selftest 异常', ok: false, extra: { message: err?.message ?? String(err) } });
  } finally {
    __setDataDir(prev);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return { ok: checks.every((c) => c.ok), checks };
}
