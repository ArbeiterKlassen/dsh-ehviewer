/**
 * 在线画廊的读图后端：给本地面板用。
 * 复用的是 eh-mcp 自己的 src/*（同一份 config / cookies / proxy / 解析器），
 * 所以面板读在线图不需要再登录一次，也不会绕开限速。
 */
import { loadConfig } from 'dsh-ehviewer/config';
import { createClient } from 'dsh-ehviewer/http';
import { galleryDetail } from 'dsh-ehviewer/browse';
import { resolveBase, galleryUrl } from 'dsh-ehviewer/gallery';
import { listPages, resolveImage } from 'dsh-ehviewer/pages';

const PAGE_WINDOW = 20;

let _client = null;
let _cfg = null;

async function getClient() {
  if (_client) return { client: _client, cfg: _cfg };
  _cfg = await loadConfig();
  _client = await createClient(_cfg);
  return { client: _client, cfg: _cfg };
}

/** gid -> {gid, token, base, site, title, total, entries: Map<index, pageUrl>, at} */
const galleries = new Map();

async function galleryCtx({ gid, token }) {
  const key = `${gid}:${token}`;
  const hit = galleries.get(key);
  if (hit) return hit;

  const { client, cfg } = await getClient();
  const base = resolveBase(cfg, 'https://exhentai.org');
  const r = await galleryDetail(client, { base, gid, token });
  if (!r?.detail) throw new Error((r?.warnings || [])[0] || '拿不到画廊详情');

  const ctx = {
    gid: Number(gid),
    token,
    base: r.detail.site ? base : base,
    site: r.site || 'exhentai',
    title: r.detail.title || '',
    total: Number(r.detail.pages) || null,
    entries: new Map(),
    at: Date.now(),
  };
  galleries.set(key, ctx);
  return ctx;
}

/**
 * 拿 [from, to] 这一段页链接；已经拿过的直接命中缓存。
 * @returns {Promise<{items:Array<{index:number,url:string}>, total:number|null, title:string, site:string, warnings:string[]}>}
 */
export async function listWindow({ gid, token, from = 1, to = null }) {
  const ctx = await galleryCtx({ gid, token });
  const start = Math.max(1, Number(from) || 1);
  const end = Math.min(
    Number(to) || start + PAGE_WINDOW - 1,
    ctx.total || Number.MAX_SAFE_INTEGER,
    start + PAGE_WINDOW - 1,
  );

  const missing = [];
  for (let i = start; i <= end; i += 1) if (!ctx.entries.has(i)) missing.push(i);
  const warnings = [];

  if (missing.length) {
    const { client } = await getClient();
    const got = await listPages(client, {
      gallery: { gid: ctx.gid, token: ctx.token, base: ctx.base, pages: ctx.total, url: galleryUrl(ctx.gid, ctx.token, ctx.base) },
      from: missing[0],
      to: missing[missing.length - 1],
    });
    for (const w of got.warnings || []) warnings.push(w);
    for (const e of got) ctx.entries.set(e.index, e.url);
    if (!ctx.total && got.length && got.length < PAGE_WINDOW) ctx.total = got[got.length - 1].index;
  }

  const items = [];
  for (let i = start; i <= end; i += 1) {
    const url = ctx.entries.get(i);
    if (url) items.push({ index: i, url });
  }
  return { items, total: ctx.total, title: ctx.title, site: ctx.site, warnings };
}

/**
 * 第 index 页的真图片字节（走本站 cookie + 代理）。
 * @returns {Promise<{buffer:Buffer, mimeType:string, url:string, referer:string}>}
 */
export async function getImage({ gid, token, index }) {
  const n = Math.max(1, Number(index) || 1);
  const ctx = await galleryCtx({ gid, token });
  if (!ctx.entries.has(n)) await listWindow({ gid, token, from: n, to: n });
  const pageUrl = ctx.entries.get(n);
  if (!pageUrl) throw new Error(`第 ${n} 页的链接没拿到（可能超出总页数 ${ctx.total ?? '?'}）`);

  const { client } = await getClient();
  const resolved = await resolveImage(client, pageUrl);
  if (!resolved?.url) throw new Error((resolved?.warnings || [])[0] || '图片地址解析失败');

  const res = await client.getBinary(resolved.url, { headers: { referer: resolved.referer || pageUrl } });
  if (!res?.buffer || !res.buffer.length) throw new Error(`图片下载失败（status=${res?.status ?? '?'}）`);
  const mimeType = res.headers?.['content-type'] || 'image/jpeg';
  return { buffer: res.buffer, mimeType, url: resolved.url, referer: resolved.referer || pageUrl };
}

/** 面板用：清掉某个画廊的内存缓存（换 cookie / 重试时用） */
export function forget(gid) {
  for (const key of [...galleries.keys()]) {
    if (key.startsWith(`${gid}:`)) galleries.delete(key);
  }
}
