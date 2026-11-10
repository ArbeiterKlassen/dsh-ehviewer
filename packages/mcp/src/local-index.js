/**
 * local-index.js —— 本地下载库索引 + 强搜索
 *
 * 目的：下载目录里的每本画廊都有一个 meta.json（v2 优先，v1 兼容），
 * 把它们的标题 / tag / 体积 / 页数收成一份 library.json，供离线秒查。
 * 比参考仓库强的地方：裸关键词子串、缩写（f:tentacles）、正则、排除项、OR 都认。
 *
 * 设计约束：
 *   · 不联网、不引依赖、不改动任何已有模块（只读 tags.js 的纯函数）。
 *   · 增量：磁盘比对用 dir + meta.mtimeMs + meta.size，meta 没变就不重新读盘解析。
 *   · 解析（parseQuery）与匹配（matchEntry）分离，两者都是纯函数，方便单测。
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandQuery, hasTag, namespaceOf } from './tags.js';

/* ------------------------------------------------------------------ */
/* 路径与常量                                                          */
/* ------------------------------------------------------------------ */

export const INDEX_VERSION = 1;

/** 索引文件默认位置；EH_DATA_DIR / EH_LIBRARY_PATH 可覆盖（测试用）。 */
export function indexPath() {
  if (process.env.EH_LIBRARY_PATH) return path.resolve(process.env.EH_LIBRARY_PATH);
  const dir = process.env.EH_DATA_DIR || path.join(os.homedir(), '.dsh-eh');
  return path.join(dir, 'library.json');
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const round = (n, d = 1) => {
  const p = 10 ** d;
  return Math.round(n * p) / p;
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

async function atomicWrite(file, text) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

const lc = (v) => String(v ?? '').toLowerCase();

/** 目录相对 root 的第一层就是 account（root/<account>/<gid>-<token>/meta.json）。 */
function deriveAccount(root, dir) {
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  return segs.length > 1 ? segs[0] : null;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 从 url 取 origin（meta 里 site 常常没写，但 gallery.url 一定有）。 */
function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* meta → entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * meta 里的 tag 可能是三种写法，全都收：
 *   ["female:tentacles"]                             （数组，元素带 ns）
 *   { female: ["tentacles"] }                        （parseTags 的原始结构）
 *   [{namespace:'female', name:'tentacles'}]         （别家工具的写法）
 * 返回 { tags: ["female:tentacles"], tagMap: {female:["tentacles"]} }。
 */
function normalizeTags(raw) {
  const tags = [];
  const seen = new Set();

  const add = (ns, value) => {
    let scope = ns ? String(ns).trim() : '';
    if (scope) scope = namespaceOf(`${scope}:x`) || lc(scope);
    let v = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!v) return;
    // 值本身可能带了 ns（"f:big breasts"），再拆一层
    const ci = v.indexOf(':');
    if (!scope && ci > 0) {
      scope = namespaceOf(v) || lc(v.slice(0, ci));
      v = v.slice(ci + 1).trim();
    }
    if (!v) return;
    const full = scope ? `${scope}:${v}` : v;
    const key = full.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(full);
  };

  const walk = (src) => {
    if (!src) return;
    if (Array.isArray(src)) {
      for (const item of src) {
        if (!item) continue;
        if (typeof item === 'string') add(null, item);
        else if (typeof item === 'object') add(item.namespace ?? item.ns ?? item.scope, item.name ?? item.value ?? item.tag);
      }
      return;
    }
    if (typeof src === 'object') {
      for (const [ns, val] of Object.entries(src)) {
        if (Array.isArray(val)) for (const v of val) add(ns, v);
        else if (typeof val === 'string') add(ns, val);
      }
    }
  };

  walk(raw?.tags);
  walk(raw?.tagList);
  walk(raw?.gallery?.tags);

  // tagMap 只用于展示/调试；匹配走 tags（全称）的 Set
  const tagMap = {};
  for (const t of tags) {
    const i = t.indexOf(':');
    const ns = i > 0 ? t.slice(0, i) : 'misc';
    const v = i > 0 ? t.slice(i + 1) : t;
    (tagMap[ns] ||= []).push(v);
  }
  return { tags, tagMap };
}

/** stat；读不到返回 null（不抛）。 */
async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

/**
 * 从 gallery 目录的 meta 读出一本。meta 坏了不抛，返回 null。
 * 这里不复用 download.js 的 normalizeMeta：那会拉起整个下载链路（undici 等），
 * 索引模块要能在不碰网络的前提下被单独加载。
 */
export function entryFromMeta(raw, { dir, root, mtimeMs = null, size = null, downloadedAtFallback = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const v2 = Number(raw.version) >= 2;
  // v2 把画廊信息留在 gallery 里（download.js 同时写一份），所以两版都先看 gallery
  const g = raw.gallery || {};

  const pagesSrc = v2 ? raw.pages : raw.images;
  const pagesArr = Array.isArray(pagesSrc) ? pagesSrc : [];

  let bytes = 0;
  let sawBytes = false;
  for (const p of pagesArr) {
    const b = Number(p?.bytes);
    if (Number.isFinite(b) && b > 0) {
      bytes += b;
      sawBytes = true;
    }
  }
  if (!sawBytes) {
    const alt = Number(raw.sizeBytes ?? g.sizeBytes);
    bytes = Number.isFinite(alt) ? alt : 0;
  }

  const pages = Number.isFinite(Number(raw.total))
    ? Number(raw.total)
    : pagesArr.length || Number(g.pages) || 0;

  const { tags, tagMap } = normalizeTags(v2 ? raw : { tags: g.tags, gallery: raw.gallery });

  const dirAccount = root ? deriveAccount(root, dir) : null;
  return {
    gid: raw.gid ?? g.gid ?? null,
    token: raw.token ?? g.token ?? null,
    title: raw.title ?? g.title ?? null,
    titleJpn: raw.titleJpn ?? raw.jtitle ?? g.titleJpn ?? g.jtitle ?? null,
    tags,
    tagMap,
    uploader: raw.uploader ?? g.uploader ?? null,
    category: raw.category ?? g.category ?? null,
    pages,
    sizeBytes: bytes,
    dir,
    site: raw.site ?? g.site ?? originOf(g.url) ?? originOf(raw.url) ?? null,
    downloadedAt: raw.finishedAt ?? raw.startedAt ?? g.downloadedAt ?? downloadedAtFallback,
    account: raw.account ?? g.account ?? dirAccount,
    // 增量比对用的内部字段（不进 search 的精简输出）
    metaMtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    metaSize: Number.isFinite(size) ? size : null,
  };
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

// meta 解析结果按 meta.json 的 mtime+size 缓存：同一进程内反复扫描不再读盘。
const _metaCache = new Map(); // metaPath -> { mtimeMs, size, entry }

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      ret[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return ret;
}

/** 找出所有含 meta.json 的目录；命中后不再往下钻（画廊里不会套画廊）。 */
async function collectGalleryDirs(root) {
  const dirs = [];
  const warnings = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`读目录失败：${dir}（${err.code || err.message}）`);
      continue;
    }
    let hasMeta = false;
    for (const d of entries) {
      if (d.isFile() && d.name === 'meta.json') hasMeta = true;
      else if (d.isDirectory() && !d.name.startsWith('.')) stack.push(path.join(dir, d.name));
    }
    if (hasMeta) dirs.push(dir);
  }
  return { dirs, warnings };
}

/**
 * 递归扫描下载库。
 * @param {object} o
 * @param {string} o.root          下载根目录
 * @param {boolean} [o.force]      true = 无视 mtime/size 缓存，全部重读 meta
 * @param {Array} [o.previous]     上次索引的 entries；命中同 dir+mtime+size 直接复用
 * @returns {Promise<{root, entries, warnings, ms, scanned, reused}>}
 */
export async function scanLibrary({ root, force = false, previous = [] } = {}) {
  const t0 = nowMs();
  const warnings = [];
  if (!root) return { root: null, entries: [], warnings: ['缺少 root'], ms: 0, scanned: 0, reused: 0 };

  const rootAbs = path.resolve(root);
  const st = await statOrNull(rootAbs);
  if (!st || !st.isDirectory()) {
    return { root: rootAbs, entries: [], warnings: [`root 不是目录：${rootAbs}`], ms: round(nowMs() - t0), scanned: 0, reused: 0 };
  }

  const prevByDir = new Map();
  for (const e of previous || []) if (e && e.dir) prevByDir.set(e.dir, e);

  const { dirs, warnings: walkWarn } = await collectGalleryDirs(rootAbs);
  warnings.push(...walkWarn);

  let reused = 0;
  let scanned = 0;
  const entries = await mapLimit(dirs, 8, async (dir) => {
    const metaPath = path.join(dir, 'meta.json');
    const s = await statOrNull(metaPath);
    if (!s) return null;
    const mtimeMs = Math.round(s.mtimeMs);
    const size = s.size;

    // 1) 进程内缓存：meta 没动过就别再解析一遍
    const hit = _metaCache.get(metaPath);
    if (!force && hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      reused += 1;
      return hit.entry;
    }
    // 2) 上次索引里的条目（跨进程也算增量）
    if (!force) {
      const prev = prevByDir.get(dir);
      if (prev && prev.metaMtimeMs === mtimeMs && prev.metaSize === size) {
        reused += 1;
        _metaCache.set(metaPath, { mtimeMs, size, entry: prev });
        return prev;
      }
    }

    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch (err) {
      warnings.push(`坏 meta.json：${dir}（${err.code || err.message}）`);
      _metaCache.delete(metaPath);
      return null;
    }
    scanned += 1;
    const entry = entryFromMeta(raw, { dir, root: rootAbs, mtimeMs, size, downloadedAtFallback: toIso(mtimeMs) });
    if (!entry) {
      warnings.push(`meta 结构不认识：${dir}`);
      return null;
    }
    _metaCache.set(metaPath, { mtimeMs, size, entry });
    return entry;
  });

  const ok = entries.filter(Boolean).sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { root: rootAbs, entries: ok, warnings, ms: round(nowMs() - t0), scanned, reused };
}

/* ------------------------------------------------------------------ */
/* 索引文件                                                            */
/* ------------------------------------------------------------------ */

let _fileCache = { file: null, mtimeMs: -1, size: -1, doc: null };

/** 同步读索引；文件没变就吃内存副本（search 要同步，所以这里不能是 async）。 */
export function loadIndexSync({ indexPath: file = indexPath(), fresh = false } = {}) {
  const abs = path.resolve(file);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  const mtimeMs = Math.round(st.mtimeMs);
  if (!fresh && _fileCache.file === abs && _fileCache.mtimeMs === mtimeMs && _fileCache.size === st.size) {
    return _fileCache.doc;
  }
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || !Array.isArray(doc.entries)) return null;
  _fileCache = { file: abs, mtimeMs, size: st.size, doc };
  return doc;
}

/** 契约风格：async 版（内部同步读，索引量小）。 */
export async function loadIndex({ indexPath: file = indexPath(), fresh = false } = {}) {
  return loadIndexSync({ indexPath: file, fresh });
}

/**
 * 重建索引。added / updated / removed 是对上次 library.json 的差分：
 *   · dir 相同 + meta 的 mtime/size 相同 → 不变，不重读 meta；
 *   · dir 相同但 meta 变了 → updated；
 *   · 只在新结果里 → added；只在旧索引里 → removed。
 */
export async function rebuildIndex({ root, force = false, indexPath: file = indexPath() } = {}) {
  const t0 = nowMs();
  const prev = loadIndexSync({ indexPath: file, fresh: true });
  const scan = await scanLibrary({ root, force, previous: prev?.entries || [] });

  const oldMap = new Map((prev?.entries || []).map((e) => [e.dir, e]));
  let added = 0;
  let updated = 0;
  for (const e of scan.entries) {
    const old = oldMap.get(e.dir);
    if (!old) added += 1;
    else if (old.metaMtimeMs !== e.metaMtimeMs || old.metaSize !== e.metaSize) updated += 1;
    oldMap.delete(e.dir);
  }
  const removed = oldMap.size;

  const doc = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    root: scan.root,
    entries: scan.entries,
  };
  const abs = path.resolve(file);
  await atomicWrite(abs, JSON.stringify(doc) + '\n');
  _fileCache = { file: abs, mtimeMs: -1, size: -1, doc: null }; // 下次读盘

  const warnings = [
    ...scan.warnings,
    ...scan.entries.filter((e) => e.gid == null && e.token == null).map((e) => `缺少 gid/token：${e.dir}`),
  ];
  return {
    added,
    updated,
    removed,
    total: scan.entries.length,
    ms: round(nowMs() - t0),
    scanned: scan.scanned,
    reused: scan.reused,
    indexFile: abs,
    warnings,
  };
}

/** 统计：条数 / 总体积 / 构建时间 / 按 account、category 分组计数。 */
export function indexStats({ indexPath: file = indexPath() } = {}) {
  const doc = loadIndexSync({ indexPath: file });
  if (!doc) {
    return { total: 0, sizeBytes: 0, builtAt: null, root: null, byAccount: {}, byCategory: {}, warning: '索引不存在，先 rebuildIndex()' };
  }
  const byAccount = {};
  const byCategory = {};
  let sizeBytes = 0;
  for (const e of doc.entries) {
    sizeBytes += Number(e.sizeBytes) || 0;
    const a = e.account || '(none)';
    const c = e.category || '(none)';
    byAccount[a] = (byAccount[a] || 0) + 1;
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  return { total: doc.entries.length, sizeBytes, builtAt: doc.builtAt, root: doc.root, byAccount, byCategory };
}

/* ------------------------------------------------------------------ */
/* 查询解析（纯函数）                                                  */
/* ------------------------------------------------------------------ */

/** 拆 `/source/flags`；不是正则字面量返回 null。 */
const RE_LITERAL = /^\/(.*)\/([a-z]*)$/is;

function readQuotedWord(text, i) {
  let out = '';
  while (i < text.length && !/\s/.test(text[i])) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end > i) {
        out += text.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return { word: out, end: i };
}

/**
 * 词法：空白分隔；支持 "带空格" 引号；`/re/flags` 与 `tag:/re/` 整体成词。
 * 为什么单写扫描器：正则里可能含空格和 `|`，先按空白切会把它们切碎。
 */
function tokenize(text) {
  const tokens = [];
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;

    let neg = false;
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      neg = true;
      i += 1;
    }
    let scope = null;
    if (/^tag:/i.test(s.slice(i))) {
      scope = 'tag';
      i += 4;
    }

    let word = null;
    if (s[i] === '/') {
      // 找未转义的闭合 /
      let j = i + 1;
      let closed = -1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '/') { closed = j; break; }
        j += 1;
      }
      if (closed > i + 1) {
        let k = closed + 1;
        while (k < s.length && /[a-z]/i.test(s[k])) k += 1;
        word = s.slice(i, k);
        i = k;
      }
    }
    if (word == null) {
      const r = readQuotedWord(s, i);
      word = r.word;
      i = r.end;
    }
    if (!word) continue;
    tokens.push({ word, neg, scope });
  }
  return tokens;
}

/** 已知命名空间才算 tag 子句；否则当裸词（url:xxx 这种）。 */
function canonicalNs(prefix) {
  const p = String(prefix || '').trim();
  if (!p) return null;
  return namespaceOf(`${p}:x`) || null; // namespaceOf 认全名与缩写
}

function makeRegexClause({ source, flags }, { scope, neg, warnings }) {
  let re = null;
  try {
    // g/y 去掉：同一个 RegExp 反复 test 时 lastIndex 会漂，匹配会漏
    re = new RegExp(source, String(flags || '').replace(/[gy]/g, ''));
  } catch (err) {
    // 非法正则降级成普通字符串：不抛，记一句 warning 就够了
    warnings.push(`正则无效，按普通字符串处理：/${source}/${flags || ''}（${err.message}）`);
    return { type: 'kw', text: source, neg, fromRegex: true };
  }
  return { type: 'regex', re, scope: scope || 'any', neg };
}

function classify(word, { scope, neg, warnings }) {
  const m = RE_LITERAL.exec(word);
  if (m) return makeRegexClause({ source: m[1], flags: m[2] }, { scope, neg, warnings });

  const ci = word.indexOf(':');
  if (ci > 0) {
    const prefix = word.slice(0, ci);
    const value = word.slice(ci + 1);
    if (lc(prefix) === 'tag') return { type: 'kw', text: value, neg, tagsOnly: true };
    const ns = canonicalNs(prefix);
    if (ns) {
      // 值里的中文/别名先展开（expandQuery 做别名 + 中文反查 + 缩写）
      let v = value;
      let outNs = ns;
      if (v) {
        const exp = expandQuery(v);
        for (const w of exp.warnings || []) warnings.push(w);
        const q = exp.query.trim();
        if (q && (exp.replaced || []).length) {
          const k = q.indexOf(':');
          const expandedNs = k > 0 ? canonicalNs(q.slice(0, k)) : null;
          if (expandedNs) {
            outNs = expandedNs;
            v = q.slice(k + 1);
          } else {
            v = q;
          }
        }
      }
      return { type: 'tag', ns: outNs, value: v.trim(), neg, empty: !v.trim() };
    }
  }
  return { type: 'kw', text: word, neg };
}

/**
 * 查询 → 子句数组。规则：
 *   空白 = AND；`-x` = NOT；`a|b` 段内 OR；
 *   `ns:value`（ns 已知）= 精确 tag；`/re/flags`、`tag:/re/` = 正则；
 *   其它 = 裸关键词子串。
 * @returns {{clauses: object[], warnings: string[]}}
 */
export function parseQuery(query) {
  const warnings = [];
  const clauses = [];
  for (const t of tokenize(query)) {
    // 含 | 的段做 OR；正则词已经整体成词，不再切
    if (t.scope == null && t.word.includes('|') && !RE_LITERAL.test(t.word)) {
      const alts = t.word.split('|').map((x) => x.trim()).filter(Boolean)
        .map((x) => classify(x, { scope: null, neg: false, warnings }));
      if (alts.length) clauses.push({ type: 'or', alts, neg: t.neg });
      continue;
    }
    clauses.push(classify(t.word, { scope: t.scope, neg: t.neg, warnings }));
  }

  // `female:` 空值时吃掉下一个裸词，兼容 "female: big breasts" 这种手滑写法
  for (let i = 0; i < clauses.length; i += 1) {
    const c = clauses[i];
    if (c.type !== 'tag' || !c.empty) continue;
    const nxt = clauses[i + 1];
    if (nxt && nxt.type === 'kw' && !nxt.neg && !nxt.tagsOnly) {
      c.value = nxt.text;
      c.empty = false;
      clauses.splice(i + 1, 1);
    }
  }
  // 没加引号的多词 tag（female:big breasts）：往后吃词，拼出的值在标签库里存在就并回来
  for (let i = 0; i < clauses.length; i += 1) {
    const c = clauses[i];
    if (c.type !== 'tag' || c.empty || c.neg || !c.value) continue;
    let value = c.value;
    let took = 0;
    for (let j = i + 1; j < clauses.length && took < 3; j += 1) {
      const nxt = clauses[j];
      if (nxt.type !== 'kw' || nxt.neg || nxt.tagsOnly) break;
      const candidate = `${value} ${nxt.text}`;
      if (!hasTag(c.ns, candidate)) break;
      value = candidate;
      took += 1;
    }
    if (took) {
      c.value = value;
      clauses.splice(i + 1, took);
    }
  }

  return { clauses, warnings };
}

/* ------------------------------------------------------------------ */
/* 匹配                                                                */
/* ------------------------------------------------------------------ */

// 派生的匹配用字段（小写标题、tag 串、全称 Set），按 entry 对象缓存
const _derive = new WeakMap();

function derive(entry) {
  let d = _derive.get(entry);
  if (d) return d;
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const title = lc(entry.title);
  const titleJpn = lc(entry.titleJpn);
  const uploader = lc(entry.uploader);
  const tagsText = tags.join(' ').toLowerCase();
  const hay = [title, titleJpn, uploader, tagsText].filter(Boolean).join(' \u0001 ');
  d = { tagSet, title, titleJpn, uploader, tagsText, hay, tags };
  _derive.set(entry, d);
  return d;
}

function matchOne(clause, entry, d) {
  switch (clause.type) {
    case 'kw': {
      const needle = lc(clause.text);
      if (!needle) return true;
      if (clause.tagsOnly) return d.tagsText.includes(needle);
      if (d.hay.includes(needle)) return true;
      // 加分项：中文裸词顺手翻成 tag 再比一次（"巨乳" 能命中 female:big breasts）
      if (/[\u3400-\u9fff]/.test(clause.text)) {
        const exp = expandQuery(clause.text);
        if ((exp.replaced || []).length) {
          const q = exp.query.trim().toLowerCase();
          if (q && d.tagSet.has(q)) return true;
        }
      }
      return false;
    }
    case 'tag': {
      if (!clause.value) return false;
      const full = `${clause.ns}:${lc(clause.value)}`;
      if (d.tagSet.has(full)) return true;
      // 也允许不带 ns 的写法命中（meta 里偶尔没写命名空间）
      return d.tagSet.has(lc(clause.value));
    }
    case 'regex': {
      const re = clause.re;
      if (re.test(d.tagsText)) return true;
      if (clause.scope === 'any') {
        if (d.title && re.test(d.title)) return true;
        if (d.titleJpn && re.test(d.titleJpn)) return true;
        if (d.uploader && re.test(d.uploader)) return true;
      }
      return false;
    }
    case 'or':
      return clause.alts.some((a) => matchOne(a, entry, d));
    default:
      return true;
  }
}

/** 单条记录是否命中全部子句（纯函数，导出给测试用）。 */
export function matchEntry(entry, clauses) {
  const d = derive(entry);
  return clauses.every((c) => {
    const hit = matchOne(c, entry, d);
    return c.neg ? !hit : hit;
  });
}

/* ------------------------------------------------------------------ */
/* 排序与输出                                                          */
/* ------------------------------------------------------------------ */

const byTitle = (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh');
const byDownloaded = (a, b) => String(b.downloadedAt ?? '').localeCompare(String(a.downloadedAt ?? ''));

const SORTERS = {
  downloadedat: (a, b) => byDownloaded(a, b) || byTitle(a, b),
  pages: (a, b) => (Number(b.pages) || 0) - (Number(a.pages) || 0) || byTitle(a, b),
  size: (a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0) || byTitle(a, b),
  title: (a, b) => byTitle(a, b),
};

function sorter(sort) {
  const raw = String(sort ?? 'downloadedAt');
  const key = lc(raw).replace(/^[-+]/, '').trim();
  const fn = SORTERS[key] || SORTERS.downloadedat;
  return raw.startsWith('-') ? (a, b) => -fn(a, b) : fn;
}

function compact(entry) {
  const item = {
    gid: entry.gid ?? null,
    token: entry.token ?? null,
    title: entry.title ?? null,
    pages: Number(entry.pages) || 0,
    tags: (entry.tags || []).slice(0, 8),
    dir: entry.dir,
  };
  if (Array.isArray(entry.warnings) && entry.warnings.length) item.warnings = entry.warnings;
  return item;
}

/**
 * 查询引擎。
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.sort] downloadedAt（默认 desc）| pages | size | title，前缀 - 反向
 * @param {Array}  [opts.entries] 直接喂数据（测试 / 压测用，不读索引文件）
 * @param {string} [opts.indexPath]
 * @returns {Array} 精简条目数组；数组上挂 warnings / total（有才挂）
 */
export function search(query, { limit = 50, offset = 0, sort = null, entries = null, indexPath: file = indexPath() } = {}) {
  const doc = entries ? { entries } : loadIndexSync({ indexPath: file });
  const list = doc?.entries || [];
  const { clauses, warnings } = parseQuery(query);

  const matched = list.filter((e) => matchEntry(e, clauses));
  matched.sort(sorter(sort));

  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(0, Number(limit) || 0);
  const out = matched.slice(start, end).map(compact);

  if (warnings.length) out.warnings = warnings;
  if (!doc) (out.warnings ||= []).push('索引不存在，先 rebuildIndex()');
  out.total = matched.length;
  return out;
}

/** search 的富返回版：{items,total,warnings,offset,limit}，给 MCP 工具层用。 */
export function searchWithMeta(query, opts = {}) {
  const items = search(query, opts);
  return {
    items,
    total: items.total ?? items.length,
    warnings: items.warnings || [],
    offset: Math.max(0, Number(opts.offset) || 0),
    limit: Math.max(0, Number(opts.limit ?? 50) || 0),
  };
}

/* ------------------------------------------------------------------ */
/* 自检（不联网；给 test/smoke.mjs 用）                                */
/* ------------------------------------------------------------------ */

export async function __selftest() {
  const warnings = [];
  const ok = (name, cond) => {
    if (!cond) warnings.push(`失败：${name}`);
  };
  const e = entryFromMeta(
    {
      version: 2,
      gid: 1,
      token: 'abcdef0123',
      title: 'Test',
      site: 'e-hentai',
      pages: [{ index: 1, bytes: 10, status: 'downloaded' }],
      total: 1,
      gallery: { tags: { female: ['tentacles'] }, category: 'Doujinshi' },
    },
    { dir: '/tmp/x/1-abcdef0123', root: '/tmp/x' },
  );
  ok('entryFromMeta 归一', !!e && e.tags[0] === 'female:tentacles' && e.pages === 1 && e.sizeBytes === 10);
  ok('account 为空时 null', !!e && e.account === null);
  const q = parseQuery('f:tentacles -loli /tentacle/ a|b');
  ok('parseQuery 子句数', q.clauses.length === 4);
  ok('缩写展开成 female', q.clauses[0].type === 'tag' && q.clauses[0].ns === 'female');
  ok('排除项标记', q.clauses[1].neg === true);
  ok('正则子句', q.clauses[2].type === 'regex');
  ok('OR 子句', q.clauses[3].type === 'or' && q.clauses[3].alts.length === 2);
  const bad = parseQuery('/(/');
  ok('非法正则降级', bad.clauses[0].type === 'kw' && bad.warnings.length === 1);
  return { ok: warnings.length === 0, warnings };
}
