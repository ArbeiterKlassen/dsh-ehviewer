/**
 * pages.js — 多页查看器：页链接解析、图片地址解析、showkey / 重载
 *
 * 站点现状（实测 2026-11，未登录）：
 *   - 画廊页 `?p=<n>` 直接给出 20 张缩略图，容器是 `#gdt`，里面是
 *     `<a href="/s/<ihash>/<pageToken>-<n>"><div style="background:url(thumb)"></div></a>`
 *   - 旧版（以及部分镜像）仍然用 `#gdt .gdtm a`（普通）/ `.gdtl a`（大图）
 *   三种都支持。
 *
 * 图片页 `#img` 的 src 命中 `/img/509.gif` 或 `blank.gif` 时才算加载失败——
 * 注意 `#loadfail` 链接在正常情况下也存在，不能只看它。
 */

import * as cheerio from 'cheerio';
import { absUrl, galleryUrl, siteFromBase } from './gallery.js';

const DEFAULT_BASE = 'https://e-hentai.org';
const PER_PAGE = 20; // 画廊页每屏 20 张缩略图

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 从 /s/<ihash>/<pageToken>-<n> 里拆字段 */
function parsePageHref(href) {
  const m = String(href || '').match(/\/s\/([0-9a-z]+)\/([0-9a-z]+?)(?:-(\d+))?\/?(?:[?#].*)?$/i);
  if (!m) {
    const loose = String(href || '').match(/\/s\/([0-9a-z]+)\/([^/?#]+)/i);
    if (!loose) return null;
    const m2 = loose[2].match(/^([0-9a-z]+?)-(\d+)$/i);
    return { ihash: loose[1], pageToken: m2 ? m2[1] : loose[2], index: m2 ? Number(m2[2]) : null };
  }
  return { ihash: m[1], pageToken: m[2], index: m[3] ? Number(m[3]) : null };
}

function attachWarnings(arr, warnings) {
  Object.defineProperty(arr, 'warnings', { value: warnings, enumerable: false, configurable: true });
  return arr;
}

function isPlaceholder(src) {
  const s = String(src || '');
  if (!s) return true;
  if (/^data:/i.test(s)) return true;
  if (/\/img\/(509|blank)\.(gif|png)/i.test(s)) return true;
  return false;
}

/** 从字符串里读 showkey */
function readShowKey(html) {
  const m = String(html || '').match(/showkey\s*=\s*["']([0-9a-zA-Z]+)["']/i);
  return m ? m[1] : '';
}

/** 从 nl('35078-498401') 里读重载 key */
function readNlKey(s) {
  const m = String(s || '').match(/nl\(\s*['"]([^'"]+)['"]\s*\)/i);
  return m ? m[1] : '';
}

/** 给 URL 追加查询参数（保留已有 query） */
function withParam(url, key, value) {
  const u = String(url || '');
  if (!u) return '';
  const sep = u.includes('?') ? '&' : '?';
  return `${u}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

/* ------------------------------------------------------------------ */
/* 页链接解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 解析一屏缩略图里的页链接。
 * @returns {PageEntry[]} [{index, url, ihash, pageToken}]，index 从 1 开始，数组上挂 warnings
 */
export function parsePageEntries(html, { base = DEFAULT_BASE } = {}) {
  const warnings = [];
  const out = [];
  const seen = new Set();

  if (typeof html !== 'string' || !html.trim()) {
    warnings.push('页 HTML 为空');
    return attachWarnings(out, warnings);
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    warnings.push(`HTML 解析失败: ${e.message}`);
    return attachWarnings(out, warnings);
  }

  // 三种容器：旧版 .gdtm / .gdtl，新版 #gdt 直接挂 a
  const links = $('#gdt .gdtm a, #gdt .gdtl a, #gdt > a, #gdt a[href*="/s/"]');
  if (!links.length) {
    warnings.push('#gdt 里没有页链接（可能不是多页视图，或页面结构变化）');
    return attachWarnings(out, warnings);
  }

  let order = 0;
  links.each((_, a) => {
    const href = String($(a).attr('href') || '');
    const parsed = parsePageHref(href);
    if (!parsed) return;
    const url = absUrl(href, base);
    if (seen.has(url)) return;
    seen.add(url);
    order += 1;
    out.push({
      index: parsed.index || order, // 有 -n 就用 -n，没有就按出现顺序
      url,
      ihash: parsed.ihash,
      pageToken: parsed.pageToken,
    });
  });

  if (!out.length) warnings.push('页链接存在但都没能解析出 ihash/pageToken');
  return attachWarnings(out, warnings);
}

/** cheerio 用同步 import，这里只是结构化一下，出错时给统一报错 */
/* cheerio 已在文件顶部 import，见 `import * as cheerio from 'cheerio'` */

/* ------------------------------------------------------------------ */
/* 翻页                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按 20 张/页 翻页，直到拿到 from..to（含）区间。
 * @param client http.js 的 client
 * @param {{gallery: object|string, from?: number, to?: number}} opts
 * @returns {PageEntry[]}
 */
export async function listPages(client, { gallery, from = 1, to = null } = {}) {
  const warnings = [];
  const out = [];
  const seen = new Set();

  const g = typeof gallery === 'string' ? { url: gallery } : gallery || {};
  const base = g.base || DEFAULT_BASE;
  const galleryPageUrl = g.url || (g.gid && g.token ? galleryUrl(g.gid, g.token, base) : '');
  if (!galleryPageUrl) {
    warnings.push('gallery 缺少 url 或 gid/token，无法翻页');
    return attachWarnings(out, warnings);
  }

  const total = Number(g.pages || g.filecount || 0) || null;
  // 页数未知且调用方没给 to → 视为「一直翻到最后一屏」，否则只会拿到第 1 页
  const unlimited = !total && (to === null || to === undefined);
  let start = Math.max(1, Math.floor(Number(from) || 1));
  let end = unlimited
    ? Number.MAX_SAFE_INTEGER
    : to === null || to === undefined || !Number.isFinite(Number(to))
      ? total || start
      : Math.floor(Number(to));
  if (end < start) [start, end] = [end, start];
  if (total) end = Math.min(end, total);

  // 需要的屏（0 基）
  const first = Math.floor((start - 1) / PER_PAGE);
  const last = unlimited ? first + 39 : Math.floor((end - 1) / PER_PAGE);
  const MAX_SCREENS = 40; // 硬闸，防止站点结构异常时无限翻页
  let guard = 0;

  for (let p = first; p <= last; p++) {
    if (guard++ > MAX_SCREENS) {
      warnings.push('翻页次数触顶（40 屏），提前停止');
      break;
    }
    const url = p === 0 ? galleryPageUrl : withParam(galleryPageUrl, 'p', p);
    let res;
    try {
      res = await client.get(url);
    } catch (e) {
      // EHBlocked 要往上抛，让上层提示封禁；其他错误降级成 warnings
      if (e && (e.name === 'EHBlocked' || e.constructor?.name === 'EHBlocked')) throw e;
      warnings.push(`第 ${p} 屏请求失败: ${e.message}`);
      break;
    }
    if (!res || res.status >= 400) {
      warnings.push(`第 ${p} 屏返回 ${res?.status ?? '无响应'}`);
      break;
    }
    const entries = parsePageEntries(res.text, { base });
    for (const w of entries.warnings || []) warnings.push(w);
    if (!entries.length) {
      warnings.push(`第 ${p} 屏没有解析到页链接`);
      break;
    }
    for (const e of entries) {
      if (e.index < start || e.index > end) continue;
      if (seen.has(e.index)) continue;
      seen.add(e.index);
      out.push(e);
    }
    // 拿到 20 条以下说明已经是最后一屏
    if (entries.length < PER_PAGE && p < last) break;
  }

  out.sort((a, b) => a.index - b.index);
  if (!out.length) warnings.push(`没有拿到 ${start}..${end} 区间的页`);
  else if (!unlimited && out.length < end - start + 1) warnings.push(`区间不完整：要 ${start}..${end}，实得 ${out.length} 页`);

  Object.defineProperty(out, 'warnings', { value: warnings, enumerable: false, configurable: true });
  Object.defineProperty(out, 'site', { value: siteFromBase(base), enumerable: false, configurable: true });
  return out;
}

/* ------------------------------------------------------------------ */
/* 图片页解析                                                          */
/* ------------------------------------------------------------------ */

/** HTML 实体反转义（cheerio 通常已解码，这里再兜一层，绝不改动 URL 其余部分） */
function unescapeAttr(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** 从一页 HTML 里抽图片信息（内部纯函数，便于重载后复用） */
function extractImage($, html, pageUrl, base, warnings) {
  const img = $('#img').first();

  // 图片直链：原样取整串。不 split、不截断、不按 -780-1200- 之类片段猜。
  const url = unescapeAttr(img.attr('src')).trim();
  const style = String(img.attr('style') || '');
  const onerror = String(img.attr('onerror') || '');

  // reloadUrl：优先 #i3 a[href*="nl="]，其次 #loadfail 的 href（同样原样取）
  let reloadUrl = '';
  const nlHref = $('#i3 a[href*="nl="]').first().attr('href') || $('#loadfail[href]').first().attr('href') || '';
  if (nlHref && nlHref !== '#') reloadUrl = absUrl(unescapeAttr(nlHref), base);
  if (!reloadUrl) {
    const nlKey = readNlKey(onerror) || readNlKey($('#loadfail').attr('onclick'));
    if (nlKey) reloadUrl = withParam(pageUrl, 'nl', nlKey);
  }
  if (!reloadUrl) warnings.push('未找到重载链接（?nl= / nl(key)）');

  // showkey：页面内联脚本最可靠
  let showKey = readShowKey(html);
  if (!showKey) {
    $('#i6 a').each((_, a) => {
      if (showKey) return;
      const txt = `${$(a).attr('onclick') || ''} ${$(a).attr('href') || ''}`;
      const m = txt.match(/showkey[=:]\s*([0-9a-zA-Z]+)/i);
      if (m) showKey = m[1];
    });
  }
  if (!showKey && reloadUrl) {
    const m = reloadUrl.match(/[?&]showkey=([0-9a-zA-Z]+)/i);
    if (m) showKey = m[1];
  }
  if (!showKey) warnings.push('未取到 showkey');

  // 宽高：从 #img 的 style 抠（width/height 顺序不固定），再退到页面变量 / 文字
  let width = null;
  let height = null;
  const wm = style.match(/width\s*:\s*(\d+)\s*px/i);
  const hm = style.match(/height\s*:\s*(\d+)\s*px/i);
  if (wm) width = Number(wm[1]);
  if (hm) height = Number(hm[1]);
  if (width === null || height === null) {
    const xm = html.match(/var\s+xres\s*=\s*(\d+)\s*;\s*var\s+yres\s*=\s*(\d+)/i);
    if (xm) {
      width = width ?? Number(xm[1]);
      height = height ?? Number(xm[2]);
    }
  }
  if (width === null || height === null) {
    const tm = ($('#i4').text() || '').match(/(\d{2,5})\s*x\s*(\d{2,5})/i);
    if (tm) {
      width = width ?? Number(tm[1]);
      height = height ?? Number(tm[2]);
    }
  }
  if (width === null || height === null) warnings.push('未取到图片宽高');

  // 请求图片页要带的 Referer：页面里的「返回画廊」链接最准（/g/<gid>/<token>/）
  let referer = '';
  const backHref = $('#i5 a[href*="/g/"]').first().attr('href') || $('#i2 a[href*="/g/"]').first().attr('href') || '';
  if (backHref) referer = absUrl(unescapeAttr(backHref), base);
  if (!referer) {
    const gm = String(html).match(/\/g\/(\d+)\/([0-9a-z]+)\//i);
    if (gm) referer = `${String(base).replace(/\/+$/, '')}/g/${gm[1]}/${gm[2]}/`;
  }

  const pm = String(pageUrl || '').match(/-(\d+)\/?$/);
  const index = pm ? Number(pm[1]) : 0;

  return { index, url, reloadUrl, showKey, width, height, referer, warnings };
}

/**
 * 解析图片页。占位图 + 有重载链接时，会自动重载**一次**。
 * @returns {Promise<ImageResult>} {index, url, reloadUrl, showKey, width, height, warnings}
 */
export async function resolveImage(client, pageUrl) {
  const warnings = [];
  const base = String(pageUrl || '').match(/^https?:\/\/[^/]+/i)?.[0] || DEFAULT_BASE;

  if (!pageUrl) {
    warnings.push('pageUrl 为空');
    return { index: 0, url: '', reloadUrl: '', showKey: '', width: null, height: null, referer: '', warnings };
  }

  let res;
  try {
    res = await client.get(pageUrl);
  } catch (e) {
    if (e && (e.name === 'EHBlocked' || e.constructor?.name === 'EHBlocked')) throw e;
    warnings.push(`图片页请求失败: ${e.message}`);
    return { index: 0, url: '', reloadUrl: '', showKey: '', width: null, height: null, referer: '', warnings };
  }
  if (!res || res.status >= 400) {
    warnings.push(`图片页返回 ${res?.status ?? '无响应'}`);
    return { index: 0, url: '', reloadUrl: '', showKey: '', width: null, height: null, referer: '', warnings };
  }

  let $ = cheerio.load(res.text);
  let result = extractImage($, res.text, res.finalUrl || pageUrl, base, warnings);

  // 只有「图上确实是占位图」才重载；#loadfail 正常页面也常驻，不能作为判据
  const needsReload = isPlaceholder(result.url) && !!result.reloadUrl;
  if (needsReload) {
    warnings.push('图片为占位图（509.gif），按 reloadUrl 重载一次');
    try {
      // 重载必须带 Referer（画廊页），否则 H@H 可能直接 404
      const r2 = await client.get(result.reloadUrl, { referer: result.referer || pageUrl });
      if (r2 && r2.status < 400) {
        $ = cheerio.load(r2.text);
        const result2 = extractImage($, r2.text, r2.finalUrl || pageUrl, base, []);
        result = {
          ...result2,
          // 保留第一次拿到的 showkey / reloadUrl（重载页可能不再给）
          showKey: result2.showKey || result.showKey,
          reloadUrl: result2.reloadUrl || result.reloadUrl,
          referer: result2.referer || result.referer,
          index: result2.index || result.index,
        };
        if (isPlaceholder(result.url)) warnings.push('重载后仍是占位图（可能需要登录或换 H@H 节点）');
      } else {
        warnings.push(`重载请求返回 ${r2?.status ?? '无响应'}`);
      }
    } catch (e) {
      if (e && (e.name === 'EHBlocked' || e.constructor?.name === 'EHBlocked')) throw e;
      warnings.push(`重载失败: ${e.message}`);
    }
  } else if (isPlaceholder(result.url)) {
    warnings.push('图片是占位图，但没有可用重载链接');
  }

  // 直链完整性自检：这条链路最容易出的就是被截断
  if (result.url && !/^https?:\/\//i.test(result.url)) warnings.push('图片直链不是绝对地址，可能解析异常');
  if (result.url && !result.url.includes('keystamp')) {
    warnings.push('图片直链没有 keystamp 参数（可能不完整或需要重载）');
  }

  return { ...result, warnings };
}

/* ------------------------------------------------------------------ */
/* 自检                                                                */
/* ------------------------------------------------------------------ */

export async function __selftest() {
  const out = { module: 'pages', ok: true, checks: [], warnings: [] };
  try {
    const html = `<div id="gdt" class="gt200">
      <a href="https://e-hentai.org/s/96f43585df/4317466-1"><div style="background:url(x)"></div></a>
      <a href="https://e-hentai.org/s/bc455bd0ad/4317466-2"><div></div></a></div>`;
    const entries = parsePageEntries(html, { base: 'https://e-hentai.org' });
    out.checks.push(['parsePageEntries(#gdt 网格)', entries.length === 2 && entries[1].index === 2 && entries[0].ihash === '96f43585df']);

    // 旧版 .gdtm
    const old = `<div id="gdt"><div class="gdtm"><a href="https://e-hentai.org/s/aa11bb/9-7"></a></div></div>`;
    const e2 = parsePageEntries(old, { base: 'https://e-hentai.org' });
    out.checks.push(['parsePageEntries(.gdtm)', e2.length === 1 && e2[0].index === 7]);

    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'imagepage.html');
    if (existsSync(p)) {
      const $ = cheerio.load(readFileSync(p, 'utf8'));
      const r = extractImage($, readFileSync(p, 'utf8'), 'https://e-hentai.org/s/96f43585df/4317466-1', 'https://e-hentai.org', []);
      out.checks.push(['extractImage(宽度/高度/showKey)', r.width === 1280 && r.height === 1690 && !!r.showKey, `${r.width}x${r.height} showkey=${r.showKey}`]);
      out.facts = { url: r.url, showKey: r.showKey, reloadUrl: r.reloadUrl };
    } else {
      out.warnings.push('缺少 imagepage.html fixture，跳过图片页检查');
    }
  } catch (e) {
    out.ok = false;
    out.warnings.push(`自检异常: ${e.message}`);
  }
  out.ok = out.ok && out.checks.every(([, pass]) => !!pass);
  return out;
}
