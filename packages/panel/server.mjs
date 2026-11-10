#!/usr/bin/env node
/**
 * DSH-EH 本地面板 —— 只读的本地浏览服务。
 *
 * 只依赖 Node 内置模块。读 ~/.dsh-eh 下的 history.jsonl / notes.json /
 * library.json，图片从下载根目录流式读出。只绑 127.0.0.1。
 *
 * 用法：
 *   node panel/server.mjs [--port 7712] [--data <dir>] [--root <下载根>]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as online from './online.mjs';
import { getLocalImage } from './fetch-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOME = os.homedir();
const DEFAULT_DATA = path.join(HOME, '.dsh-eh');
const DEFAULT_ROOT = path.join(HOME, '.dsh', 'eh-downloads');

function getArg(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const pref = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(DEFAULT_DATA, 'config.json'), 'utf8'));
} catch {
  config = {};
}

// 宿主插件会用 DSH_EH_PORT 传端口；命令行 --port 优先。默认仍以 7712 为首选。
const START_PORT = Number(getArg('port') ?? process.env.DSH_EH_PORT ?? 7712) || 7712;
const DATA_DIR = path.resolve(getArg('data') ?? config.dataDir ?? DEFAULT_DATA);
const ROOT = path.resolve(getArg('root') ?? config.downloadDir ?? DEFAULT_ROOT);

const STARTED_AT = new Date().toISOString();
const OWNER = process.env.DSH_EH_OWNER || '';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PID_FILE = path.join(DEFAULT_DATA, 'panel.pid');

const IMG_EXT = new Set(['.webp', '.jpg', '.jpeg', '.png', '.gif']);
const IMG_MIME = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- utilities

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function etagMatches(header, etag) {
  if (!header) return false;
  return String(header)
    .split(',')
    .some((v) => v.trim().replace(/^W\//, '') === etag);
}

function compressibleType(type) {
  return /^(text\/|application\/json\b|text\/javascript\b|image\/svg\+xml\b)/i.test(String(type || ''));
}

/** 统一发送文本/JSON：>1KB 且客户端接受 gzip 时压缩，并带 Vary。 */
function sendBody(req, res, status, body, type, headers = {}) {
  const h = { ...headers, 'Content-Type': type };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let out = buf;
  const canZip = buf.length > 1024 && compressibleType(type);
  if (canZip) {
    h.Vary = h.Vary ? `${h.Vary}, Accept-Encoding` : 'Accept-Encoding';
    if (/\bgzip\b/i.test(String((req && req.headers && req.headers['accept-encoding']) || ''))) {
      out = zlib.gzipSync(buf);
      h['Content-Encoding'] = 'gzip';
    }
  }
  h['Content-Length'] = out.length;
  res.writeHead(status, h);
  if (req && req.method === 'HEAD') return res.end();
  if (res.destroyed) return;
  res.end(out);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  sendBody(res.req, res, status, body, 'application/json; charset=utf-8', {
    'Cache-Control': 'no-store',
  });
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- data files

let historyCache = { key: '', items: [] };

async function loadHistory() {
  const file = path.join(DATA_DIR, 'history.jsonl');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return [];
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (historyCache.key === key) return historyCache.items;

  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) items.push(obj);
    } catch {
      // 半行/坏行直接跳过，不拖垮整个列表
    }
  }
  items.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  historyCache = { key, items };
  return items;
}

let notesCache = { key: '', data: { version: 0, updatedAt: null, items: {} } };

async function loadNotes() {
  const file = path.join(DATA_DIR, 'notes.json');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { version: 0, updatedAt: null, items: {} };
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (notesCache.key === key) return notesCache.data;

  const raw = await readJsonFile(file);
  const data = raw && typeof raw === 'object' ? raw : { items: {} };
  if (!data.items || typeof data.items !== 'object' || Array.isArray(data.items)) data.items = {};
  notesCache = { key, data };
  return data;
}

let libCache = { key: '', data: null };

async function loadLibrary() {
  const file = path.join(DATA_DIR, 'library.json');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (libCache.key === key) return libCache.data;

  const raw = await readJsonFile(file);
  const data = raw && Array.isArray(raw.entries) ? raw : null;
  libCache = { key, data };
  return data;
}

let commentsCache = { key: '', data: null };

async function loadComments() {
  const file = path.join(DATA_DIR, 'comments.json');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (commentsCache.key === key) return commentsCache.data;

  const raw = await readJsonFile(file);
  const data =
    raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw : null;
  commentsCache = { key, data };
  return data;
}

function commentCountOf(entry) {
  if (!entry) return 0;
  if (Number.isFinite(Number(entry.count))) return Number(entry.count);
  return Array.isArray(entry.comments) ? entry.comments.length : 0;
}

// ------------------------------------------------------------- local library

const dirCache = new Map(); // dir -> { mtime, info }

async function describeDir(dir) {
  if (!dir) return null;
  let st;
  try {
    st = await fsp.stat(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;

  const cached = dirCache.get(dir);
  if (cached && cached.mtime === st.mtimeMs) return cached.info;

  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const names = ents
    .filter((e) => e.isFile() && IMG_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const files = names.map((n) => path.join(dir, n));

  let meta = null;
  if (ents.some((e) => e.isFile() && e.name.toLowerCase() === 'meta.json')) {
    meta = await readJsonFile(path.join(dir, 'meta.json'));
  }

  let pages = files.length;
  let sizeBytes = 0;
  let title = null;
  let titleJpn = null;
  if (meta && typeof meta === 'object') {
    const g = meta.gallery && typeof meta.gallery === 'object' ? meta.gallery : {};
    title = g.title || meta.title || null;
    titleJpn = g.titleJpn || meta.titleJpn || null;
    if (Array.isArray(meta.pages)) {
      for (const p of meta.pages) {
        if (p && Number.isFinite(p.bytes)) sizeBytes += p.bytes;
      }
      if (pages === 0) pages = meta.pages.length;
    }
    if (!pages && Number.isFinite(g.pages)) pages = g.pages;
  }

  const info = { dir, pages, files, sizeBytes, title, titleJpn };
  dirCache.set(dir, { mtime: st.mtimeMs, info });
  return info;
}

let localIndexCache = { at: 0, map: new Map() };

async function getLocalIndex() {
  if (Date.now() - localIndexCache.at < 5000) return localIndexCache.map;

  const map = new Map();
  async function walk(dir, depth) {
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const m = /^(\d+)-([0-9a-zA-Z]+)$/.exec(e.name);
      const full = path.join(dir, e.name);
      if (m) map.set(m[1], { dir: full, token: m[2] });
      else if (depth < 2) await walk(full, depth + 1);
    }
  }
  await walk(ROOT, 0);

  localIndexCache = { at: Date.now(), map };
  return map;
}

async function resolveLocal(gid, token) {
  const key = String(gid);
  const idx = await getLocalIndex();
  const hit = idx.get(key);
  if (hit) {
    const info = await describeDir(hit.dir);
    if (info && info.files.length) return info;
  }

  const lib = await loadLibrary();
  if (lib) {
    for (const e of lib.entries) {
      if (String(e.gid) !== key || !e.dir) continue;
      const info = await describeDir(e.dir);
      if (info) {
        return {
          ...info,
          sizeBytes: info.sizeBytes || Number(e.sizeBytes) || 0,
          title: info.title || e.title || null,
          titleJpn: info.titleJpn || e.titleJpn || null,
        };
      }
    }
  }

  const hist = (await loadHistory()).filter(
    (h) => h.type === 'download' && String(h.gid) === key && h.dir,
  );
  const dirs = [...new Set(hist.map((h) => path.resolve(h.dir)))];
  for (const d of dirs) {
    if (path.basename(d).startsWith(`${key}-`)) {
      const info = await describeDir(d);
      if (info && info.files.length) return info;
    }
    const direct = await describeDir(d);
    if (direct && direct.files.length) return direct;
    let ents = [];
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      ents = [];
    }
    const child = ents.find((e) => e.isDirectory() && e.name.startsWith(`${key}-`));
    if (child) {
      const info = await describeDir(path.join(d, child.name));
      if (info && info.files.length) return info;
    }
  }
  return null;
}

async function resolveDownloadDir(gid, token) {
  const key = String(gid);
  const hist = (await loadHistory()).filter(
    (h) => h.type === 'download' && String(h.gid) === key && h.dir,
  );
  for (const h of hist) {
    let d;
    try {
      d = path.resolve(h.dir);
    } catch {
      continue;
    }
    const tok = token || h.token;
    if (path.basename(d) === `${key}-${tok}`) return d;
    const child = path.join(d, `${key}-${tok}`);
    const childInfo = await describeDir(child);
    if (childInfo && childInfo.files.length) return child;
    const ownInfo = await describeDir(d);
    if (ownInfo && ownInfo.files.length) return d;
  }
  const local = await resolveLocal(key, token);
  return local ? local.dir : undefined;
}

async function enrichHistoryItem(it, noteMap, localMap, commentMap) {
  const key = String(it.gid);
  const out = { ...it, hasNote: noteMap.has(key) };
  const commentEntry = commentMap ? commentMap.get(key) : null;
  out.commentCount = commentCountOf(commentEntry);
  let info = localMap.get(key);
  if (info === undefined) {
    info = await resolveLocal(it.gid, it.token);
    localMap.set(key, info);
  }
  if (info) {
    out.thumb = info.files[0] || null;
    out.localDir = info.dir;
    if (it.type === 'download') {
      out.title = it.title || info.title || null;
      out.titleJpn = it.titleJpn || info.titleJpn || null;
      out.pages = it.pages ?? info.pages;
      out.sizeBytes = info.sizeBytes || 0;
      out.dirResolved = info.dir;
      out.fileCount = info.files.length;
    }
  } else if (it.type === 'download') {
    out.sizeBytes = 0;
    out.fileCount = 0;
  }
  return out;
}

// ---------------------------------------------------------------- API routes

async function apiSummary(req, res) {
  const [history, notes, lib] = await Promise.all([loadHistory(), loadNotes(), loadLibrary()]);
  const counts = {
    view: 0,
    download: 0,
    search: 0,
    notes: Object.keys(notes.items).length,
    library: lib ? lib.entries.length : 0,
  };
  for (const h of history) {
    if (h.type === 'view' || h.type === 'download' || h.type === 'search') counts[h.type] += 1;
  }
  const lastViewAt = history.find((h) => h.type === 'view')?.at || null;
  sendJson(res, 200, {
    counts,
    lastViewAt,
    notesUpdatedAt: notes.updatedAt || null,
    root: ROOT,
  });
}

async function apiHistory(req, res, u) {
  const type = u.searchParams.get('type');
  const limit = clampInt(u.searchParams.get('limit'), 50, 1, 500);
  const offset = Math.max(0, Number.parseInt(u.searchParams.get('offset') ?? '0', 10) || 0);
  const q = (u.searchParams.get('q') || '').trim().toLowerCase();

  let items = await loadHistory();
  if (type) items = items.filter((h) => h.type === type);
  if (q) {
    items = items.filter((h) =>
      [h.title, h.jtitle, h.url, h.gid, h.token].some(
        (v) => v != null && String(v).toLowerCase().includes(q),
      ),
    );
  }

  const total = items.length;
  const page = items.slice(offset, offset + limit);
  const [notes, commentsDoc] = await Promise.all([loadNotes(), loadComments()]);
  const noteMap = new Map(Object.entries(notes.items));
  const commentMap = new Map(Object.entries((commentsDoc && commentsDoc.items) || {}));
  const localMap = new Map();

  const enriched = [];
  for (const it of page) {
    enriched.push(await enrichHistoryItem(it, noteMap, localMap, commentMap));
  }

  sendJson(res, 200, { items: enriched, total, hasMore: offset + enriched.length < total });
}

async function apiNotes(req, res, u) {
  const limit = clampInt(u.searchParams.get('limit'), 100, 1, 500);
  const offset = Math.max(0, Number.parseInt(u.searchParams.get('offset') ?? '0', 10) || 0);
  const q = (u.searchParams.get('q') || '').trim().toLowerCase();

  const notes = await loadNotes();
  let items = Object.entries(notes.items).map(([gid, v]) => ({
    ...(v && typeof v === 'object' ? v : {}),
    gid: v?.gid ?? (/^\d+$/.test(gid) ? Number(gid) : gid),
  }));
  items.sort(
    (a, b) => (Date.parse(b.updatedAt || b.at) || 0) - (Date.parse(a.updatedAt || a.at) || 0),
  );
  if (q) {
    items = items.filter((n) =>
      [n.title, n.note, n.gid, n.token, n.url].some(
        (v) => v != null && String(v).toLowerCase().includes(q),
      ),
    );
  }
  const total = items.length;
  sendJson(res, 200, {
    items: items.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  });
}

async function apiLibrary(req, res, u) {
  const limit = clampInt(u.searchParams.get('limit'), 100, 1, 1000);
  const offset = Math.max(0, Number.parseInt(u.searchParams.get('offset') ?? '0', 10) || 0);
  const q = (u.searchParams.get('q') || '').trim().toLowerCase();

  const lib = await loadLibrary();
  if (!lib) {
    sendJson(res, 200, { items: [], total: 0, warn: '还没有本地库索引' });
    return;
  }

  let items = lib.entries.map((e) => ({
    gid: e.gid,
    token: e.token,
    title: e.title || null,
    titleJpn: e.titleJpn || null,
    pages: e.pages ?? null,
    tags: Array.isArray(e.tags) ? e.tags : [],
    dir: e.dir || null,
    sizeBytes: Number(e.sizeBytes) || 0,
    downloadedAt: e.downloadedAt || null,
  }));
  if (q) {
    items = items.filter((e) =>
      [e.title, e.titleJpn, e.gid, ...(e.tags || [])].some(
        (v) => v != null && String(v).toLowerCase().includes(q),
      ),
    );
  }
  const total = items.length;
  sendJson(res, 200, {
    items: items.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  });
}

const galleryLiveCache = new Map(); // gid -> {at, data}  TTL 5min

/** 详情页只从本地数据拼不出 token/标题时，补一次在线详情（有缓存，失败不阻断） */
async function fetchLiveGallery(gid, token) {
  const key = String(gid);
  const hit = galleryLiveCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  try {
    const cfg = await import('dsh-ehviewer/config');
    const http = await import('dsh-ehviewer/http');
    const browse = await import('dsh-ehviewer/browse');
    const gallery = await import('dsh-ehviewer/gallery');
    const conf = await cfg.loadConfig();
    const client = http.createClient ? await http.createClient(conf) : null;
    if (!client) return null;
    const base = gallery.resolveBase(conf, 'https://exhentai.org');
    const r = await browse.galleryDetail(client, { base, gid: Number(gid), token });
    const d = r && r.detail ? r.detail : null;
    if (!d) return null;
    const data = {
      token: d.token || token || null,
      title: d.title || null,
      titleJpn: d.jtitle || null,
      pages: d.pages ?? null,
      category: d.category || null,
      uploader: d.uploader || null,
      rating: d.rating ?? null,
      site: r.site || null,
      url: d.url || null,
    };
    galleryLiveCache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

async function apiGallery(req, res, gidRaw, url) {
  const gid = decodeURIComponent(gidRaw);
  if (!/^\d+$/.test(gid)) {
    sendJson(res, 400, { error: 'gid 必须是数字' });
    return;
  }

  const [history, notes, commentsDoc] = await Promise.all([
    loadHistory(),
    loadNotes(),
    loadComments(),
  ]);
  const rawHist = history.filter((h) => String(h.gid) === gid);
  const commentEntry = (commentsDoc && commentsDoc.items && commentsDoc.items[gid]) || null;
  const comments = commentEntry
    ? {
        count: commentCountOf(commentEntry),
        at: commentEntry.at || null,
        items: Array.isArray(commentEntry.comments) ? commentEntry.comments : [],
      }
    : null;
  const note = notes.items[gid] || null;
  const qToken = (url && (url.searchParams.get('token') || url.searchParams.get('t'))) || null;
  let token = qToken || rawHist.find((h) => h.token)?.token || note?.token || null;
  const local = await resolveLocal(gid, token);
  const download = await resolveDownloadDir(gid, token);
  const titled = rawHist.find((h) => h.title);
  let title = local?.title || titled?.title || titled?.jtitle || note?.title || null;

  // 从搜索结果/详情链接点进来时，本地可能一条记录都没有：补一次在线详情
  let live = null;
  if ((!title || !token || !local) && token) {
    live = await fetchLiveGallery(gid, token);
    if (live) {
      token = token || live.token;
      title = title || live.title;
    }
  }

  const hist = rawHist.map((h) => {
    const out = { ...h, hasNote: !!note };
    if (local && local.files.length) {
      out.thumb = local.files[0];
      out.localDir = local.dir;
      if (h.type === 'download') {
        out.title = out.title || local.title || null;
        out.titleJpn = out.titleJpn || local.titleJpn || null;
        out.pages = out.pages ?? local.pages;
        out.sizeBytes = local.sizeBytes || 0;
        out.fileCount = local.files.length;
        out.dirResolved = local.dir;
      }
    }
    return out;
  });

  sendJson(res, 200, {
    gid: Number(gid),
    token,
    title,
    history: hist,
    note,
    comments,
    local: local
      ? {
          dir: local.dir,
          pages: local.pages,
          files: local.files,
          sizeBytes: local.sizeBytes,
          title: local.title,
        }
      : null,
    download,
    online: live
      ? {
          title: live.title,
          titleJpn: live.titleJpn,
          pages: live.pages,
          category: live.category,
          uploader: live.uploader,
          rating: live.rating,
          site: live.site,
          url: live.url,
        }
      : null,
  });
}

// ------------------------------------------------------------------ online

async function apiOnline(req, res, u, pathname) {
  const pagesMatch = /^\/api\/online\/pages\/(\d+)\/([0-9a-zA-Z]+)$/.exec(pathname);
  if (pagesMatch) {
    const from = clampInt(u.searchParams.get('from'), 1, 1, 100000);
    const toRaw = u.searchParams.get('to');
    const to = toRaw == null ? null : clampInt(toRaw, from, from, from + 19);
    try {
      const data = await online.listWindow({
        gid: pagesMatch[1],
        token: pagesMatch[2],
        from,
        to,
      });
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 502, { error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  const imgMatch = /^\/api\/online\/img\/(\d+)\/([0-9a-zA-Z]+)\/(\d+)$/.exec(pathname);
  if (imgMatch) {
    try {
      const img = await online.getImage({
        gid: imgMatch[1],
        token: imgMatch[2],
        index: Number(imgMatch[3]),
      });
      res.writeHead(200, {
        'Content-Type': img.mimeType || 'image/jpeg',
        'Content-Length': img.buffer.length,
        'Cache-Control': 'private, max-age=600',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(img.buffer);
    } catch (err) {
      sendJson(res, 502, { error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  sendJson(res, 404, { error: '未知在线接口' });
}

// ------------------------------------------------------------------- images

async function handleImg(req, res, u) {
  const raw = u.searchParams.get('path');
  if (!raw) {
    sendJson(res, 400, { error: '缺少 path 参数' });
    return;
  }

  const abs = path.resolve(raw);
  const ext = path.extname(abs).toLowerCase();
  if (!IMG_EXT.has(ext)) {
    sendJson(res, 403, { error: '只允许图片文件（webp/jpg/jpeg/png/gif）' });
    return;
  }
  if (!isInside(ROOT, abs)) {
    sendJson(res, 403, { error: '路径超出下载根目录' });
    return;
  }

  let realRoot;
  let real;
  try {
    realRoot = await fsp.realpath(ROOT);
  } catch {
    realRoot = path.resolve(ROOT);
  }
  try {
    real = await fsp.realpath(abs);
  } catch {
    sendJson(res, 404, { error: '文件不存在' });
    return;
  }
  if (!isInside(realRoot, real)) {
    sendJson(res, 403, { error: '路径超出下载根目录' });
    return;
  }

  let st;
  try {
    st = await fsp.stat(real);
  } catch {
    sendJson(res, 404, { error: '文件不存在' });
    return;
  }
  if (!st.isFile()) {
    sendJson(res, 404, { error: '不是文件' });
    return;
  }

  const rawW = u.searchParams.get('w');
  const width = rawW === '0' || rawW === 'none' ? 0 : clampInt(rawW, 400, 64, 2000);
  const want = u.searchParams.get('want') === 'original' ? 'original' : 'webp';

  let out;
  try {
    out = await getLocalImage({ file: real, width, want });
  } catch (err) {
    if (err && err.status === 404) sendJson(res, 404, { error: '文件不存在' });
    else sendJson(res, 500, { error: `读取图片失败：${(err && err.message) || err}` });
    return;
  }

  const etag = `"${out.etag}"`;
  const headers = {
    'Content-Type': out.mime,
    'Cache-Control': 'private, max-age=604800, immutable',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'X-Cache': out.cached ? 'hit' : 'miss',
    'X-Resized': out.resized ? '1' : '0',
    'X-Resize-Backend': out.backend || 'none',
  };

  // 客户端断开时不要冒未捕获异常。
  res.on('close', () => {
    if (!res.writableEnded) {
      /* 连接已断，静默丢弃 */
    }
  });

  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = out.buffer.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  if (res.destroyed) return;
  try {
    res.end(out.buffer);
  } catch {
    if (!res.destroyed) res.destroy();
  }
}

// ------------------------------------------------------------------- static

async function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  let rel = pathname.replace(/^\/+/, '');
  let file = path.resolve(PUBLIC_DIR, rel || 'index.html');
  if (!isInside(PUBLIC_DIR, file)) file = path.join(PUBLIC_DIR, 'index.html');

  let st = null;
  try {
    st = await fsp.stat(file);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) {
    file = path.join(PUBLIC_DIR, 'index.html');
    try {
      st = await fsp.stat(file);
    } catch {
      sendJson(res, 500, { error: 'panel/public/index.html 缺失' });
      return;
    }
  }

  const ext = path.extname(file).toLowerCase();
  const type = STATIC_MIME[ext] || 'application/octet-stream';
  // 静态资源统一协商缓存：每次都问一次，ETag 不变回 304，避免前端刷新拿到旧文件。
  const cacheControl = 'no-cache';
  const etag = `"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;

  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
    res.end();
    return;
  }

  let body;
  try {
    body = await fsp.readFile(file);
  } catch {
    sendJson(res, 500, { error: '静态文件读取失败' });
    return;
  }

  sendBody(req, res, 200, body, type, {
    ETag: etag,
    'Cache-Control': cacheControl,
  });
}

// ------------------------------------------------------------------ handler

const serverHandler = async (req, res) => {
  try {
    const url0 = new URL(req.url || '/', 'http://127.0.0.1');
    const writeRoute = url0.pathname.startsWith('/api/settings');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(writeRoute && req.method === 'POST')) {
      sendJson(res, 405, { error: '只支持 GET（/api/settings 额外支持 POST）' });
      return;
    }
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const p = u.pathname;

    if (p === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        port: serverPort,
        startedAt: STARTED_AT,
        owner: OWNER,
        script: SCRIPT_PATH,
        node: process.version,
        root: ROOT,
      });
      return;
    }
    if (p === '/api/summary') return await apiSummary(req, res);
    if (p === '/api/history') return await apiHistory(req, res, u);
    if (p === '/api/notes') return await apiNotes(req, res, u);
    if (p === '/api/library') return await apiLibrary(req, res, u);
    if (p.startsWith('/api/online/')) return await apiOnline(req, res, u, p);
    if (p.startsWith('/api/browse')) {
      const browse = await import('./browse-api.mjs');
      return await browse.handle(req, res, u, p);
    }
    if (p.startsWith('/api/settings')) {
      const st = await import('./settings-api.mjs');
      return await st.handle(req, res, u, p);
    }
    if (p.startsWith('/api/gallery/')) {
      return await apiGallery(req, res, p.slice('/api/gallery/'.length), u);
    }
    if (p === '/img') return await handleImg(req, res, u);
    if (p.startsWith('/api/')) {
      sendJson(res, 404, { error: '未知接口' });
      return;
    }
    return await serveStatic(req, res, p);
  } catch (err) {
    try {
      sendJson(res, 500, {
        error: '服务器内部错误',
        detail: String(err && err.message ? err.message : err),
      });
    } catch {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
};

let serverPort = START_PORT;

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(serverHandler);
    const onError = (err) => {
      s.removeListener('listening', onListening);
      try {
        s.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const onListening = () => {
      s.removeListener('error', onError);
      resolve(s);
    };
    s.once('error', onError);
    s.once('listening', onListening);
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  let server = null;
  let port = START_PORT;
  for (let i = 0; i <= 10; i += 1) {
    port = START_PORT + i;
    try {
      server = await tryListen(port);
      break;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  if (!server) {
    console.error(`没有可用端口：${START_PORT}..${START_PORT + 10} 全被占用`);
    process.exit(1);
  }

  serverPort = port;
  try {
    fs.mkdirSync(DEFAULT_DATA, { recursive: true });
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid, port, startedAt: STARTED_AT, owner: OWNER, script: SCRIPT_PATH,
    }, null, 2));
  } catch { /* pid 文件只是给宿主看的，写不了不影响服务 */ }
  console.log(`DSH-EH 面板已启动: http://127.0.0.1:${port}/`);
  // 退出时清掉自己的 pid 文件（别人的 pid 文件不动）
  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      if (cur.pid === process.pid) fs.rmSync(PID_FILE, { force: true });
    } catch { /* ignore */ }
  };
  process.once('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    try {
      process.once(sig, () => { cleanup(); process.exit(0); });
    } catch { /* ignore */ }
  }
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  下载根目录: ${ROOT}`);
  if (!fs.existsSync(path.join(DATA_DIR, 'library.json'))) {
    console.log('  (library.json 不存在，本地库视图会返回空)');
  }

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
