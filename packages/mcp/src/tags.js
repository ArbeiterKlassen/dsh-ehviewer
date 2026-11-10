/**
 * tags.js — 本地标签字典的运行时查询层（纯内存，永不联网）
 *
 * 数据来自 scripts/build-tags.mjs 生成的 tags-db.json。
 * 为什么要有这一层：EH 的 tag 是英文，用户和模型都习惯打中文；每次查询都去站点补全既慢又吃限速，
 * 本地字典能直接给出「中文 ↔ 规范 tag」，还能在远端 /mytags 挂掉时兜底（见 browse.tagSuggest）。
 *
 * 设计取舍：
 *   - 读文件失败不抛异常，返回空结构 + warnings：一个字典坏掉不该拖垮整个 MCP server。
 *   - 索引在首次使用时一次性建好（4.5 万条约几十毫秒），之后每次查询都是纯内存遍历。
 *   - 所有匹配都大小写不敏感（EH 的 artist/group 名带大小写，用户不会记得）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 默认产物路径；测试可以传别的路径来验证「缺文件」分支 */
const DEFAULT_DB_PATH = fileURLToPath(new URL('./tags-db.json', import.meta.url));

/** 手写口语别名表（中文说法 → 规范 tag）；同样允许测试指定别的路径 */
const DEFAULT_ALIAS_PATH = fileURLToPath(new URL('./tags-alias.json', import.meta.url));

/** ns 优先级：同一个中文/英文命中多个命名空间时，前面的更「主」 */
const NS_PRIORITY = [
  'female', 'male', 'mixed', 'other', 'language', 'parody',
  'character', 'artist', 'group', 'cosplayer', 'location', 'reclass',
];

/** path -> 已建好索引的 db（读失败的空结构也缓存，避免反复打磁盘） */
const cache = new Map();

/** path -> 已校验过的别名表 */
const aliasCache = new Map();

/* ------------------------------------------------------------------ */
/* 装载                                                                */
/* ------------------------------------------------------------------ */

function emptyDb(warning) {
  return {
    version: 0,
    builtAt: '',
    namespaces: {},     // ns -> {name, abbr}
    tags: {},           // ns -> {tag -> {zh, desc}}
    zhIndex: {},        // zh -> "ns:tag"
    warnings: warning ? [warning] : [],
  };
}

/**
 * 建索引。挂到 db._ix 上（不可枚举的语义不重要，反正是内部字段）。
 * 为什么不每次查询现算：4.5 万条 × 每次小写化，键盘联想那种高频调用会明显掉帧。
 */
function buildIndex(db) {
  const nsList = Object.keys(db.tags || {});
  const abbrToNs = new Map();
  const nsToAbbr = new Map();
  const perNs = new Map();

  for (const ns of nsList) {
    const meta = (db.namespaces || {})[ns] || {};
    const abbr = String(meta.abbr || '').toLowerCase();
    nsToAbbr.set(ns, abbr);
    if (abbr) abbrToNs.set(abbr, ns);
    abbrToNs.set(ns, ns);                      // 全名也当别名用

    const entries = [];
    for (const [tag, meta2] of Object.entries(db.tags[ns] || {})) {
      entries.push({ tag, lower: tag.toLowerCase(), zh: meta2.zh || '', desc: meta2.desc || '' });
    }
    perNs.set(ns, entries);
  }

  db._ix = { nsList, abbrToNs, nsToAbbr, perNs, zh: Object.entries(db.zhIndex || {}) };
  return db;
}

/** 同步惰性装载（suggestTags/translate 要保持同步，调用方不该被迫 await） */
function loadSync(filePath) {
  const key = String(filePath || DEFAULT_DB_PATH);
  if (cache.has(key)) return cache.get(key);

  let db;
  try {
    const raw = readFileSync(key, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      version: Number(parsed.version) || 0,
      builtAt: parsed.builtAt || '',
      namespaces: parsed.namespaces || {},
      tags: parsed.tags || {},
      zhIndex: parsed.zhIndex || {},
      warnings: [],
    };
  } catch (e) {
    db = emptyDb(`标签库不可用（${key}）：${e.code || e.message}；先跑 node scripts/build-tags.mjs`);
  }
  buildIndex(db);
  cache.set(key, db);
  return db;
}

/**
 * 显式装载（异步签名，方便上层 await）。缺文件时返回空结构 + 一条 warning。
 * @param {{path?: string}} [opts]
 */
export async function loadTags({ path } = {}) {
  const db = loadSync(path);
  // 只回公开字段：内部索引（_ix）里有 Map，不该漏给调用方
  return {
    version: db.version,
    builtAt: db.builtAt,
    namespaces: db.namespaces,
    tags: db.tags,
    zhIndex: db.zhIndex,
    warnings: [...db.warnings],
  };
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const normNs = (value) => String(value ?? '').trim().toLowerCase().replace(/：/g, ':');

/** 把 "female" / "f" 统一成规范 ns；未知返回 null */
function canonicalNs(token, ix) {
  const t = normNs(token);
  return t ? ix.abbrToNs.get(t) || null : null;
}

/** 拆 "ns:tag" / "f:tag"；不含前缀时 ns 为 null */
function splitTag(text) {
  const s = String(text ?? '').trim().replace(/：/g, ':');
  const i = s.indexOf(':');
  if (i <= 0) return { ns: null, tag: s };
  return { ns: s.slice(0, i).trim(), tag: s.slice(i + 1).trim() };
}

/** 在某个 ns 里找 tag（先精确、再忽略大小写），返回库里的原始写法 */
function findTag(entries, tag) {
  const want = String(tag || '').trim();
  if (!want) return null;
  const exact = entries.find((e) => e.tag === want);
  if (exact) return exact.tag;
  const low = want.toLowerCase();
  const loose = entries.find((e) => e.lower === low);
  return loose ? loose.tag : null;
}

/** 结果行："female:big breasts 巨乳" */
function formatLine(ns, entry) {
  return entry.zh ? `${ns}:${entry.tag} ${entry.zh}` : `${ns}:${entry.tag}`;
}

const byLenThenText = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * 同一档内的排序：先按命名空间主次（female 优先），再短的在前、再字典序。
 * 为什么要 ns 排序：打 "big b" 时 female:big breasts 比 group:big boss 更像用户要的。
 */
function nsRank(ns) {
  const i = NS_PRIORITY.indexOf(ns);
  return i < 0 ? NS_PRIORITY.length : i;
}

const byScopeThenLength = (a, b) =>
  nsRank(a.scope) - nsRank(b.scope) || byLenThenText(a.e.lower, b.e.lower);

/* ------------------------------------------------------------------ */
/* 联想                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按前缀/子串联想，返回紧凑字符串数组：["female:big breasts 巨乳", ...]
 * 命中顺序：英文前缀 → 英文子串 → 中文子串（英文命中优先，中文只做兜底补充）。
 *
 * @param {string} prefix
 * @param {{ns?: string, limit?: number}} [opts]
 * @returns {string[]}
 */
export function suggestTags(prefix, { ns, limit = 10 } = {}) {
  const db = loadSync();
  const ix = db._ix;

  let q = String(prefix ?? '').trim().toLowerCase();
  let nsFilter = ns ? canonicalNs(ns, ix) : null;
  if (!q) return [];

  // 允许 "f:big" 这种写法顺手带上命名空间
  const bare = splitTag(q);
  if (bare.ns) {
    const fromPrefix = canonicalNs(bare.ns, ix);
    if (fromPrefix) { nsFilter = fromPrefix; q = bare.tag.toLowerCase(); }
  }
  if (!q) return [];

  const scopes = nsFilter ? [nsFilter] : ix.nsList;
  const max = Math.max(1, Math.min(50, Number(limit) || 10));
  const prefixHits = [];
  const subHits = [];
  const zhHits = [];

  for (const scope of scopes) {
    for (const e of ix.perNs.get(scope) || []) {
      if (e.lower.startsWith(q)) prefixHits.push({ scope, e });
      else if (e.lower.includes(q)) subHits.push({ scope, e });
      if (e.zh && e.zh.includes(q)) zhHits.push({ scope, e });
    }
  }

  const sortHits = (hits, cmp) => hits.sort(cmp || byScopeThenLength);
  // 中文档内再分一层：中文完全相等的排前面（打「巨乳」不该先出「巨乳萝莉」）
  const exactZh = (h) => (h.e.zh === q ? 0 : 1);
  const byZhQuality = (a, b) => exactZh(a) - exactZh(b) || byScopeThenLength(a, b);

  const out = [];
  const seen = new Set();
  const push = ({ scope, e }) => {
    const line = formatLine(scope, e);
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
  };

  for (const hits of [sortHits(prefixHits), sortHits(subHits), sortHits(zhHits, byZhQuality)]) {
    for (const hit of hits) {
      if (out.length >= max) return out;
      push(hit);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 翻译 / 查询改写                                                     */
/* ------------------------------------------------------------------ */

/**
 * "巨乳" → "female:big breasts"；"f:big breasts" → "female:big breasts"。
 * 找不到返回 null（不猜、不硬编一个近似值）。
 */
export function translate(text) {
  const db = loadSync();
  const ix = db._ix;
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const { ns, tag } = splitTag(raw);
  if (ns) {
    const scope = canonicalNs(ns, ix);
    if (!scope) return null;
    const found = findTag(ix.perNs.get(scope) || [], tag);
    return found ? `${scope}:${found}` : null;
  }

  // 纯中文：直接走反查表
  const hit = db.zhIndex[raw];
  if (hit) return hit;

  // 没有前缀的英文：全库唯一命中才返回，多个候选按 NS_PRIORITY 取第一（不返回模糊结果）
  const low = raw.toLowerCase();
  for (const scope of NS_PRIORITY) {
    const found = findTag(ix.perNs.get(scope) || [], low);
    if (found) return `${scope}:${found}`;
  }
  const other = ix.nsList.find((scope) => findTag(ix.perNs.get(scope) || [], low));
  return other ? `${other}:${findTag(ix.perNs.get(other) || [], low)}` : null;
}

/** 中文词扫描范围：汉字 + 日文假名 + 韩文（既是「整词」边界，也是别乱替换的保护） */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

/* ------------------------------------------------------------------ */
/* 口语别名表（手写维护）                                              */
/* ------------------------------------------------------------------ */

/**
 * 载入并校验别名表：目标 tag 必须真实存在于 tags-db.json，否则丢掉并记一条 warning。
 * 为什么要校验：别名表是手写的，上游 tag 可能被改名/移除；宁可不认，也不能把用户的中文
 * 换成站点上根本不存在的搜索词（那会静默搜出 0 条）。
 */
function loadAliasSync(filePath) {
  const key = String(filePath || DEFAULT_ALIAS_PATH);
  if (aliasCache.has(key)) return aliasCache.get(key);

  const ix = loadSync()._ix;
  const table = { map: new Map(), entries: [], buckets: new Map(), warnings: [] };

  try {
    const raw = JSON.parse(readFileSync(key, 'utf8'));
    for (const [alias, target] of Object.entries(raw.aliases || {})) {
      const word = String(alias || '').trim();
      const { ns, tag } = splitTag(target);
      const scope = ns ? canonicalNs(ns, ix) : null;
      const found = scope ? findTag(ix.perNs.get(scope) || [], tag) : null;
      if (!word || !found) {
        table.warnings.push(`别名目标不存在，已跳过：${alias} → ${target}`);
        continue;
      }
      const canonical = `${scope}:${found}`;
      table.map.set(word.toLowerCase(), canonical);
      table.entries.push({ alias: word, tag: canonical });
    }
  } catch (e) {
    // 缺文件/坏 JSON 都只是「没有别名」，中文反查与缩写展开照常工作
    table.warnings.push(`别名表不可用（${key}）：${e.code || e.message}`);
  }

  // 分段用的桶：首字 → 同首字的别名，按长度降序（最长匹配优先）
  for (const { alias } of table.entries) {
    if (!/^[\u4e00-\u9fff]+$/.test(alias)) continue;   // 只给纯中文别名建桶
    const list = table.buckets.get(alias[0]) || [];
    list.push(alias);
    table.buckets.set(alias[0], list);
  }
  for (const list of table.buckets.values()) list.sort((a, b) => b.length - a.length);

  aliasCache.set(key, table);
  return table;
}

/** 整词查别名（大小写不敏感） */
function aliasLookup(table, word) {
  const w = String(word ?? '').trim();
  return w ? table.map.get(w.toLowerCase()) || null : null;
}

/**
 * 用一个中文字段串尝试「别名全覆盖分段」，比如「无码汉化」→ 无码 + 汉化。
 * 要求整段被吃掉，否则返回 null（不然「同人志」会被切成「other:doujinshi志」）。
 */
function segmentByAlias(table, run) {
  const walk = (pos) => {
    if (pos === run.length) return [];
    for (const alias of table.buckets.get(run[pos]) || []) {
      if (!run.startsWith(alias, pos)) continue;
      const rest = walk(pos + alias.length);
      if (rest) return [[alias, table.map.get(alias.toLowerCase())], ...rest];
    }
    return null;
  };
  return walk(0);
}

/** 查一个口语词对应的规范 tag；查不到返回 null */
export function aliasOf(word, { aliasPath } = {}) {
  return aliasLookup(loadAliasSync(aliasPath), word);
}

/** [{alias, tag}]，按别名排序；给 eh_tags 之类展示用 */
export function listAliases({ aliasPath } = {}) {
  const table = loadAliasSync(aliasPath);
  return [...table.entries].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

/** 显式装载别名表（附带 warnings，便于自检/排错） */
export async function loadAliases({ path } = {}) {
  const table = loadAliasSync(path);
  return { entries: listAliases({ aliasPath: path }), warnings: [...table.warnings] };
}

/* ------------------------------------------------------------------ */
/* 查询改写                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把搜索词里的口语词 / 中文 / 缩写 ns 换成规范 tag。
 * 顺序：别名（整词，最长优先）→ 中文反查（整词）→ 缩写展开。
 *
 * 为什么不整体做子串替换：搜索词里的中文经常是句子片段，"大胸部" 含 "大胸"、
 * "同人志" 含 "同人"，乱切会把用户的词改成半个 tag。所以只认「整词」，
 * 以及「别名完全覆盖一段中文」这两种情况。
 *
 * @param {string} query
 * @param {{aliasPath?: string}} [opts]
 * @returns {{query: string, replaced: [string, string, string][], warnings: string[]}}
 *          replaced 每项 = [原文, 规范 tag, source]，source ∈ 'alias' | 'zh' | 'abbr'
 */
export function expandQuery(query, { aliasPath } = {}) {
  const db = loadSync();
  const ix = db._ix;
  const table = loadAliasSync(aliasPath);
  const warnings = [...db.warnings, ...table.warnings];
  const replaced = [];
  let text = String(query ?? '');
  if (!text.trim()) return { query: text, replaced, warnings };

  // 1a) 别名：按空白切词，整词相等才换（NTR / AI生成 这种带 ASCII 的走这里）
  text = text
    .split(/(\s+)/)
    .map((token) => {
      if (!/^\S+$/.test(token)) return token;
      const hit = aliasLookup(table, token);
      if (!hit) return token;
      replaced.push([token, hit, 'alias']);
      return hit;
    })
    .join('');

  // 1b) 别名：中文段整体命中，或「别名全覆盖分段」
  text = text.replace(CJK_RUN, (run) => {
    const whole = aliasLookup(table, run);
    if (whole) {
      replaced.push([run, whole, 'alias']);
      return whole;
    }
    const segs = segmentByAlias(table, run);
    if (!segs) return run;
    for (const [from, to] of segs) replaced.push([from, to, 'alias']);
    return segs.map(([, to]) => to).join(' ');   // 多个 tag 之间用空格：EH 搜索里是 AND
  });

  // 2) 中文反查（整词）
  text = text.replace(CJK_RUN, (run) => {
    const hit = db.zhIndex[run];
    if (!hit) {
      if (run.length >= 2) warnings.push(`未收录中文标签：${run}`);
      return run;
    }
    replaced.push([run, hit, 'zh']);
    return hit;
  });

  // 3) 缩写命名空间：f: → female:   l: → language:   （全名不动）
  text = text.replace(/(^|[\s(（])([a-z]{1,3})[:：]/gi, (whole, lead, abbr) => {
    const scope = canonicalNs(abbr, ix);
    if (!scope) return whole;                       // 不认识的缩写：原样留着，别改成半个词
    if (abbr.toLowerCase() === scope) return whole; // 本来就是全名
    const to = `${scope}:`;
    replaced.push([`${abbr}:`, to, 'abbr']);
    return `${lead}${to}`;
  });

  return { query: text, replaced, warnings };
}

/* ------------------------------------------------------------------ */
/* 命名空间                                                            */
/* ------------------------------------------------------------------ */

/** "female:big breasts" / "f:big breasts" → "female"；无前缀返回 null */
export function namespaceOf(tag) {
  const { ns } = splitTag(tag);
  if (!ns) return null;
  return canonicalNs(ns, loadSync()._ix);
}

/**
 * 判断 tag 是否存在于本地标签库（同步）。查询解析器用它决定要不要把
 * `female:big breasts` 这种没加引号的多词值合并回一个 tag。
 * @param {string} ns 命名空间全名或缩写（f / female）
 * @param {string} value tag 值，不含命名空间
 * @returns {boolean}
 */
export function hasTag(ns, value) {
  const db = loadSync();
  const ix = db._ix;
  const scope = canonicalNs(ns, ix);
  if (!scope) return false;
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return false;
  let all = ix.lowerTags;
  if (!all) { all = new Map(); ix.lowerTags = all; }
  let set = all.get(scope);
  if (!set) {
    set = new Set(Object.keys(db.tags[scope] || {}).map((k) => k.toLowerCase()));
    all.set(scope, set);
  }
  return set.has(v);
}

/** "female" / "f" → "f"；未知返回 '' */
export function abbrOf(ns) {
  const ix = loadSync()._ix;
  const scope = canonicalNs(ns, ix);
  return scope ? ix.nsToAbbr.get(scope) || '' : '';
}

/** [{ns, name, abbr, count}]，顺序与构建脚本一致 */
export function allNamespaces() {
  const db = loadSync();
  const ix = db._ix;
  return ix.nsList.map((ns) => ({
    ns,
    name: (db.namespaces[ns] || {}).name || ns,
    abbr: ix.nsToAbbr.get(ns) || '',
    count: (ix.perNs.get(ns) || []).length,
  }));
}

/* ------------------------------------------------------------------ */
/* 自检（不联网、不写盘）                                              */
/* ------------------------------------------------------------------ */

export async function __selftest() {
  const out = { module: 'tags', ok: true, checks: [], warnings: [] };
  try {
    const db = await loadTags();
    out.facts = {
      version: db.version,
      builtAt: db.builtAt,
      namespaces: Object.keys(db.namespaces).length,
      tags: Object.values(db.tags).reduce((n, m) => n + Object.keys(m).length, 0),
      zh: Object.keys(db.zhIndex).length,
    };
    out.checks.push(['有数据', out.facts.tags > 0]);
    out.checks.push(['命名空间齐全', out.facts.namespaces === 12]);
    out.checks.push(['联想可用', suggestTags('big b', { limit: 5 }).length > 0]);
    out.checks.push(['别名表已加载', listAliases().length > 0]);
    out.checks.push(['别名可展开', expandQuery('中文').query === 'language:chinese']);
    const missing = await loadTags({ path: `${DEFAULT_DB_PATH}.nope` });
    out.checks.push(['缺文件容错', missing.warnings.length === 1 && Object.keys(missing.tags).length === 0]);
    out.warnings.push(...db.warnings);
  } catch (e) {
    out.ok = false;
    out.warnings.push(`自检异常: ${e.message}`);
  }
  out.ok = out.ok && out.checks.every(([, pass]) => !!pass);
  return out;
}
