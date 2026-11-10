#!/usr/bin/env node
/**
 * build-tags.mjs — 把 EhTagTranslation/Database 的 markdown 表编译成 src/tags-db.json
 *
 * 手动跑：node scripts/build-tags.mjs
 *
 * 为什么是独立脚本、不进运行时：
 *   上游标签库变动很慢（几个月一次），运行时只需要读编译产物；把网络抓取留在脚本里，
 *   服务端启动与每次查询都不会碰外网，也不需要为「拉标签」设计缓存与失败兜底。
 *
 * 为什么走代理：本机直连 GitHub 不通，sing-box 在 127.0.0.1:10808。
 *
 * 幂等：内容（除 builtAt）与磁盘上一致时直接跳过写入，重复执行不会产生无意义 diff。
 */

import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SocksProxyAgent } from 'socks-proxy-agent';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'src', 'tags-db.json');

const REPO = 'EhTagTranslation/Database';
const BRANCH = 'master';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/database`;
const API_DIR = `https://api.github.com/repos/${REPO}/contents/database`;

/** 要拉的命名空间；顺序即输出顺序（保证两次构建的 key 顺序一致） */
const NAMESPACES = [
  'artist', 'character', 'cosplayer', 'female', 'group', 'language',
  'location', 'male', 'mixed', 'other', 'parody', 'reclass',
];

/** 上游 frontmatter 缺失时的兜底中文名（只在解析失败时用，正常都以前端 matter 为准） */
const NAME_FALLBACK = {
  artist: '画师', character: '角色', cosplayer: 'Coser', female: '女性', group: '社团',
  language: '语言', location: '地点', male: '男性', mixed: '混合', other: '其他',
  parody: '原作', reclass: '重新分类',
};

const PROXY = process.env.EH_TAGS_PROXY ?? 'socks5h://127.0.0.1:10808';
const DESC_MAX = 120;   // 描述截断长度（字符数，不是字节）
const RETRIES = 2;      // 首次之外再试 2 次
const TIMEOUT_MS = 60_000;
const UA = 'eh-mcp-tags-builder/1.0 (+local build script)';

/* ------------------------------------------------------------------ */
/* HTTP（只本脚本用：https + SOCKS agent，带超时/重试/单跳重定向）      */
/* ------------------------------------------------------------------ */

const agent = PROXY ? new SocksProxyAgent(PROXY) : undefined;

/** 发一次 GET，返回 {status, body}；不抛（网络错误也返回 status=0） */
function getOnce(url, depth = 0) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { agent, timeout: TIMEOUT_MS, headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' } },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && depth < 3) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return resolve(getOnce(next, depth + 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试的 GET：失败重试 RETRIES 次，仍失败返回 null（调用方决定怎么降级） */
async function fetchText(url, label = url) {
  let lastErr = '';
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const r = await getOnce(url);
    if (r.status === 200 && r.body) return r.body;
    lastErr = r.error || `HTTP ${r.status}`;
    if (attempt < RETRIES) {
      const wait = 800 * (attempt + 1);
      console.warn(`  ! ${label} 失败（${lastErr}），${wait}ms 后重试 ${attempt + 1}/${RETRIES}`);
      await sleep(wait);
    }
  }
  console.warn(`  ! ${label} 放弃：${lastErr}`);
  return null;
}

/** 用 GitHub contents API 核对文件名（raw 404 多半是名字写错，不是网络问题） */
async function listRemoteFiles() {
  const text = await fetchText(API_DIR, 'contents API');
  if (!text) return null;
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((x) => x.type === 'file').map((x) => x.name) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 取 `---` 之间的 frontmatter 顶层 `key: value`；多行块（>`/`-`）按缩进自然忽略 */
function parseFrontMatter(md) {
  const out = {};
  const lines = String(md).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2].trim();
    // 只收单行标量；`>`/`|`/空值属于多行块，对我们没用的字段
    if (val && !/^[>|]$/.test(val)) out[m[1]] = val.replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 表格行是否表头/分隔线/分类行 */
function isSkippableRow(cells) {
  const first = cells[0] || '';
  if (!first && (cells[1] || '').startsWith('==')) return true;      // |  | == Age == | ... |
  if (first === '原始标签') return true;                              // 表头
  if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return true; // | --- | --- |
  if (first.startsWith('==')) return true;                            // 分类行没有第一列时漏网的情形
  return false;
}

/** 去 markdown 装饰：图片整块删、链接留文字、html/反引号抹掉 */
function stripMarkdown(raw) {
  let t = String(raw ?? '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');       // 图片：连 alt 一起丢
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');     // 链接：只留可见文字
  t = t.replace(/<br\s*\/?>/gi, ' ');
  t = t.replace(/<\/?[a-z][^>]*>/gi, ' ');
  t = t.replace(/`+/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** 截断到 max 个字符（按码点切，别把 emoji/生僻字劈成两半） */
function truncate(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** 描述：清洗 + 截断 */
function cleanDesc(raw) {
  return truncate(stripMarkdown(raw), DESC_MAX);
}

/** 名称：只清洗不截断（上游名称里夹着图标 markdown，比如 stockings 的「![长筒袜图标](… )长筒袜」） */
function cleanName(raw) {
  return stripMarkdown(raw);
}

/**
 * 解析一个 md 文件的正文表格。
 * @returns {{tag: string, zh: string, desc: string}[]}
 */
function parseTableRows(md) {
  const rows = [];
  for (const line of String(md).split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    // 首尾各有一个空壳，slice 掉；上游没有转义管道（已核），直接切
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (isSkippableRow(cells)) continue;
    const tag = cells[0];
    if (!tag) continue;
    rows.push({ tag, zh: cleanName(cells[1] || ''), desc: cleanDesc(cells[2] || '') });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/** 按 ns 顺序稳定排序：先按 tag 字典序，保证两次构建完全一致 */
function sortTags(map) {
  const out = {};
  for (const k of Object.keys(map).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = map[k];
  return out;
}

/**
 * zh 反查：同一个中文可能对应多个 tag（如「巨乳」只有一条，但「眼镜」可能 mixed/female 都有）。
 * 规则：先到先得，但 female/male 优先于其他 ns —— 用户手打中文时通常想要性癖主标签。
 */
const NS_PRIORITY = ['female', 'male', 'mixed', 'other', 'language', 'parody', 'character', 'artist', 'group', 'cosplayer', 'location', 'reclass'];

function zhRank(ref) {
  const ns = ref.slice(0, ref.indexOf(':'));
  const i = NS_PRIORITY.indexOf(ns);
  return i < 0 ? NS_PRIORITY.length : i;
}

function buildZhIndex(tags) {
  const index = {};
  for (const ns of Object.keys(tags)) {
    for (const [tag, meta] of Object.entries(tags[ns])) {
      const zh = meta.zh;
      if (!zh) continue;
      const ref = `${ns}:${tag}`;
      const cur = index[zh];
      if (!cur) { index[zh] = ref; continue; }
      if (zhRank(ref) < zhRank(cur)) index[zh] = ref;   // 更「主」的 ns 覆盖
    }
  }
  return sortTags(index);
}

/* ------------------------------------------------------------------ */
/* 别名表校验（手写文件，只读不改）                                     */
/* ------------------------------------------------------------------ */

/**
 * 校验 src/tags-alias.json 里每条目标 tag 是否真在库里。
 * 为什么放在构建时：别名表是人手写的，上游 tag 改名/删除后不会有人提醒；
 * 每次重建顺手体检一遍，坏条目在运行时会被跳过（见 src/tags.js loadAliasSync）。
 */
async function validateAliases(tags) {
  const file = path.join(ROOT, 'src', 'tags-alias.json');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    console.log(`[build-tags] 别名表读不了（${e.code || e.message}），跳过校验`);
    return;
  }

  const abbrToNs = {};
  for (const [ns, meta] of Object.entries(NAMESPACES_META)) if (meta.abbr) abbrToNs[meta.abbr] = ns;

  const bad = [];
  let ok = 0;
  for (const [alias, target] of Object.entries(raw.aliases || {})) {
    const i = String(target).indexOf(':');
    const nsRaw = i > 0 ? String(target).slice(0, i).trim() : '';
    const tag = i > 0 ? String(target).slice(i + 1).trim() : String(target).trim();
    const ns = tags[nsRaw] ? nsRaw : abbrToNs[nsRaw];
    if (!ns || !tags[ns] || !tags[ns][tag]) { bad.push(`${alias} → ${target}`); continue; }
    ok += 1;
  }

  console.log(`[build-tags] 别名表 ${ok + bad.length} 条，有效 ${ok} 条`);
  if (bad.length) {
    console.warn(`[build-tags] 以下别名目标不存在（运行时会跳过，请改 src/tags-alias.json）：`);
    for (const b of bad) console.warn(`  ! ${b}`);
  }
}

/** 构建过程中各 ns 的 frontmatter（供别名表把缩写解析回全名） */
const NAMESPACES_META = {};

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function buildNamespace(ns, remoteFiles) {
  if (remoteFiles && !remoteFiles.includes(`${ns}.md`)) {
    console.warn(`  ! ${ns}.md 不在远端目录清单里，跳过`);
    return null;
  }
  const md = await fetchText(`${RAW_BASE}/${ns}.md`, `${ns}.md`);
  if (!md) return null;

  const fm = parseFrontMatter(md);
  const rows = parseTableRows(md);
  if (!rows.length) {
    console.warn(`  ! ${ns}.md 没解析出任何标签行（表格结构变了？）`);
  }

  const tags = {};
  for (const r of rows) {
    // 同一 tag 重复出现时保留第一条（上游偶尔在多个分类里重复列同一行）
    if (tags[r.tag]) continue;
    tags[r.tag] = { zh: r.zh, desc: r.desc };
  }

  console.log(`  · ${ns.padEnd(10)} ${String(rows.length).padStart(6)} 行  (${fm.name || NAME_FALLBACK[ns] || ns})`);
  return {
    meta: { name: fm.name || NAME_FALLBACK[ns] || ns, abbr: fm.abbr || '' },
    tags: sortTags(tags),
  };
}

async function main() {
  console.log(`[build-tags] proxy=${PROXY || '(direct)'}  source=${REPO}@${BRANCH}`);
  const remoteFiles = await listRemoteFiles();
  if (remoteFiles) console.log(`[build-tags] 远端目录 ${remoteFiles.length} 个文件：${remoteFiles.join(', ')}`);
  else console.warn('[build-tags] 目录清单取不到，按已知文件名继续');

  const namespaces = {};
  const tags = {};
  let total = 0;
  let failed = 0;

  for (const ns of NAMESPACES) {
    const pack = await buildNamespace(ns, remoteFiles);
    if (!pack) { failed += 1; continue; }
    namespaces[ns] = pack.meta;
    tags[ns] = pack.tags;
    NAMESPACES_META[ns] = pack.meta;
    total += Object.keys(pack.tags).length;
  }

  if (!total) {
    console.error('[build-tags] 一条都没拿到，保留原文件不动');
    process.exitCode = 1;
    return;
  }

  const zhIndex = buildZhIndex(tags);
  const payload = { version: 1, namespaces, tags, zhIndex };
  const builtAt = new Date().toISOString();

  const existing = await readExisting();
  const same = existing && hashable(existing) === hashable(payload);

  if (same) {
    console.log(`[build-tags] 内容无变化，跳过写入（保持原 builtAt=${existing.builtAt}）`);
  } else {
    const file = { version: 1, builtAt, namespaces, tags, zhIndex };
    await fs.writeFile(OUT_FILE, `${JSON.stringify(file)}\n`, 'utf8');
    const size = (JSON.stringify(file).length / 1024 / 1024).toFixed(2);
    console.log(`[build-tags] 写入 ${path.relative(ROOT, OUT_FILE)}  ${size} MB  builtAt=${builtAt}`);
  }

  console.log(`[build-tags] 命名空间 ${Object.keys(namespaces).length}/${NAMESPACES.length}，标签 ${total} 条，中文索引 ${Object.keys(zhIndex).length} 条${failed ? `，失败 ${failed} 个` : ''}`);
  await validateAliases(tags);
  if (total < 8000) {
    console.warn('[build-tags] 标签总数偏低（< 8000），检查上游是否改版');
    process.exitCode = 1;
  }
}

/** 读旧产物（不存在/坏了都当没有） */
async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 比较用：剔掉时间戳，只比内容 */
function hashable(db) {
  return JSON.stringify({ namespaces: db.namespaces, tags: db.tags, zhIndex: db.zhIndex });
}

await main();
