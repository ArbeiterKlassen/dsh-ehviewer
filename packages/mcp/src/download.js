// src/download.js —— 图片下载（并发 / 断点续传 / 进度）与 archiver 归档
// 约定：
//   · 图片直链必须带 Referer = 该图所在「图片页」URL（不是详情页），否则站点回 403。
//   · 二进制取图优先走 client 的 getBinary / download；http.js 目前只提供文本通道，
//     所以这里补了一条最小可用的二进制通道（直连 / socks5 / http 代理），配置取 config.loadConfig()。
//   · 单张失败重试 2 次（共 3 次尝试），仍失败只记录，不拖垮整批。
//   · 归档是三步（见 reference-notes.md 第 4 节）：GET archiver 页 → POST hathdl_xres →
//     从表单页取 dltype/dlcheck 再 POST → 拿到 /archive/...zip。dryRun 默认 true，只走第一步。
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import * as cheerio from 'cheerio';
import { SocksProxyAgent } from 'socks-proxy-agent';

const DEFAULT_CONCURRENCY = 3;
const RETRY = 2; // 额外重试次数
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EH_ORIGIN = 'https://e-hentai.org';

// ── 长期跑的护栏 ───────────────────────────────────────────────────────────
/** meta.json 结构版本：v2 用 pages[] 收口每张图的状态，v1 仍可读（normalizeMeta）。 */
export const META_VERSION = 2;
/** 目标盘剩余空间低于这个值就拒绝开跑：写到一半没空间，比不写更麻烦。 */
export const MIN_FREE_BYTES = 200 * 1024 * 1024;
/** 撞上 429 / temporarily banned 后的统一退避时长。 */
const RATE_LIMIT_BACKOFF_MS = 5000;

// ── 懒加载兄弟模块 ─────────────────────────────────────────────────────────
// pages.js / gallery.js 由别人并行写；这里用动态 import，缺文件时不让整个模块炸掉。
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
  _mods = {
    pages: await load('./pages.js'),
    gallery: await load('./gallery.js'),
    browse: await load('./browse.js'),
  };
  return _mods;
}

function pick(fn, deps, name) {
  const d = deps && typeof deps[name] === 'function' ? deps[name] : null;
  return d || fn || null;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 从图片 URL 推断扩展名；认不出就当 jpg。 */
export function extFromUrl(url) {
  try {
    const p = new URL(String(url), `${EH_ORIGIN}/`).pathname.toLowerCase();
    const m = p.match(/\.([a-z0-9]+)$/);
    const ext = m && m[1] === 'jpeg' ? 'jpg' : m && m[1];
    if (ext && IMG_EXT.has(ext)) return ext;
  } catch {
    /* 落到默认 */
  }
  return 'jpg';
}

/** 001.jpg 这样的文件名（1 基、三位补零）。 */
export function imageFileName(pos, ext) {
  return `${String(pos).padStart(3, '0')}.${ext || 'jpg'}`;
}

async function fileSize(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

async function atomicWrite(file, text) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function toBuffer(res) {
  if (!res) return null;
  const cand = res.buffer ?? res.body ?? res.data ?? res.bytes;
  if (!cand) return null;
  if (Buffer.isBuffer(cand)) return cand;
  if (cand instanceof Uint8Array) return Buffer.from(cand);
  if (cand instanceof ArrayBuffer) return Buffer.from(new Uint8Array(cand));
  if (typeof cand === 'string') return Buffer.from(cand, 'binary'); // 兜底：客户端把 body 读成字符串
  return null;
}

/**
 * 简单并发池：结果按输入顺序返回，单个任务抛错由 worker 自己兜住。
 * shouldStop 给取消用：每取下一个任务前问一次，取消后不再开新活。
 */
async function pool(items, limit, worker, { shouldStop } = {}) {
  const results = new Array(items.length);
  const n = Math.max(1, Math.min(Number(limit) || DEFAULT_CONCURRENCY, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      if (typeof shouldStop === 'function' && shouldStop()) return;
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absUrl(href, base = `${EH_ORIGIN}/`) {
  try {
    return new URL(String(href), base).href;
  } catch {
    return String(href);
  }
}

// ── 二进制取图通道 ─────────────────────────────────────────────────────────
// http.js 的 client.get 只返回 text（图片会被当文本解码，救不回来），
// 所以这里自带一条最小通道；一旦 http.js 补上 getBinary，会自动优先用它。

let _binCfg = null; // { at, proxy, ua, timeoutMs }

async function binaryConfig() {
  const now = Date.now();
  if (_binCfg && now - _binCfg.at < 30_000) return _binCfg; // 30s 内复用，配置改了也能跟上
  let cfg = {};
  try {
    const m = await import('./config.js');
    if (typeof m.loadConfig === 'function') cfg = (await m.loadConfig()) || {};
  } catch {
    /* config.js 缺失：直连 */
  }
  _binCfg = {
    at: now,
    proxy: typeof cfg.proxy === 'string' ? cfg.proxy.trim() : '',
    ua: cfg.userAgent || DEFAULT_UA,
    timeoutMs: Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : 30_000,
  };
  return _binCfg;
}

/** 走 HTTP 代理开 CONNECT 隧道，返回裸 socket。 */
function tunnelThroughHttpProxy(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = {};
    if (p.username) {
      const auth = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('代理 CONNECT 超时')));
    req.end();
  });
}

/** https.Agent：先穿 HTTP 代理开隧道，再在 socket 上做 TLS。 */
function httpProxyAgent(proxyUrl) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
  agent.createConnection = (options, cb) => {
    let called = false;
    const done = (err, sock) => {
      if (called) return;
      called = true;
      cb(err, sock);
    };
    tunnelThroughHttpProxy(proxyUrl, options.host, options.port || 443)
      .then((socket) => {
        const tlsSocket = tls.connect({ socket, servername: options.host, ALPNProtocols: ['http/1.1'] });
        tlsSocket.once('error', (e) => done(e));
        tlsSocket.once('secureConnect', () => done(null, tlsSocket));
      })
      .catch((e) => done(e));
  };
  return agent;
}

const _agents = new Map();
function agentFor(proxy, urlObj) {
  if (!proxy) return null;
  const key = `${proxy}|${urlObj.protocol}`;
  if (_agents.has(key)) return _agents.get(key);
  let agent = null;
  try {
    const proto = new URL(proxy).protocol.toLowerCase();
    if (proto.startsWith('socks')) {
      agent = new SocksProxyAgent(proxy, { keepAlive: true, timeout: 30_000 });
    } else if ((proto === 'http:' || proto === 'https:') && urlObj.protocol === 'https:') {
      agent = httpProxyAgent(proxy);
    }
  } catch {
    agent = null;
  }
  _agents.set(key, agent);
  return agent;
}

/**
 * 取二进制并带回响应头 —— 短包校验要看 content-length。
 * 和 fetchBinary 分开：后者是老接口，返回裸 Buffer，别有调用方被换类型坑到。
 */
export async function fetchBinaryResult(urlStr, { referer, headers = {}, redirects = 3 } = {}) {
  const cfg = await binaryConfig();
  const u = new URL(urlStr);
  const agent = agentFor(cfg.proxy, u);

  const h = {
    'user-agent': cfg.ua,
    accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(referer ? { referer } : {}),
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: h,
        agent: agent || undefined,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          fetchBinaryResult(new URL(res.headers.location, urlStr).href, { referer, headers, redirects: redirects - 1 }).then(
            resolve,
            reject,
          );
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(httpStatusError(`HTTP ${status}`, status));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers, status, finalUrl: urlStr }));
        res.on('error', reject);
      },
    );
    req.setTimeout(cfg.timeoutMs, () => req.destroy(new Error(`图片请求超时（${cfg.timeoutMs}ms）`)));
    req.on('error', reject);
    req.end();
  });
}

/** 老接口：只要字节。需要 content-length 的新代码请用 fetchBinaryResult。 */
export async function fetchBinary(urlStr, opts = {}) {
  const r = await fetchBinaryResult(urlStr, opts);
  return r.buffer;
}

// ── 完整性 / 限流 / 取消 的小工具 ─────────────────────────────────────────

/** 把 status 挂到 Error 上，上层靠它判 429。 */
function httpStatusError(message, status) {
  const err = new Error(message);
  if (status) err.status = Number(status) || 0;
  return err;
}

/** 从响应头取 content-length；取不到（chunked / 代理改写）返回 null。 */
function contentLengthOf(headers) {
  if (!headers) return null;
  const raw = headers['content-length'] ?? headers['Content-Length'];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 短包判定：服务器说多少字节就得给多少。
 * 为什么非查不可：连接中途被掐时 undici / net 只给一段 body 也不报错，
 * 落盘就是一张残图，下次续传还会因为「文件非空」被当成功——一路烂下去。
 */
function assertComplete(got, pos) {
  const buffer = got && got.buffer;
  if (!buffer || !buffer.length) throw new Error(`第 ${pos} 张：响应体为空`);
  const expected = got.expected;
  if (expected != null && buffer.length < expected) {
    const err = new Error(`第 ${pos} 张：短包（收到 ${buffer.length} / 应 ${expected} 字节）`);
    err.short = true;
    err.expected = expected;
    err.received = buffer.length;
    throw err;
  }
}

/** 429 / temporarily banned / too many requests —— 一律按限流处理。 */
function isRateLimited(err) {
  if (!err) return false;
  if (Number(err.status) === 429) return true;
  return /temporarily banned|too many requests|\b429\b/i.test(String(err.message || err));
}

/** 取图片字节：client.getBinary → client.download → 内置通道，三条路都带 content-length。 */
async function fetchImage(client, url, referer) {
  const headers = referer ? { Referer: referer } : undefined;

  if (client && typeof client.getBinary === 'function') {
    const r = await client.getBinary(url, { referer, headers });
    const buf = toBuffer(r);
    if (buf && buf.length) return { buffer: buf, expected: contentLengthOf(r && r.headers) };
    throw httpStatusError(`getBinary 空响应 (status=${r && r.status})`, r && r.status);
  }
  if (client && typeof client.download === 'function') {
    const r = await client.download(url, { referer, headers });
    const buf = toBuffer(r) || (Buffer.isBuffer(r) ? r : null);
    if (buf && buf.length) return { buffer: buf, expected: contentLengthOf(r && r.headers) };
    throw httpStatusError('download 空响应', r && r.status);
  }
  const r = await fetchBinaryResult(url, { referer });
  return { buffer: r.buffer, expected: contentLengthOf(r.headers) };
}

// ── 并发闸门（可临时降速） ─────────────────────────────────────────────────

/**
 * 计数信号量 + 可动态收窄的上限。
 * 为什么不用 pool 的 worker 数：那个数启动时就定死了，而 429 要求「立刻少发」，
 * 只能在任务内部用闸门限流。
 */
function createGate(limit) {
  const queue = [];
  const s = { limit: Math.max(1, Math.floor(Number(limit)) || 1), active: 0 };
  const drain = () => {
    while (s.active < s.limit && queue.length) {
      s.active += 1;
      const run = queue.shift();
      run();
    }
  };
  return {
    get limit() {
      return s.limit;
    },
    /** 并发减半（不低于 1），返回新上限。 */
    halve() {
      const next = Math.max(1, Math.floor(s.limit / 2));
      if (next < s.limit) s.limit = next;
      return s.limit;
    },
    async take() {
      if (s.active < s.limit) {
        s.active += 1;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
    },
    free() {
      s.active = Math.max(0, s.active - 1);
      drain();
    },
  };
}

/** 限流退避：所有 worker 共享一个截止时间，免得各自 sleep 完一起冲上去再撞一次。 */
async function waitForCooldown(cooldown) {
  if (!cooldown) return;
  const left = cooldown.until - Date.now();
  if (left > 0) await sleep(left);
}

// ── 取消 ───────────────────────────────────────────────────────────────────
// gid → 标记对象。downloadGallery 进来登记、离开注销；用对象是为了让在飞的
// worker 每次都能读到最新值（置位后不再开新图、不再落盘）。

const _cancelFlags = new Map();

/**
 * 取消某个画廊正在跑的下载：不再开新图，在飞的那张跑完就收。
 * @returns {boolean} 有活跃任务并已置位 → true；没有任务 → false
 */
export function cancelDownload(gid) {
  const key = String(gid ?? '');
  if (!key) return false;
  const flag = _cancelFlags.get(key);
  if (!flag) return false;
  flag.cancelled = true;
  return true;
}

// ── meta.json（v2，兼容读 v1） ─────────────────────────────────────────────

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/**
 * 把任意版本的 meta 归一成 v2，坏数据返回 null（不抛）。
 * v1 = {gallery:{...}, images:[{index,url,file,bytes,status}]}
 * v2 = {version:2, gid, token, title, pages:[...], startedAt, finishedAt, site}
 * 为什么要归一：断点续传要按 index 查上次的字节数，v1 的字段名和 v2 不一样。
 */
export function normalizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fromVersion = Number(raw.version) || 1;
  const g = (fromVersion >= 2 ? raw : raw.gallery || {}) || {};
  const src = fromVersion >= 2 ? raw.pages : raw.images;
  const pages = (Array.isArray(src) ? src : [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => {
      const bytes = Number(p.bytes);
      return {
        index: Number(p.index),
        url: p.url ?? null,
        file: p.file ?? null,
        bytes: Number.isFinite(bytes) ? bytes : 0,
        status: p.status || (Number(p.bytes) > 0 ? 'downloaded' : 'failed'),
      };
    })
    .filter((p) => Number.isFinite(p.index));

  return {
    version: META_VERSION,
    fromVersion,
    gid: g.gid ?? raw.gid ?? null,
    token: g.token ?? raw.token ?? null,
    title: g.title ?? raw.title ?? null,
    site: raw.site ?? originOf(g.url) ?? null,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    pages,
  };
}

/** 读目录下的 meta.json 并归一成 v2；没有 / 坏了都返回 null。 */
export async function readMeta(dir) {
  if (!dir) return null;
  let text = null;
  try {
    text = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    return normalizeMeta(JSON.parse(text));
  } catch {
    return null;
  }
}

/** index → 上次记录的字节数，续传时用来判断「这个文件是完整的」。 */
async function metaBytesIndex(dir) {
  const meta = await readMeta(dir);
  const map = new Map();
  if (!meta) return map;
  for (const p of meta.pages) map.set(p.index, p.bytes);
  return map;
}

/**
 * 续传跳过规则：
 *   · 文件不存在 / 0 字节 → 重下；
 *   · 有 meta 记录 → 字节数必须完全一致（截断的文件会被抓出来）；
 *   · 没有 meta 记录（老目录 / meta 丢了）→ 非空就当完整，别整本重下。
 */
function shouldSkipExisting(size, recordedBytes) {
  if (!(size > 0)) return false;
  if (recordedBytes == null) return true;
  return size === recordedBytes;
}

/** 目标盘剩余字节；测不出来返回 null（平台不支持就当不拦，别把下载卡死）。 */
async function availableBytes(dir, _deps) {
  if (_deps && typeof _deps.freeBytes === 'function') {
    const n = Number(await _deps.freeBytes(dir));
    return Number.isFinite(n) ? n : null;
  }
  try {
    const st = await fsp.statfs(dir);
    const n = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function mb(n) {
  return `${(Number(n) / 1024 / 1024).toFixed(0)}MB`;
}

// ── 下载主流程 ─────────────────────────────────────────────────────────────

/**
 * 下载整本画廊的图片。
 * @param {object} opts
 * @param {object} opts.client   http.js 的 client
 * @param {object} opts.gallery  GalleryDetail / GalleryListItem（至少要有 gid、token）
 * @param {string} [opts.dir]    下载根目录（默认 ./downloads）
 * @param {number} [opts.concurrency=3]
 * @param {number} [opts.minFreeBytes]      剩余空间下限，默认 MIN_FREE_BYTES（200MB）
 * @param {number} [opts.rateLimitBackoffMs] 撞 429 后的退避，默认 5s（测试可调小）
 * @param {(p:{done:number,total:number,current:object})=>void} [opts.onProgress]
 * @param {object} [opts._deps]  测试注入：{listPages, resolveImage, freeBytes}
 * @returns {Promise<{dir:string, downloaded:number, skipped:number, failed:Array, warnings:string[], cancelled:boolean}>}
 */
export async function downloadGallery({
  client,
  gallery,
  dir,
  concurrency = DEFAULT_CONCURRENCY,
  minFreeBytes = MIN_FREE_BYTES,
  rateLimitBackoffMs = RATE_LIMIT_BACKOFF_MS,
  onProgress,
  _deps,
} = {}) {
  if (!client) throw new Error('downloadGallery: 缺少 client');
  const gid = gallery && (gallery.gid ?? gallery.id);
  if (!gid) throw new Error('downloadGallery: gallery 缺少 gid');
  const token = gallery.token ?? 'notoken';

  const M = await mods();
  const listPages = pick(M.pages && M.pages.listPages, _deps, 'listPages');
  const resolveImage = pick(M.pages && M.pages.resolveImage, _deps, 'resolveImage');
  if (typeof listPages !== 'function' || typeof resolveImage !== 'function') {
    throw new Error('downloadGallery: pages.js 未就绪（需要 listPages / resolveImage）');
  }

  const root = path.resolve(dir || path.join(process.cwd(), 'downloads'));
  const outDir = path.join(root, `${gid}-${token}`);
  await fsp.mkdir(outDir, { recursive: true });

  // 0) 磁盘保护：先看空间再决定开不开跑。写一半断粮会把半个目录留在那儿，
  //    下次续传还得靠 meta 去分辨哪些文件是完整的，不如直接说清楚。
  const free = await availableBytes(outDir, _deps);
  if (free != null && free < minFreeBytes) {
    const err = new Error(`目标盘只剩 ${mb(free)}，不够下这本（至少留 ${mb(minFreeBytes)}）。换个目录，或者先清点空间。`);
    err.code = 'ENOSPC_GUARD';
    err.freeBytes = free;
    throw err;
  }

  const cancelFlag = { cancelled: false };
  _cancelFlags.set(String(gid), cancelFlag);
  const isCancelled = () => cancelFlag.cancelled === true;

  const startedAt = new Date().toISOString();
  const warnings = [];
  const warn = (msg) => {
    // 上限 20 条：限流反复触发时别把 warnings 堆成一整页塞回模型
    if (msg && warnings.length < 20 && !warnings.includes(msg)) warnings.push(msg);
  };

  const gate = createGate(concurrency);
  const cooldown = { until: 0 };
  const prevBytes = await metaBytesIndex(outDir); // 上次的 meta（v1 / v2 都认）

  let downloaded = 0;
  let skipped = 0;
  let done = 0;
  let total = 0;
  const failed = [];
  const records = [];

  const report = (current) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ done, total, current });
    } catch {
      /* 回调自身的异常不影响下载 */
    }
  };

  try {
    // 1) 页列表（站点一屏最多 20 张，listPages 自己翻完）
    const entries = (await listPages(client, { gallery })) || [];
    total = entries.length;
    records.length = total;

    // 2) 逐页解析图片直链（解析也走小并发）
    const resolved = await pool(
      entries,
      Math.min(4, Math.max(1, concurrency)),
      async (entry) => {
        try {
          const img = await resolveImage(client, entry.url);
          return { entry, img, error: null };
        } catch (err) {
          return { entry, img: null, error: err?.message ?? String(err) };
        }
      },
      { shouldStop: isCancelled },
    );

    // 3) 组装任务（文件名按位置补零，保证 001..N 连续）
    const tasks = resolved.map((it, i) => {
      const pos = i + 1;
      const url = it && it.img && it.img.url;
      const ext = extFromUrl(url || '');
      return {
        pos,
        page: (it && it.entry && it.entry.url) || null,
        url: url || null,
        file: path.join(outDir, imageFileName(pos, ext)),
        resolveError: it ? it.error : '已取消，未解析',
        cancelled: !it,
      };
    });
    // 取消发生在翻页 / 解析阶段：剩下的一律按 cancelled 收尾
    if (isCancelled()) for (const t of tasks) t.cancelled = true;

    const runOne = async (task) => {
      const rec = {
        index: task.pos,
        page: task.page,
        url: task.url,
        file: task.file ? path.basename(task.file) : null,
        bytes: 0,
        attempts: 0,
        status: 'failed',
      };

      if (task.cancelled) {
        rec.status = 'cancelled';
        return rec;
      }

      // 解析阶段就失败：没有直链，直接记失败
      if (!task.url) {
        rec.error = `resolveImage 失败: ${task.resolveError || '无图片地址'}`;
        failed.push({
          index: task.pos,
          url: null,
          page: task.page,
          file: rec.file,
          error: rec.error,
          attempts: 0,
          kind: 'resolve',
        });
        return rec;
      }

      // 断点续传：只有大小和上次 meta 记录一致才算已下完
      const size = await fileSize(task.file);
      if (shouldSkipExisting(size, prevBytes.get(task.pos))) {
        rec.status = 'skipped';
        rec.bytes = size;
        skipped += 1;
        return rec;
      }

      const part = `${task.file}.part`;
      let lastErr = null;

      for (let attempt = 0; attempt <= RETRY; attempt += 1) {
        if (isCancelled()) {
          rec.status = 'cancelled';
          await fsp.rm(part, { force: true }).catch(() => {});
          return rec;
        }
        rec.attempts = attempt + 1;
        await waitForCooldown(cooldown);

        await gate.take();
        let err = null;
        try {
          const got = await fetchImage(client, task.url, task.page);
          assertComplete(got, task.pos);
          // 取消后不再落盘：半路收工就停在已经完整的那些文件上
          if (isCancelled()) {
            rec.status = 'cancelled';
            return rec;
          }
          // 先写 .part 再 rename：中途断掉不会留下一个「看着完整」的坏文件
          await fsp.writeFile(part, got.buffer);
          await fsp.rename(part, task.file);
          rec.status = 'downloaded';
          rec.bytes = got.buffer.length;
          downloaded += 1;
          return rec;
        } catch (e) {
          err = e;
          await fsp.rm(part, { force: true }).catch(() => {});
        } finally {
          gate.free();
        }

        lastErr = err;

        // 自适应降速：并发临时减半 + 全体退避，并留一条 warning 给上层
        if (isRateLimited(err)) {
          const before = gate.limit;
          const after = gate.halve();
          const backoff = Math.max(0, Number(rateLimitBackoffMs) || 0);
          cooldown.until = Math.max(cooldown.until, Date.now() + backoff);
          warn(`第 ${task.pos} 张撞上限流，并发 ${before}→${after}，退避 ${(backoff / 1000).toFixed(1)}s`);
        }

        if (attempt < RETRY) await sleep(400 * (attempt + 1)); // 线性退避
      }

      rec.error = lastErr?.message ?? String(lastErr);
      failed.push({
        index: task.pos,
        url: task.url,
        page: task.page,
        file: rec.file,
        error: rec.error,
        attempts: rec.attempts,
        kind: lastErr && lastErr.short ? 'short' : 'http',
        ...(lastErr && lastErr.short ? { expected: lastErr.expected, received: lastErr.received } : {}),
      });
      return rec;
    };

    await pool(
      tasks,
      concurrency,
      async (task) => {
        const rec = await runOne(task);
        records[task.pos - 1] = rec;
        done += 1;
        report({ ...rec, pos: task.pos });
      },
      { shouldStop: isCancelled },
    );

    const cancelled = isCancelled();
    // 被取消时把没轮到的任务也记成 cancelled：下次续传能一眼看出断在哪
    if (cancelled) {
      for (const t of tasks) {
        if (!records[t.pos - 1]) {
          records[t.pos - 1] = {
            index: t.pos,
            page: t.page,
            url: t.url,
            file: t.file ? path.basename(t.file) : null,
            bytes: 0,
            attempts: 0,
            status: 'cancelled',
          };
        }
      }
    }

    // 4) meta.json —— v2：pages[] 每张一条，status 就是最终状态
    const finishedAt = new Date().toISOString();
    const ordered = records.filter(Boolean).sort((a, b) => a.index - b.index);
    const pages = ordered.map((r) => ({
      index: r.index,
      url: r.url,
      file: r.file,
      bytes: r.bytes,
      status: r.status,
    }));

    const meta = {
      version: META_VERSION,
      gid,
      token,
      title: gallery.title ?? null,
      site: gallery.site || originOf(gallery.url) || null,
      startedAt,
      finishedAt,
      pages,
      total,
      downloaded,
      skipped,
      failed: failed.length,
      status: cancelled ? 'cancelled' : failed.length ? 'partial' : 'complete',
      warnings,
      // 兼容 v1 读取方：旧的 gallery / images 两块照旧给，只是 images 现在也带 status。
      // tags / uploader / titleJpn 一并落盘 —— 本地库搜索全靠它们，丢了就只能搜标题。
      gallery: {
        gid,
        token,
        title: gallery.title ?? null,
        titleJpn: gallery.titleJpn ?? gallery.jtitle ?? null,
        url: gallery.url ?? null,
        category: gallery.category ?? null,
        uploader: gallery.uploader ?? null,
        tags: Array.isArray(gallery.tags)
          ? gallery.tags
          : gallery.tags && typeof gallery.tags === 'object'
            ? Object.entries(gallery.tags).flatMap(([ns, vals]) => (Array.isArray(vals) ? vals.map((v) => `${ns}:${v}`) : []))
            : [],
        site: gallery.site || originOf(gallery.url) || null,
        pages: gallery.pages ?? total,
      },
      images: ordered,
    };
    await atomicWrite(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

    // 5) failed.json（有失败才写；没有就清掉旧的，免得读到过期结果）
    const failedFile = path.join(outDir, 'failed.json');
    if (failed.length) {
      await atomicWrite(failedFile, JSON.stringify(failed, null, 2) + '\n');
    } else {
      await fsp.rm(failedFile, { force: true }).catch(() => {});
    }

    return { dir: outDir, downloaded, skipped, failed, warnings, cancelled };
  } finally {
    const flag = _cancelFlags.get(String(gid));
    if (flag === cancelFlag) _cancelFlags.delete(String(gid));
  }
}

// ── archiver（归档下载，三步） ─────────────────────────────────────────────

function collapse(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取一个区块的可读文本：<br> 和 <a> 处补空格，避免相邻节点粘连。 */
function sectionText($, node) {
  if (!node || !node.length) return '';
  const clone = node.clone();
  clone.find('br').replaceWith(' ');
  clone.find('a').toArray().forEach((el) => {
    const $el = $(el);
    $el.replaceWith(` ${$el.text()} `);
  });
  return collapse(clone.text());
}

function parseCost(text) {
  // cheerio 的 .text() 会把相邻节点直接拼在一起（"42 GPArchive"），所以不加 \b
  const explicit = String(text || '').match(/(?:cost|download cost)[^\d]{0,20}(\d[\d,]*)\s*GP/i);
  const m = explicit || String(text || '').match(/(\d[\d,]*)\s*GP/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 archiver.php 第一页：费用、当前 GP、org/resample 两种链接、提示。
 * @returns {{available:boolean, cost:number|null, gp:number|null, links:{org?:string,resample?:string}, hint:string}}
 */
function parseArchiverPage(html) {
  const out = { available: false, cost: null, gp: null, links: {}, hint: '' };
  if (!html) return out;
  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return out;
  }

  const gd5 = $('#gd5');
  const text = sectionText($, gd5.length ? gd5 : $('body'));
  const bodyText = sectionText($, $('body'));
  out.hint = (text || bodyText).slice(0, 300);
  out.cost = parseCost(text || bodyText);

  const gp = bodyText.match(/GP[^\d]{0,10}(\d[\d,]*)/i) || bodyText.match(/(\d[\d,]*)\s*GP/i);
  if (gp) {
    const n = Number(gp[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.gp = n;
  }

  // 形如 /archiver.php?gid=..&token=..&or=resample 的链接
  $('a[href*="or="]').toArray().forEach((el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]or=([^&]+)/i);
    if (!m) return;
    const val = decodeURIComponent(m[1]).toLowerCase();
    const label = collapse($(el).text()).toLowerCase();
    const hit = /resam/.test(val) || /resam/.test(label) ? 'resample' : /org|orig/.test(val) || /orig/.test(label) ? 'org' : null;
    if (hit && !out.links[hit]) out.links[hit] = absUrl(href);
  });

  out.available = !!(out.links.org || out.links.resample || /archiver/i.test(bodyText));
  return out;
}

/** 解析第二步返回的表单页：action + dltype + dlcheck。 */
function parseArchiveForm(html, baseUrl) {
  const out = { action: null, dltype: null, dlcheck: null };
  if (!html) return out;
  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return out;
  }
  const form = $('form').first();
  const action = form.attr('action');
  out.action = action ? absUrl(action, baseUrl) : baseUrl || null;
  const val = (name) => {
    const el = $(`input[name="${name}"]`).first();
    return el.length ? el.attr('value') ?? '' : null;
  };
  out.dltype = val('dltype');
  out.dlcheck = val('dlcheck');
  return out;
}

/** 解析最终页：/archive/...zip 直链，或排队 / 无 H@H 客户端提示。 */
function parseArchiveFinal(html) {
  const out = { url: null, message: '' };
  if (!html) return out;
  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return out;
  }

  const anchors = $('a[href*="/archive/"]');
  const href =
    anchors.filter((_, el) => /\.(zip|rar|pdf|7z)(\?|$)/i.test($(el).attr('href') || '')).first().attr('href') ||
    anchors.first().attr('href') ||
    null;
  if (href) out.url = absUrl(href);

  const text = sectionText($, $('body'));
  if (out.url) {
    out.message = '归档已就绪，可下载';
  } else if (/no\s*h@h|no\s*hath|h@h client/i.test(text)) {
    out.message = `没有可用的 H@H 客户端，归档暂时下不了：${text.slice(0, 200)}`;
  } else if (/queue/i.test(text)) {
    out.message = `已排队：${text.slice(0, 200)}`;
  } else if (text) {
    out.message = text.slice(0, 300);
  }
  return out;
}

function detailUrlFor(gallery) {
  if (!gallery) return null;
  if (gallery.url) return gallery.url;
  if (!gallery.gid) return null;
  return `${EH_ORIGIN}/g/${gallery.gid}/${gallery.token ?? 'notoken'}/`;
}

/**
 * 读详情页 #gd5，返回归档可用性 / 花费 / archiver 链接 / 页面提示。
 * 不抛异常：拿不到就 available:false + warnings。
 */
export async function archiveInfo(client, { gallery } = {}) {
  const warnings = [];
  const detailUrl = detailUrlFor(gallery);

  // 调用方已把详情页 HTML 传来就直接用，省一次请求
  let html = gallery && (gallery.html || gallery.__html) ? gallery.html || gallery.__html : null;

  if (!html && detailUrl && client && typeof client.get === 'function') {
    try {
      const resp = await client.get(detailUrl);
      if (resp && typeof resp.text === 'string') html = resp.text;
      else warnings.push('详情页响应没有文本');
    } catch (err) {
      warnings.push(`读详情页失败: ${err?.message ?? String(err)}`);
    }
  }

  if (!html) {
    if (!detailUrl) warnings.push('缺少 gallery.url / gid，无法定位详情页');
    return { available: false, cost: null, url: gallery?.archiverUrl ?? null, hint: '', warnings };
  }

  const page = parseArchiverPage(html);
  // 详情页里的 archiver 链接（#gd5 的 a[href*=archiver.php]）
  let archiverUrl = null;
  try {
    const $ = cheerio.load(html);
    const href = $('#gd5 a[href*="archiver.php"]').first().attr('href') || $('a[href*="archiver.php"]').first().attr('href');
    if (href) archiverUrl = absUrl(href, detailUrl || EH_ORIGIN);
  } catch {
    /* 解析失败就走兜底 */
  }
  if (!archiverUrl && gallery?.archiverUrl) archiverUrl = absUrl(gallery.archiverUrl);
  if (!archiverUrl) warnings.push('#gd5 里没找到 archiver 链接');

  return {
    available: page.available || !!archiverUrl,
    cost: page.cost,
    url: archiverUrl,
    hint: page.hint,
    gp: page.gp,
    links: page.links,
    warnings,
  };
}

/**
 * 提交归档请求（三步）。⚠️ 会花 GP —— dryRun 默认 true：只走第 1 步，回报费用/可用分辨率，不提交。
 * @param {object} client
 * @param {{gallery:object, res?:'org'|'resample', dryRun?:boolean, referer?:string}} opts
 * @returns {Promise<{ok:boolean, url:string|null, message:string, cost?:number|null, archiverUrl?:string|null, dryRun?:boolean}>}
 */
export async function requestArchive(client, { gallery, res = 'resample', dryRun = true, referer } = {}) {
  const mode = res === 'org' ? 'org' : 'resample';
  const ref = referer || gallery?.url || detailUrlFor(gallery) || `${EH_ORIGIN}/`;

  // archiver 页地址：优先用 gallery 上现成的，没有就去详情页找
  let archiverUrl = gallery?.archiverUrl ? absUrl(gallery.archiverUrl) : null;
  let info = null;
  if (!archiverUrl) {
    info = await archiveInfo(client, { gallery });
    archiverUrl = info.url;
  }
  if (!archiverUrl && gallery?.gid) {
    archiverUrl = `${EH_ORIGIN}/archiver.php?gid=${encodeURIComponent(gallery.gid)}&token=${encodeURIComponent(
      gallery.token ?? '',
    )}`;
  }
  if (!archiverUrl) {
    return { ok: false, url: null, message: '拿不到 archiver 链接（缺少 gid/token，或详情页结构变了）', cost: null };
  }

  // ── 第 1 步：GET archiver 页，解析费用 / 分辨率链接 ──
  let page1 = { available: false, cost: null, gp: null, links: {}, hint: '' };
  if (typeof client?.get === 'function') {
    const r1 = await client.get(archiverUrl, { referer: ref });
    if (r1 && typeof r1.text === 'string') page1 = parseArchiverPage(r1.text);
  }
  const cost = page1.cost ?? (info && info.cost) ?? null;
  const hint = page1.hint || (info && info.hint) || '';

  if (dryRun) {
    const modes = Object.keys(page1.links || {});
    return {
      ok: false,
      url: null,
      dryRun: true,
      archiverUrl,
      cost,
      gp: page1.gp,
      resolutions: modes.length ? modes : ['org', 'resample'],
      message:
        `dry-run：未提交（不消耗 GP）。将 POST ${archiverUrl} · hathdl_xres=${mode}` +
        (cost != null ? ` · 预估 ${cost} GP` : '') +
        (hint ? ` · ${hint}` : ''),
    };
  }

  if (!client || typeof client.post !== 'function') throw new Error('requestArchive: client 缺少 post()');

  // ── 第 2 步：POST hathdl_xres → 拿表单页（dltype / dlcheck） ──
  const step2Url = page1.links[mode] || archiverUrl;
  const r2 = await client.post(step2Url, {
    form: { hathdl_xres: mode },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    referer: archiverUrl,
  });
  const form = parseArchiveForm(r2 && r2.text, (r2 && r2.finalUrl) || step2Url);

  let final = null;
  let finalUrl = null;
  if (form.dltype || form.dlcheck) {
    // ── 第 3 步：带 dltype/dlcheck POST 到表单 action → 直链 ──
    const r3 = await client.post(form.action || step2Url, {
      form: { dltype: form.dltype ?? '', dlcheck: form.dlcheck ?? '' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      referer: (r2 && r2.finalUrl) || step2Url,
    });
    final = parseArchiveFinal(r3 && r3.text);
    finalUrl = (r3 && r3.finalUrl) || null;
  } else {
    // 有些情况下第二步就直接给了链接 / 排队提示
    final = parseArchiveFinal(r2 && r2.text);
    finalUrl = (r2 && r2.finalUrl) || null;
  }

  const ok = !!final.url || /queue|已排队/i.test(final.message || '');
  return {
    ok,
    url: final.url,
    message: final.message || (ok ? '归档请求已提交' : '归档页返回了未知结构'),
    cost,
    archiverUrl,
    finalUrl,
    dryRun: false,
    steps: { archiver: archiverUrl, post: step2Url, form: form.action },
  };
}

// ── 自检（不联网） ─────────────────────────────────────────────────────────

export async function __selftest() {
  const os = await import('node:os');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-dl-'));
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });

  try {
    ok('extFromUrl jpg', extFromUrl('https://x/i/123.jpg?q=1') === 'jpg');
    ok('extFromUrl png', extFromUrl('https://x/i/123.PNG') === 'png');
    ok('extFromUrl 无扩展名回落 jpg', extFromUrl('https://x/img') === 'jpg');
    ok('imageFileName 补零', imageFileName(7, 'webp') === '007.webp');

    // 假 client + 假 pages：2 张成功、1 张永远 403、1 张解析失败
    const pages = [
      { index: 1, url: 'https://e-hentai.org/s/aaa/1-1' },
      { index: 2, url: 'https://e-hentai.org/s/bbb/1-2' },
      { index: 3, url: 'https://e-hentai.org/s/ccc/1-3' },
      { index: 4, url: 'https://e-hentai.org/s/ddd/1-4' },
    ];
    const refs = [];
    const client = {
      async getBinary(url, opts) {
        refs.push(opts && opts.referer);
        if (url.includes('bad')) throw new Error('403 Forbidden');
        return { status: 200, buffer: Buffer.from(`IMG:${url}`) };
      },
      async get(url) {
        return { status: 200, text: '<html></html>', finalUrl: url };
      },
    };
    const _deps = {
      listPages: async () => pages,
      resolveImage: async (c, pageUrl) => {
        if (pageUrl.includes('/ddd/')) throw new Error('image page 结构缺失');
        const n = pageUrl.slice(-1);
        return {
          index: Number(n),
          url: pageUrl.includes('/ccc/') ? 'https://img.example/bad.jpg' : `https://img.example/${n}.jpg`,
          warnings: [],
        };
      },
    };

    const r1 = await downloadGallery({ client, gallery: { gid: 42, token: 'tok' }, dir: tmp, concurrency: 2, _deps });
    ok('下载成功 2 张', r1.downloaded === 2, { got: r1.downloaded });
    ok('失败 2 条', r1.failed.length === 2, { failed: r1.failed });
    ok('Referer 是图片页 URL', refs.every((x) => typeof x === 'string' && x.includes('/s/')), { refs });

    const files = (await fsp.readdir(r1.dir)).sort();
    ok('文件命名 001/002', files.includes('001.jpg') && files.includes('002.jpg'), { files });
    const meta = JSON.parse(await fsp.readFile(path.join(r1.dir, 'meta.json'), 'utf8'));
    ok('meta.status=partial', meta.status === 'partial');
    ok('meta.images 四条', meta.images.length === 4);
    ok('meta 记录每张 url', meta.images.every((x) => 'url' in x && 'index' in x));
    ok('meta.version=2', meta.version === 2, { version: meta.version });
    ok(
      'meta.pages 四条带 status',
      Array.isArray(meta.pages) && meta.pages.length === 4 && meta.pages.every((p) => typeof p.status === 'string'),
      { pages: meta.pages && meta.pages.length },
    );
    ok('normalizeMeta 读 v1', (() => {
      const v2 = normalizeMeta({
        gallery: { gid: 7, token: 't', title: 'old', url: 'https://e-hentai.org/g/7/t/' },
        images: [{ index: 1, url: 'u1', file: '001.jpg', bytes: 10 }],
      });
      return v2 && v2.version === 2 && v2.fromVersion === 1 && v2.pages.length === 1 && v2.pages[0].bytes === 10;
    })());

    const r2 = await downloadGallery({ client, gallery: { gid: 42, token: 'tok' }, dir: tmp, concurrency: 2, _deps });
    ok('续传跳过 2 张', r2.skipped === 2, { got: r2.skipped });
    ok('续传不重复下载', r2.downloaded === 0);

    // archiver 三步（mock）
    const archHtml = `<div id="gd5"><p>Download Cost: 42 GP</p>
      <a href="/archiver.php?gid=42&token=tok&or=org">Original</a>
      <a href="/archiver.php?gid=42&token=tok&or=resample">Resample</a></div>`;
    const formHtml = `<form action="/archiver.php?gid=42&token=tok&or=resample" method="post">
      <input type="hidden" name="dltype" value="res"><input type="hidden" name="dlcheck" value="abc"></form>`;
    const finalHtml = `<p>ready</p><a href="/archive/42-tok.zip">Download</a>`;
    let posts = 0;
    const aclient = {
      get: async (u) => ({ status: 200, text: archHtml, finalUrl: u }),
      post: async (u, o) => {
        posts += 1;
        return { status: 200, text: posts === 1 ? formHtml : finalHtml, finalUrl: u };
      },
    };

    const dry = await requestArchive(aclient, { gallery: { gid: 42, token: 'tok' } });
    ok('dryRun 不 POST', posts === 0 && dry.dryRun === true);
    ok('dryRun 报费用', dry.cost === 42, { cost: dry.cost });
    ok('dryRun 报可用分辨率', Array.isArray(dry.resolutions) && dry.resolutions.includes('resample'), { r: dry.resolutions });

    const real = await requestArchive(aclient, { gallery: { gid: 42, token: 'tok' }, res: 'resample', dryRun: false });
    ok('三步走完 POST 两次', posts === 2, { posts });
    ok('解析出归档直链', real.ok === true && real.url === `${EH_ORIGIN}/archive/42-tok.zip`, { real });
  } catch (err) {
    checks.push({ name: 'selftest 异常', ok: false, extra: { message: err?.message ?? String(err) } });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/* ------------------------------------------------------------------ */
/* 目录对账：老版本、换账号、手滑传错 dir 的旧目录都收编到目标位置         */
/* ------------------------------------------------------------------ */

/** `~` / 相对路径统一成绝对路径（不建目录） */
function absDir(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    const os = require_homedir();
    return path.resolve(String(os), raw.slice(2));
  }
  return path.resolve(raw);
}

function require_homedir() {
  // 延迟拿，避免顶部再多一个 import（这个模块是热路径，但只在对账时用）
  try {
    return process.env.USERPROFILE || process.env.HOME || '.';
  } catch {
    return '.';
  }
}

/**
 * 把调用方给的 `dir` 归一成「根目录 + 这本的目录」。
 * 传根目录 → root=<dir>, outDir=<dir>/<gid>-<token>；
 * 传的已经是这本的目录（结尾就是 `<gid>-<token>`）→ 就地下在这，不再套一层。
 * @returns {{root:string, outDir:string, wasGalleryDir:boolean}}
 */
export function normalizeGalleryTarget({ dir, gid, token }) {
  const base = absDir(dir || path.join(process.cwd(), 'downloads'));
  const name = `${gid}-${token || 'notoken'}`;
  const tail = path.basename(base);
  if (tail === name) return { root: path.dirname(base), outDir: base, wasGalleryDir: true };
  return { root: base, outDir: path.join(base, name), wasGalleryDir: false };
}

/** 在若干搜索根下找同名画廊目录：根本身、下一层、两层（不含 target 本身） */
async function findSiblingGalleryDirs(roots, name, target) {
  const out = [];
  const push = (p) => {
    if (path.resolve(p) === path.resolve(target)) return;
    if (!out.includes(p)) out.push(p);
  };
  const isDir = async (p) => {
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch {
      return false;
    }
  };
  for (const root of roots) {
    if (!root) continue;
    if (await isDir(path.join(root, name))) push(path.join(root, name));
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(root, e.name);
      if (await isDir(path.join(sub, name))) push(path.join(sub, name));
    }
  }
  return out;
}

/**
 * 把别处的同名目录收编到 `<root>/<gid>-<token>`。
 * - 目标不存在：整目录 rename（同盘，快且原子）
 * - 目标已存在：把老目录里目标没有的文件搬过去，然后清掉空壳
 * 失败只回 warning，不阻断下载。
 * @returns {Promise<{outDir:string, movedFrom?:string, mergedFrom?:string[], warnings:string[]}>}
 */
export async function adoptExistingGalleryDir({ root, gid, token, searchRoots = [] }) {
  const warnings = [];
  const name = `${gid}-${token || 'notoken'}`;
  const target = path.join(root, name);
  const roots = [...new Set([root, ...searchRoots.map((r) => (r ? path.resolve(String(r)) : '')).filter(Boolean)])];
  const siblings = await findSiblingGalleryDirs(roots, name, target);
  if (!siblings.length) return { outDir: target, warnings };

  const targetExists = await (async () => {
    try {
      return (await fsp.stat(target)).isDirectory();
    } catch {
      return false;
    }
  })();

  if (!targetExists) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.rename(siblings[0], target);
      warnings.push(`旧目录已迁到 ${target}（原 ${siblings[0]}）`);
      return { outDir: target, movedFrom: siblings[0], warnings };
    } catch (err) {
      warnings.push(`旧目录迁移失败（${err?.code || err?.message}），这次仍写在原位置`);
      return { outDir: siblings[0], movedFrom: null, warnings };
    }
  }

  // 两边都在：把老目录里缺的文件补进来（不删老目录里的东西，宁可多留）
  const merged = [];
  for (const from of siblings) {
    let files = [];
    try {
      files = await fsp.readdir(from, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      const src = path.join(from, f.name);
      const dst = path.join(target, f.name);
      try {
        const [a1, a2] = await Promise.all([fsp.stat(dst), fsp.stat(src)]);
        // 目标已有：同名同大小当重复，删掉老的那份；大小不同就都留着，宁可多占点
        if (a1.size === a2.size) await fsp.rm(src, { force: true });
        else warnings.push(`${f.name} 两边大小不同，保留两份`);
        continue;
      } catch { /* 不存在才搬 */ }
      try {
        await fsp.rename(src, dst);
        merged.push(f.name);
      } catch { /* 单个文件失败就算了 */ }
    }
    // 搬空了就把空壳删掉
    try {
      const left = await fsp.readdir(from);
      if (!left.length) await fsp.rmdir(from);
    } catch { /* ignore */ }
  }
  if (merged.length) warnings.push(`合并了 ${merged.length} 个文件（来自 ${siblings.join(', ')}）`);
  return { outDir: target, mergedFrom: siblings, warnings };
}
