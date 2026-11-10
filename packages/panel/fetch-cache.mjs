/**
 * 统一图片取用管线：磁盘缓存 / 并发合并 / 上游限流 / Python(Pillow) 或 sharp 降分辨率。
 *
 * 缓存目录：~/.dsh-eh/cache/img
 * 文件名：<sha1(key)>.<ext> + <sha1(key)>.json
 *
 * 远端图走 dsh-ehviewer 的 client（同一份 cookie / 代理 / 限速）；本地图只读文件。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const MCP_SRC = new URL('../../dsh-ehviewer/packages/mcp/src/', import.meta.url);
const CACHE_DIR = path.join(os.homedir(), '.dsh-eh', 'cache', 'img');
const CAP_MB = Math.max(16, Number(process.env.DSH_EH_CACHE_MB) || 512);
const CAP_BYTES = CAP_MB * 1024 * 1024;
const MAX_UPSTREAM = 6;
const UPSTREAM_TIMEOUT = 15000;
const PANEL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};
const EXT_BY_MIME = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
};

let dirReady = null;
let writeCount = 0;
let gcPromise = null;
let sharpPromise = null;
let modulesPromise = null;
let clientPromise = null;
const inflight = new Map();

/* ------------------------------------------------------------------ 基础 */

function clampWidth(value, fallback = 320) {
  if (value === 0 || value === '0' || value === 'none' || value === 'off') return 0;
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.min(2000, Math.max(64, n));
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

function etagOf(buffer) {
  return sha1(buffer).slice(0, 16);
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

async function ensureDir() {
  if (!dirReady) {
    dirReady = fsp.mkdir(CACHE_DIR, { recursive: true }).catch((err) => {
      dirReady = null;
      throw err;
    });
  }
  return dirReady;
}

async function getSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((m) => m.default || m)
      .catch(() => null);
  }
  return sharpPromise;
}

const PY_PROBE = "from PIL import features;assert features.check('webp');print('ok')";
const PY_RESIZE = `import sys
from PIL import Image
src,dst,w,q=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
im=Image.open(src).convert('RGB')
im.thumbnail((w,100000))
try:
    im.save(dst,'WEBP',quality=q,method=4)
    print('webp')
except Exception:
    dst=dst.rsplit('.',1)[0]+'.jpg'
    im.save(dst,'JPEG',quality=80)
    print('jpeg')`;

let backendPromise = null;

function probePython() {
  const candidates = process.env.DSH_EH_PYTHON
    ? [{ cmd: process.env.DSH_EH_PYTHON, prefix: [] }]
    : [
        { cmd: 'python', prefix: [] },
        { cmd: 'py', prefix: ['-3'] },
        { cmd: 'python3', prefix: [] },
      ];

  for (const c of candidates) {
    try {
      const r = spawnSync(c.cmd, [...c.prefix, '-c', PY_PROBE], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      // WindowsApps 的商店占位会退出 0 但不执行；要求 stdout 真有 ok。
      if (r && r.status === 0 && /ok/i.test(String(r.stdout || ''))) {
        return { cmd: c.cmd, prefix: c.prefix };
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

async function getBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      const py = probePython();
      if (py) {
        console.log('[cache] resize backend: python');
        return { name: 'python', cmd: py.cmd, prefix: py.prefix };
      }
      const sharp = await getSharp();
      if (sharp) {
        console.log('[cache] resize backend: sharp');
        return { name: 'sharp', sharp };
      }
      console.log('[cache] resize backend: none');
      return { name: 'none' };
    })().catch(() => {
      console.log('[cache] resize backend: none');
      return { name: 'none' };
    });
  }
  return backendPromise;
}

function originalImage(buffer, mime) {
  const dims = probeSize(buffer, mime);
  return {
    buffer,
    mime,
    width: dims.w,
    height: dims.h,
    resized: false,
    backend: 'none',
  };
}

async function runPythonResize(buffer, mime, width, file) {
  let inputFile = file;
  let tempInput = null;
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outWebp = path.join(os.tmpdir(), `dsh-eh-out-${stamp}.webp`);
  const outJpg = outWebp.replace(/\.webp$/i, '.jpg');

  try {
    if (!inputFile) {
      const ext = EXT_BY_MIME[mime] || 'bin';
      tempInput = path.join(os.tmpdir(), `dsh-eh-in-${stamp}.${ext}`);
      await fsp.writeFile(tempInput, buffer);
      inputFile = tempInput;
    }

    const backend = await getBackend();
    const args = [
      ...(backend.prefix || []),
      '-c',
      PY_RESIZE,
      inputFile,
      outWebp,
      String(width),
      '75',
    ];

    const result = await new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let child;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      try {
        child = spawn(backend.cmd, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        resolve(null);
        return;
      }

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(null);
      }, 8000);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('error', () => finish(null));
      child.on('close', async (code) => {
        if (settled) return;
        if (code !== 0) return finish(null);

        const wantJpeg = /jpeg/i.test(stdout);
        const candidates = wantJpeg ? [outJpg, outWebp] : [outWebp, outJpg];
        let chosen = null;
        for (const p of candidates) {
          try {
            const st = await fsp.stat(p);
            if (st.isFile() && st.size > 0) {
              chosen = p;
              break;
            }
          } catch {
            /* next */
          }
        }
        if (!chosen) return finish(null);

        try {
          const out = await fsp.readFile(chosen);
          const outMime = /\.jpg$/i.test(chosen) ? 'image/jpeg' : 'image/webp';
          const dims = probeSize(out, outMime);
          finish({
            buffer: out,
            mime: outMime,
            width: dims.w,
            height: dims.h,
            resized: true,
            backend: 'python',
          });
        } catch {
          finish(null);
        }
      });
    });

    return result;
  } catch {
    return null;
  } finally {
    if (tempInput) {
      try {
        await fsp.unlink(tempInput);
      } catch {
        /* ignore */
      }
    }
    for (const p of [outWebp, outJpg]) {
      try {
        await fsp.unlink(p);
      } catch {
        /* ignore */
      }
    }
  }
}

async function runSharpResize(buffer, width) {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const out = await sharp(buffer)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: out.data,
      mime: 'image/webp',
      width: out.info.width || 0,
      height: out.info.height || 0,
      resized: true,
      backend: 'sharp',
    };
  } catch {
    return null;
  }
}

async function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const names = ['config', 'http'];
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

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const M = await modules();
      const cfg = await M.config.loadConfig();
      const client = await M.http.createClient(cfg);
      return { client, cfg };
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/* -------------------------------------------------------------- 并发 / 限流 */

let active = 0;
const waiters = [];

async function acquire() {
  if (active < MAX_UPSTREAM) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

async function withSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(httpError(504, message || 'upstream timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/* -------------------------------------------------------------- 磁盘缓存 */

function cachePaths(key) {
  const hash = sha1(key);
  return {
    hash,
    imageBase: path.join(CACHE_DIR, hash),
    metaPath: path.join(CACHE_DIR, `${hash}.json`),
  };
}

async function readCache(key) {
  const { hash, imageBase, metaPath } = cachePaths(key);
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
  const ext = meta.ext || EXT_BY_MIME[meta.mime] || 'bin';
  let buffer;
  try {
    buffer = await fsp.readFile(`${imageBase}.${ext}`);
  } catch {
    return null;
  }
  const etag = etagOf(buffer);
  meta.hits = Number(meta.hits || 0) + 1;
  meta.at = new Date().toISOString();
  try {
    await fsp.writeFile(metaPath, JSON.stringify(meta));
  } catch {
    /* 命中统计写不进去不影响返回 */
  }
  return {
    buffer,
    mime: meta.mime || 'application/octet-stream',
    etag,
    cached: true,
    resized: Boolean(meta.resized),
    backend: meta.backend || 'none',
    width: Number(meta.w) || 0,
    height: Number(meta.h) || 0,
  };
}

async function writeCache(key, { buffer, mime, width = 0, height = 0, resized = false, backend = 'none', url = '' }) {
  await ensureDir();
  const { hash, imageBase, metaPath } = cachePaths(key);
  const ext = EXT_BY_MIME[mime] || 'bin';
  const imagePath = `${imageBase}.${ext}`;
  const tmp = path.join(CACHE_DIR, `.${hash}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, imagePath);

  const meta = {
    url,
    mime,
    w: Number(width) || 0,
    h: Number(height) || 0,
    bytes: buffer.length,
    at: new Date().toISOString(),
    hits: 0,
    resized: Boolean(resized),
    backend,
    ext,
  };
  const metaTmp = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(metaTmp, JSON.stringify(meta));
  await fsp.rename(metaTmp, metaPath);

  writeCount += 1;
  if (writeCount % 200 === 0) void gc();

  return {
    buffer,
    mime,
    etag: etagOf(buffer),
    cached: false,
    resized: Boolean(resized),
    backend: meta.backend,
    width: meta.w,
    height: meta.h,
  };
}

/* ------------------------------------------------------------------- GC */

export function gc() {
  if (gcPromise) return gcPromise;
  gcPromise = (async () => {
    let names;
    try {
      names = await fsp.readdir(CACHE_DIR);
    } catch {
      return { total: 0, removed: 0, capMb: CAP_MB };
    }

    const entries = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const metaPath = path.join(CACHE_DIR, name);
      let meta;
      try {
        meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      } catch {
        continue;
      }
      const imagePath = path.join(CACHE_DIR, `${name.slice(0, -5)}.${meta.ext || EXT_BY_MIME[meta.mime] || 'bin'}`);
      let st;
      try {
        st = await fsp.stat(imagePath);
      } catch {
        continue;
      }
      entries.push({
        metaPath,
        imagePath,
        size: st.size,
        at: Date.parse(meta.at) || st.mtimeMs,
      });
    }

    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= CAP_BYTES) return { total, removed: 0, capMb: CAP_MB };

    entries.sort((a, b) => a.at - b.at);
    let removed = 0;
    for (const e of entries) {
      if (total <= CAP_BYTES * 0.85) break;
      try {
        await fsp.unlink(e.imagePath);
      } catch {
        /* ignore */
      }
      try {
        await fsp.unlink(e.metaPath);
      } catch {
        /* ignore */
      }
      total -= e.size;
      removed += 1;
    }
    return { total, removed, capMb: CAP_MB };
  })().finally(() => {
    gcPromise = null;
  });
  return gcPromise;
}

// 启动后跑一遍；失败不阻塞服务。
void gc().catch(() => {});

/* ------------------------------------------------------------------ 远端 */

function probeSize(buffer, mime) {
  try {
    const b = buffer;
    if (!b || b.length < 16) return { w: 0, h: 0 };

    // PNG
    if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    // GIF
    if (b.toString('ascii', 0, 3) === 'GIF') {
      return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    }
    // WEBP
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = b.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      }
      if (chunk === 'VP8 ' && b.length >= 30) {
        return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && b.length >= 25) {
        const b1 = b[21];
        const b2 = b[22];
        const b3 = b[23];
        const b4 = b[24];
        return {
          w: 1 + (((b2 & 0x3f) << 8) | b1),
          h: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
        };
      }
    }
    // JPEG（逐段找 SOF）
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0xd9) {
          i += 2;
          continue;
        }
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* ignore */
  }
  return { w: 0, h: 0 };
}

async function resizeImage({ buffer, mime, width, want, file }) {
  if (want === 'original' || !width) return originalImage(buffer, mime);

  const backend = await getBackend();
  if (backend.name === 'python') {
    const out = await runPythonResize(buffer, mime, width, file);
    return out || originalImage(buffer, mime);
  }
  if (backend.name === 'sharp') {
    const out = await runSharpResize(buffer, width);
    return out || originalImage(buffer, mime);
  }
  return originalImage(buffer, mime);
}

/**
 * 远端图。命中磁盘缓存不联网。
 * @param {{url:string, referer?:string, width?:number, want?:'webp'|'original', client?:object}} opts
 */
export async function getImage({ url, referer, width = 320, want = 'webp', client } = {}) {
  if (!url) throw httpError(400, '缺少 url');
  const w = clampWidth(width, 320);
  const backend = await getBackend();
  const key = `remote|${url}|${w}|${backend.name}`;

  const hit = await readCache(key);
  if (hit) return hit;

  if (inflight.has(key)) {
    const out = await inflight.get(key);
    return { ...out, cached: true };
  }

  const task = (async () =>
    withSlot(async () => {
      let c = client;
      let ua = PANEL_UA;
      if (!c) {
        const ent = await getClient();
        c = ent.client;
        ua = (ent.cfg && ent.cfg.userAgent) || PANEL_UA;
      }

      let r;
      try {
        r = await withTimeout(
          c.getBinary(url, {
            redirect: false,
            headers: { referer: referer || 'https://e-hentai.org/', 'user-agent': ua },
          }),
          UPSTREAM_TIMEOUT,
          'upstream timeout'
        );
      } catch (err) {
        if (err && err.status) throw err;
        throw httpError(502, `缩略图拉取失败：${(err && err.message) || err}`);
      }

      if (r && r.status === 429) {
        throw httpError(429, 'upstream rate limited', { retryAfter: 30 });
      }
      const status = r && r.status != null ? r.status : '?';
      if (!r || !r.buffer || !r.buffer.length || (r.status && r.status >= 400)) {
        throw httpError(502, `缩略图拉取失败（status=${status}）`);
      }

      const type = String((r.headers && r.headers['content-type']) || 'image/jpeg').toLowerCase();
      if (!/^image\/(webp|jpeg|jpg|png|gif)\b/.test(type)) {
        throw httpError(502, `上游不是位图（${type}）`);
      }

      const out = await resizeImage({ buffer: r.buffer, mime: type, width: w, want });
      return writeCache(key, {
        buffer: out.buffer,
        mime: out.mime,
        width: out.width,
        height: out.height,
        resized: out.resized,
        backend: out.backend,
        url,
      });
    }))().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/* ------------------------------------------------------------------ 本地 */

/**
 * 本地图（只读下载根内的文件）。缓存键包含 path+mtime+size+w，文件变了自动失效。
 * @param {{file:string, width?:number, want?:'webp'|'original'}} opts
 */
export async function getLocalImage({ file, width = 400, want = 'webp' } = {}) {
  if (!file) throw httpError(400, '缺少 file');

  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw httpError(404, '文件不存在');
  }
  if (!st.isFile()) throw httpError(404, '不是文件');

  const w = clampWidth(width, 400);
  const backend = await getBackend();
  const key = `local|${file}|${st.mtimeMs}|${st.size}|${w}|${backend.name}`;

  const hit = await readCache(key);
  if (hit) return hit;

  if (inflight.has(key)) {
    const out = await inflight.get(key);
    return { ...out, cached: true };
  }

  const task = (async () =>
    withSlot(async () => {
      const buffer = await fsp.readFile(file);
      const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const out = await resizeImage({ buffer, mime, width: w, want, file });
      return writeCache(key, {
        buffer: out.buffer,
        mime: out.mime,
        width: out.width,
        height: out.height,
        resized: out.resized,
        backend: out.backend,
        url: file,
      });
    }))().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

// 启动时探测一次 resize 后端，并打一行日志。
void getBackend();

export const cacheDir = CACHE_DIR;
export const cacheCapMb = CAP_MB;
