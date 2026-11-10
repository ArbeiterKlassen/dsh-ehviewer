/**
 * gallery.js — 列表页 / 详情页 HTML 解析 + URL 构造
 *
 * 设计原则（契约第 4 条）：解析函数一律不抛异常。
 * 结构缺失时返回空数组 / 空字符串 / null，并在 `warnings` 里记一句。
 * 数组/对象返回值上挂一个非索引属性 `warnings`（JSON 序列化时不会污染数据）。
 *
 * 只依赖 cheerio。站点结构在变，所有选择器都写了多套兜底：
 *   - 列表：新版 `table.itg.gltc` 表格布局（td.gl1c / td.gl2c / td.gl3c / td.gl4c）
 *           与经典 `.itg.gld .gl1t` 卡片布局都支持
 *   - 详情：`#gn/#gj/#gdc/#gdn/#gdd/#gdr/#gdf/#gd4/#gd5/#gdt`，并保留旧版 `#gds/#gnd`
 */

import * as cheerio from 'cheerio';

/* ------------------------------------------------------------------ */
/* 常量与小工具                                                         */
/* ------------------------------------------------------------------ */

/**
 * e-hentai 的分类位掩码。
 * 站点参数 `f_cats` 的语义是「**排除**哪些分类」，所以对外暴露的 `category` 一律按
 * 「**想要**哪些分类」理解，拼 URL 时再取反：`f_cats = ALL_CATEGORY & ~want`。
 * 参考实现见 Ehviewer 的 ListUrlBuilder: `f_cats = (~cats) & EhConfig.ALL_CATEGORY`。
 */
export const CATEGORY_BITS = {
  misc: 1,
  doujinshi: 2,
  manga: 4,
  artistcg: 8,
  gamecg: 16,
  imageset: 32,
  cosplay: 64,
  asianporn: 128,
  nonh: 256,
  western: 512,
};

/** 全部分类位 = EhConfig.ALL_CATEGORY */
export const ALL_CATEGORY = 1023;

/** 把「想要」的掩码翻成站点要的「排除」掩码；0/空表示不限制 */
export function toFCats(want) {
  if (!want) return '';
  return String(ALL_CATEGORY & ~Number(want));
}

const DEFAULT_BASE = 'https://e-hentai.org';

/** 去掉结尾斜杠 */
function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

/**
 * 解析 cfg 里的站点根地址。cfg 可能是配置对象，也可能直接就是个 base 字符串。
 * 兼容 config.js 可能使用的几种字段名，避免互相猜。
 */
export function resolveBase(cfg, fallback = DEFAULT_BASE) {
  if (!cfg) return fallback;
  if (typeof cfg === 'string') return trimSlash(cfg) || fallback;
  const raw =
    cfg.base ||
    cfg.baseUrl ||
    cfg.siteUrl ||
    cfg.url ||
    (cfg.site === 'exhentai' ? 'https://exhentai.org' : '') ||
    (cfg.site === 'e-hentai' ? 'https://e-hentai.org' : '');
  return trimSlash(raw) || fallback;
}

/** 从 base 判断站点标识，用来给返回值带 site 字段 */
export function siteFromBase(base) {
  const b = String(base || '');
  if (/exhentai\.org/i.test(b)) return 'exhentai';
  if (/e-hentai\.org/i.test(b)) return 'e-hentai';
  return b ? 'custom' : 'e-hentai';
}

/** 相对链接转绝对；已经是绝对地址就原样返回 */
export function absUrl(href, base = DEFAULT_BASE) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `https:${h}`;
  const b = trimSlash(base || DEFAULT_BASE);
  if (h.startsWith('/')) return b + h;
  return `${b}/${h}`;
}

/** 从任意字符串里抠出第一个画廊 URL 的 gid / token */
function galleryIdsFrom(input) {
  const m = String(input || '').match(/\/g\/(\d+)\/([0-9a-z]+)/i);
  return m ? { gid: m[1], token: m[2] } : null;
}

/**
 * 取第一个非空文本。
 * 容忍省略 ctx 的写法：firstText($, ['sel'])（此时从文档根找）。
 */
function firstText($, ctx, selectors) {
  if (Array.isArray(ctx) && selectors === undefined) {
    selectors = ctx;
    ctx = $.root();
  }
  const scope = ctx || $.root();
  for (const sel of selectors || []) {
    try {
      const node = $(scope).find(sel).first();
      if (node && node.length) {
        const t = node.text().replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    } catch {
      /* 选择器写错也不能炸 */
    }
  }
  return '';
}

/**
 * 取第一个属性的值。
 * 容忍省略 ctx 的写法：firstAttr($, ['sel'], 'href')。
 */
function firstAttr($, ctx, selectors, attr) {
  if (Array.isArray(ctx) && typeof selectors === 'string' && attr === undefined) {
    attr = selectors;
    selectors = ctx;
    ctx = $.root();
  }
  const scope = ctx || $.root();
  for (const sel of selectors || []) {
    try {
      const node = $(scope).find(sel).first();
      if (node && node.length) {
        const v = node.attr(attr);
        if (v) return String(v).trim();
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

/** 从 style="...url(xxx)..." 里抠出图片地址 */
function cssUrl(style) {
  const m = String(style || '').match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  return m ? m[1].trim() : '';
}

/** 判断是不是占位图 / 懒加载占位 */
function isPlaceholderSrc(src) {
  const s = String(src || '');
  if (!s) return true;
  if (/^data:/i.test(s)) return true;
  if (/\/img\/(509|blank)\.(gif|png)/i.test(s)) return true;
  return false;
}

/** 把分类位掩码的各种输入形态归一成一个数字（0 表示不传） */
function normalizeCategory(category) {
  if (category === null || category === undefined || category === '') return 0;
  if (typeof category === 'number' && Number.isFinite(category)) return category | 0;
  if (Array.isArray(category)) {
    return category.reduce((acc, name) => acc | (CATEGORY_BITS[String(name).toLowerCase().replace(/[\s_-]/g, '')] || 0), 0);
  }
  const s = String(category).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s) | 0;
  // 逗号 / 空格 / 加号分隔的分类名
  return s
    .split(/[,+\s]+/)
    .filter(Boolean)
    .reduce((acc, name) => acc | (CATEGORY_BITS[name.toLowerCase().replace(/[\s_-]/g, '')] || 0), 0);
}

/* ------------------------------------------------------------------ */
/* URL 构造                                                            */
/* ------------------------------------------------------------------ */

/**
 * 画廊详情页地址。gid/token 缺失时返回空串（不抛）。
 * @param {string|number} gid
 * @param {string} token
 * @param {string} base 站点根，默认 e-hentai
 */
export function galleryUrl(gid, token, base = DEFAULT_BASE) {
  if (!gid || !token) return '';
  return `${trimSlash(base || DEFAULT_BASE)}/g/${gid}/${token}/`;
}

/**
 * 搜索页地址。f_search 做标准 urlencode；category 是 f_cats 位掩码（可空）。
 * 注意：f_cats 的值在站点语义里是「排除」的位，这里只透传，不做取反。
 */
export function buildSearchUrl(cfg, { query = '', page = 0, category = null } = {}) {
  const base = resolveBase(cfg);
  const p = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.floor(Number(page)) : 0;
  const params = [`f_search=${encodeURIComponent(String(query ?? ''))}`, `page=${p}`];
  const mask = normalizeCategory(category);
  if (mask) params.push(`f_cats=${toFCats(mask)}`);
  return `${base}/?${params.join('&')}`;
}

/* ------------------------------------------------------------------ */
/* 通用列表页 URL 构造（移植自 EhViewer ListUrlBuilder）                */
/* ------------------------------------------------------------------ */

/** 高级搜索字段 → 站内参数名（值统一写 on，与站点表单一致） */
const ADV_FLAGS = ['sname', 'stags', 'sdesc', 'storr', 'sto', 'sdt1', 'sdt2', 'sh', 'sfl', 'sfu', 'sft'];

/**
 * 按参考实现拼各种列表页地址。
 * @param {string} base 站点根
 * @param {object} opts
 *   mode: 'search' | 'uploader' | 'tag' | 'watched' | 'popular' | 'toplist' | 'favorites'
 *   keyword: 搜索词 / 上传者名 / 标签
 *   page: 0 基页码
 *   category: f_cats 位掩码（可空；数组或分类名也接受）
 *   adv: 高级搜索对象，支持 ADV_FLAGS 里各布尔开关 + sr/srdd + sp/spf/spt + tl（toplist 周期）+ favcat
 */
export function buildListUrl(base, { mode = 'search', keyword = '', page = 0, category = null, adv = null } = {}) {
  const b = trimSlash(base || DEFAULT_BASE);
  const p = Math.max(0, Math.floor(Number(page) || 0));
  const kw = String(keyword ?? '');

  switch (mode) {
    case 'uploader':
      return `${b}/uploader/${encodeURIComponent(kw)}${p ? `/${p}` : ''}`;

    case 'tag':
      return `${b}/tag/${encodeURIComponent(kw)}${p ? `/${p}` : ''}`;

    case 'popular':
      return `${b}/popular`;

    case 'toplist': {
      const tl = String(adv?.tl || '1d');
      return `${b}/toplist.php?tl=${encodeURIComponent(tl)}${p ? `&p=${p}` : ''}`;
    }

    case 'favorites': {
      const favcat = String(adv?.favcat ?? 0);
      return `${b}/favorites.php?favcat=${encodeURIComponent(favcat)}&page=${p}`;
    }

    case 'watched': {
      const params = [];
      if (kw) params.push(`f_search=${encodeURIComponent(kw)}`);
      if (p) params.push(`page=${p}`);
      return `${b}/watched${params.length ? `?${params.join('&')}` : ''}`;
    }

    case 'search':
    default: {
      const params = [`f_search=${encodeURIComponent(kw)}`, `page=${p}`];
      const mask = normalizeCategory(category);
      if (mask) params.push(`f_cats=${toFCats(mask)}`);

      // 高级搜索：任一开关/implicit 值存在就带 advsearch=1
      const advObj = adv && typeof adv === 'object' ? adv : null;
      if (advObj) {
        const flags = new Set(
          [...ADV_FLAGS, 'sr', 'sp'].filter((k) => advObj[k] === true || advObj[k] === 1 || advObj[k] === 'on' || advObj[k] === '1')
        );
        for (const f of Array.isArray(advObj.flags) ? advObj.flags : []) flags.add(String(f));
        if (advObj.srdd !== undefined || advObj.spf !== undefined || advObj.spt !== undefined) {
          if (advObj.srdd !== undefined) flags.add('sr');
          if (advObj.spf !== undefined || advObj.spt !== undefined) flags.add('sp');
        }
        if (flags.size) {
          params.push('advsearch=1');
          for (const f of ADV_FLAGS) if (flags.has(f)) params.push(`f_${f}=on`);
          if (flags.has('sr')) {
            params.push('f_sr=on');
            if (advObj.srdd !== undefined) params.push(`f_srdd=${encodeURIComponent(advObj.srdd)}`);
          }
          if (flags.has('sp')) {
            params.push('f_sp=on');
            if (advObj.spf !== undefined) params.push(`f_spf=${encodeURIComponent(advObj.spf)}`);
            if (advObj.spt !== undefined) params.push(`f_spt=${encodeURIComponent(advObj.spt)}`);
          }
        }
      }
      return `${b}/?${params.join('&')}`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 列表页解析                                                          */
/* ------------------------------------------------------------------ */

/** 从容器里抽一条 GalleryListItem */
function parseItem($, container, base) {
  const $c = $(container);
  const linkSel = 'a[href*="/g/"]';
  let href = '';
  // 优先名字格（表格布局 td.gl3c.glname a），否则容器内任意画廊链接
  const named = $c.find('td.gl3c a[href*="/g/"], .glname a[href*="/g/"]').first();
  if (named.length) href = String(named.attr('href') || '');
  if (!href) {
    $c.find(linkSel).each((_, a) => {
      if (!href && galleryIdsFrom($(a).attr('href'))) href = String($(a).attr('href'));
    });
  }
  if (!href && $c.is('a[href]')) href = String($c.attr('href') || '');

  let ids = galleryIdsFrom(href);
  if (!ids) {
    // 兜底：容器里没有画廊链接时，从 gallerytorrents.php?gid=..&t=.. 或 posted_<gid> 里抠
    const raw = String($c.html() || '');
    const t = raw.match(/gallerytorrents\.php\?gid=(\d+)&(?:amp;)?t=([0-9a-z]+)/i);
    if (t) ids = { gid: t[1], token: t[2] };
    if (!ids) {
      const p = raw.match(/posted(?:_|pop_)(\d+)/i);
      if (p) ids = { gid: p[1], token: '' }; // 只有 gid，token 交给 gdata 补
    }
  }
  if (!ids) return null;

  const url = href ? absUrl(href, base) : galleryUrl(ids.gid, ids.token, base);

  // 标题：新版 .glink；经典卡片也在 .glink 里；兜底用 alt / 链接文本
  let title = firstText($, $c, ['.glink', '.glname a', 'a[href*="/g/"] .glink']);
  if (!title) title = firstText($, $c, ['img[alt]']);
  if (!title) {
    const alt = firstAttr($, $c, ['img[alt]'], 'alt');
    if (alt) title = alt;
  }
  if (!title) title = firstText($, $c, ['a[href*="/g/"]']);
  // 兜底：整个容器就是一个 <a>（排行榜 / toplist 的 <div class="tun"><a>标题</a></div> 被当成容器时）
  if (!title && $c.is && $c.is('a')) {
    title = String($c.text() || '').replace(/\s+/g, ' ').trim() || String($c.attr('title') || '').trim();
  }

  // 分类
  const category = firstText($, $c, ['td.gl1c .cn', 'td.gl1c .cs', '.cn', '.cs', '.glcat']);

  // 发布时间：新版是 [id^=posted_]，经典卡片是 .gt.t5
  let posted = firstText($, $c, ['[id^="posted_"]', '[id^="postedpop_"]', '.gt.t5', '.gl2t']);
  if (!posted) posted = firstAttr($, $c, ['.gt.t5'], 'title');

  // 上传者：新版 td.gl4c 里的 /uploader/ 链接，经典卡片 .gt.t3
  let uploader = firstText($, $c, ['a[href*="/uploader/"]', '.gt.t3']);
  if (!uploader) uploader = firstAttr($, $c, ['.gt.t3'], 'title');
  uploader = uploader.replace(/^uploader:/i, '').trim();

  // 评分：表格布局有的版本给 td.gl5c（文字/星星），否则只有 .ir 星级图（无法可靠反推 → null）
  let rating = null;
  const gl5 = firstText($, $c, ['td.gl5c']);
  if (gl5) {
    const g5 = gl5.match(/(\d+(?:\.\d+)?)/);
    if (g5 && Number(g5[1]) <= 5) rating = Number(g5[1]);
  }
  if (rating === null) {
    const ratingAttr = firstAttr($, $c, ['[data-rating]'], 'data-rating');
    if (ratingAttr && /^\d+(\.\d+)?$/.test(ratingAttr)) rating = Number(ratingAttr);
  }
  if (rating === null) {
    const ratingText = firstText($, $c, ['.ir[title]', '[title*="Rating"]']);
    const rm = ratingText.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*5|stars?)/i);
    if (rm) rating = Number(rm[1]);
  }

  // 页数："25 pages" 在 td.gl4c 或 .gl2c 里
  const scopeText = $c.text().replace(/\s+/g, ' ');
  // 注意：.text() 不带分隔符，会把上传者名尾部的数字并进来（TMDlixin250 + '37 pages' → 25037）
  const pm = scopeText.match(/(?<![0-9A-Za-z])(\d{1,5})\s*pages?\b/i);
  const pages = pm ? Number(pm[1]) : null;

  // 缩略图：懒加载时真地址在 data-src，src 是 base64 gif
  let thumb = firstAttr($, $c, ['img[data-src]'], 'data-src');
  if (!thumb) {
    $c.find('img[src]').each((_, img) => {
      if (thumb) return;
      const src = String($(img).attr('src') || '');
      if (isPlaceholderSrc(src)) return;
      if (/ehgt\.org\/g\//i.test(src)) return; // 站内小图标（种子/评分等）
      thumb = src;
    });
  }
  if (!thumb) thumb = cssUrl(firstAttr($, $c, ['div[style*="url("]'], 'style'));
  thumb = thumb ? absUrl(thumb, base) : '';

  // 标签预览：.gt 里的前几个；t5=日期、t3=上传者 要排除
  const tagsPreview = [];
  $c.find('.gt').each((_, gt) => {
    const $g = $(gt);
    if ($g.hasClass('t5') || $g.hasClass('t3')) return;
    if (tagsPreview.length >= 6) return;
    const t = String($g.attr('title') || $g.text() || '').replace(/\s+/g, ' ').trim();
    if (t && !tagsPreview.includes(t)) tagsPreview.push(t);
  });

  return {
    gid: ids.gid,
    token: ids.token,
    url,
    title: title.replace(/\s+/g, ' ').trim(),
    category,
    posted,
    uploader,
    rating,
    pages,
    thumb,
    tagsPreview,
  };
}

/**
 * 解析列表页（首页 / 搜索 / 热门 / 收藏 / watched 通用）。
 * @returns {GalleryListItem[]} 数组上挂 .warnings
 */
export function parseGalleryList(html, { base = DEFAULT_BASE } = {}) {
  const warnings = [];
  const items = [];
  const seen = new Set();

  if (typeof html !== 'string' || !html.trim()) {
    warnings.push('列表页 HTML 为空');
    return attachWarnings(items, warnings);
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    warnings.push(`HTML 解析失败: ${e.message}`);
    return attachWarnings(items, warnings);
  }

  // 站点现在默认给表格布局（table.itg.gltc，每行一个画廊），先吃它；
  // 老布局/镜像还有 .itg.gld .gl1t 卡片，再退回卡片；最后兜底扫链接。
  // 防止把详情页当列表页吃：详情页没有 .itg 列表，只有 #gn
  if (!$('.itg').length && $('#gn').length) {
    warnings.push('这看起来是详情页（有 #gn、无 .itg 列表），不是列表页');
    return attachWarnings(items, warnings);
  }

  let containers = $('.itg tr, table.itg tr').filter(
    (_, tr) => $(tr).find('td.gl3c a[href*="/g/"], a[href*="/g/"]').length > 0
  );
  if (!containers.length) containers = $('.itg .gl1t, .itg.gld .gl1t');
  if (!containers.length) {
    containers = $('a[href*="/g/"]').filter((_, a) => !!galleryIdsFrom($(a).attr('href')));
    if (containers.length) warnings.push('未匹配到列表行 / .gl1t，退化为按链接解析');
  }

  if (!containers.length) {
    warnings.push('列表页没有找到任何条目（可能被登录墙/反爬拦截）');
    return attachWarnings(items, warnings);
  }

  containers.each((_, el) => {
    const item = parseItem($, el, base);
    if (!item) return;
    const key = `${item.gid}/${item.token}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  });

  if (!items.length) warnings.push('列表容器存在但没解析出条目，选择器可能需要更新');
  if (items.length && items.every((i) => i.rating === null)) {
    warnings.push('列表页无文字评分，rating 一律为 null（星级图无法可靠反推）');
  }
  if (items.length && items.some((i) => !i.title)) warnings.push('部分条目缺标题');

  return attachWarnings(items, warnings);
}

/* ------------------------------------------------------------------ */
/* 分页链接（列表页尾）                                                */
/* ------------------------------------------------------------------ */

/**
 * 读列表页尾的翻页链接。
 * 站点现在用 `#unext`（普通）与 `#unext2`（某些布局）表示下一页，`#uprev` 是上一页。
 * @returns {{next: string, prev: string}} 拿不到的给空串
 */
export function parseNextPage(html, { base = DEFAULT_BASE } = {}) {
  const empty = { next: '', prev: '' };
  if (typeof html !== 'string' || !html.trim()) return empty;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return empty;
  }

  const hrefOf = (sel) => {
    const v = $(sel).first().attr('href');
    return v ? absUrl(v, base) : '';
  };

  let next = hrefOf('#unext') || hrefOf('#unext2');
  const prev = hrefOf('#uprev');

  // 兜底：分页条 table.ptt 里最后一个可点链接
  if (!next) {
    const links = $('table.ptt a[href]');
    if (links.length) {
      const last = links.last().attr('href');
      const txt = links.last().text().trim();
      if (last && (txt === '>' || txt === '›' || /next/i.test(txt))) next = absUrl(last, base);
    }
  }

  return { next, prev };
}

/* ------------------------------------------------------------------ */
/* 标签解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析 #taglist。
 * 实际结构：<tr><td class="tc">artist:</td><td><div class="gtl"><a>val</a></div>…</td></tr>
 * （契约写的 div.tc 不存在，值在 td 内的 div.gtl a 里；ns 文本带尾冒号）
 * @returns {{[namespace: string]: string[]}} 对象上挂 .warnings（不可枚举）
 */
export function parseTags(html) {
  const warnings = [];
  const tags = {};

  if (typeof html !== 'string' || !html.trim()) {
    warnings.push('标签页 HTML 为空');
    return attachHiddenWarnings(tags, warnings);
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    warnings.push(`HTML 解析失败: ${e.message}`);
    return attachHiddenWarnings(tags, warnings);
  }

  const rows = $('#taglist tr');
  if (!rows.length) {
    warnings.push('#taglist 不存在（可能未登录或页面结构变化）');
    return attachHiddenWarnings(tags, warnings);
  }

  let emptyNsRows = 0;

  rows.each((_, tr) => {
    const $tr = $(tr);
    let ns = $tr.find('td.tc').first().text().replace(/\s+/g, ' ').trim();
    ns = ns.replace(/[:：]\s*$/, '').toLowerCase();

    // 取值：优先 div.gtl a（当前结构），再退到 div.tc a / 除 tc 外的 td 里的链接
    let vals = $tr
      .find('div.gtl a, div.tc a')
      .map((_, a) => $(a).text().replace(/\s+/g, ' ').trim())
      .get();
    if (!vals.length) {
      vals = $tr
        .find('td')
        .not('.tc')
        .find('a')
        .map((_, a) => $(a).text().replace(/\s+/g, ' ').trim())
        .get();
    }
    vals = vals.filter(Boolean);
    if (!vals.length) return; // 空行跳过（表头之类）

    if (!ns) {
      // td.tc 为空的项：并入 other（有 language 时优先并到 language）
      emptyNsRows += 1;
      const target = Array.isArray(tags.other) || !Array.isArray(tags.language) ? 'other' : 'language';
      tags[target] = tags[target] || [];
      for (const v of vals) if (!tags[target].includes(v)) tags[target].push(v);
      return;
    }

    tags[ns] = tags[ns] || [];
    for (const v of vals) if (!tags[ns].includes(v)) tags[ns].push(v);
  });

  if (emptyNsRows) warnings.push(`${emptyNsRows} 行标签没有 namespace，已并入 other/language`);
  if (!Object.keys(tags).length) warnings.push('#taglist 有行但没有取到标签值');

  return attachHiddenWarnings(tags, warnings);
}

/* ------------------------------------------------------------------ */
/* 详情页解析                                                          */
/* ------------------------------------------------------------------ */

/** 把 #gdd 的 label/value 表格读成 map（大小写与冒号不敏感） */
function readInfoTable($) {
  const map = {};
  $('#gdd tr, #gd3 table tr').each((_, tr) => {
    const $tr = $(tr);
    const label = $tr.find('td.gdt1, td').first().text().replace(/[:：]\s*$/, '').trim().toLowerCase();
    const value = $tr.find('td.gdt2, td').eq(1).text().replace(/\s+/g, ' ').trim();
    if (label && value && !(label in map)) map[label] = value;
  });
  return map;
}

/**
 * 解析详情页。
 * @returns {GalleryDetail|null} 页面上连标题都拿不到时返回 null
 */
export function parseGalleryDetail(html, { base = DEFAULT_BASE, gid: wantGid = null, token: wantToken = null } = {}) {
  const warnings = [];

  if (typeof html !== 'string' || !html.trim()) {
    warnings.push('详情页 HTML 为空');
    return null;
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    warnings.push(`HTML 解析失败: ${e.message}`);
    return null;
  }

  const title = $('#gn').first().text().replace(/\s+/g, ' ').trim();
  let jtitle = $('#gj').first().text().replace(/\s+/g, ' ').trim();
  if (!title && !jtitle) {
    warnings.push('详情页没有 #gn/#gj，判定为无效页面');
    return null;
  }
  if (!jtitle) warnings.push('#gj（日文标题）缺失');

  // gid/token：优先 canonical，其次页面里任意画廊链接
  let ids = null;
  // 调用方已经知道 gid/token 时以它为准：页面里的 /g/ 链接可能是 Parent/续作，会把 id 带跑偏
  if (wantGid && wantToken) ids = { gid: String(wantGid), token: String(wantToken) };
  const canonical = ids ? null : $('link[rel=canonical]').attr('href');
  if (canonical) ids = galleryIdsFrom(canonical);
  if (!ids) {
    $('a[href*="/g/"], link[rel="canonical"]').each((_, el) => {
      if (ids) return;
      ids = galleryIdsFrom($(el).attr('href'));
    });
  }
  if (!ids) {
    // 最后从整页文本里兜（archiver / report 链接里都带）
    ids = galleryIdsFrom(html.match(/\/g\/\d+\/[0-9a-z]+/i)?.[0] || '');
  }
  if (!ids) warnings.push('未能从详情页提取 gid/token');

  const gid = ids?.gid || '';
  const token = ids?.token || '';
  const url = gid && token ? galleryUrl(gid, token, base) : '';

  // 分类
  let category = firstText($, ['#gdc .cs', '#gdc .cn', '#gdc']);
  if (!category) warnings.push('#gdc 分类缺失');

  // 信息表（Posted / Parent / Visible / Language / File Size / Length / Favorited）
  const info = readInfoTable($);
  if (!Object.keys(info).length) warnings.push('#gdd 信息表缺失');

  const posted = info.posted || firstText($, ['#gdd .gdt2', '#gdd'])?.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/)?.[0] || '';

  // 上传者
  const uploader = firstText($, ['#gdn a[href*="/uploader/"]', '#gdn a']);
  const uploaderUrl = absUrl(firstAttr($, ['#gdn a[href*="/uploader/"]'], 'href'), base);
  if (!uploader) warnings.push('#gdn 上传者缺失');

  // 评分
  let rating = null;
  const ratingLabel = firstText($, ['#rating_label']);
  if (ratingLabel) {
    const rm = ratingLabel.match(/(\d+(?:\.\d+)?)/);
    if (rm) rating = Number(rm[1]);
    else if (/not yet rated|no rating/i.test(ratingLabel)) rating = null;
  } else {
    warnings.push('#rating_label 缺失，rating 为 null');
  }

  // 页数 / 体积
  let pages = null;
  const lenText = info['length'] || firstText($, ['#gdn', '#gdd']);
  const pm = String(lenText || '').match(/(?<![0-9A-Za-z])(\d{1,5})\s*pages?/i);
  if (pm) pages = Number(pm[1]);
  if (pages === null) {
    const gp = firstText($, ['p.gpc']);
    const pm2 = gp.match(/\d+\s*-\s*\d+\s+of\s+(\d+)/i);
    if (pm2) pages = Number(pm2[1]);
  }
  if (pages === null) warnings.push('未能取到页数');

  let size = info['file size'] || firstText($, ['#gds']);
  if (!size) warnings.push('#gds / File Size 缺失');

  // 收藏状态
  let favorite = null;
  const favLinkText = firstText($, ['#favoritelink', '#fav a']).replace(/\s+/g, ' ').trim();
  const favHref = firstAttr($, ['#fav a[href]', '#favoritelink[href]'], 'href');
  const favOnclick = firstAttr($, ['#fav a[onclick]', '#favoritelink'], 'onclick');
  const slotMatch = `${favHref} ${favOnclick} ${favLinkText}`.match(/fav=(\d+)/i);
  if (slotMatch) {
    favorite = { name: favLinkText.replace(/^.*?:\s*/, '') || '', slot: Number(slotMatch[1]) };
  } else if (/add to favorites/i.test(favLinkText) || !favLinkText) {
    if (!favLinkText) warnings.push('收藏区为空（未登录时不显示收藏夹名）');
    favorite = null;
  } else {
    favorite = { name: favLinkText, slot: null };
  }

  // 缩略图：新版是 #gdt 里 a > div 的 CSS 背景；也兼容 #gdt a img
  let thumb = '';
  $('#gdt a img[src]').each((_, img) => {
    if (thumb) return;
    const src = String($(img).attr('src') || '');
    if (!isPlaceholderSrc(src)) thumb = src;
  });
  if (!thumb) thumb = cssUrl(firstAttr($, ['#gdt a div[style*="url("]', '#gdt div[style*="url("]'], 'style'));
  if (!thumb) thumb = cssUrl(firstAttr($, ['#gleft div[style*="url("]', '#gd1 div[style*="url("]'], 'style'));
  if (!thumb) warnings.push('未能取到缩略图');
  thumb = thumb ? absUrl(thumb, base) : '';

  // 归档下载：新版放在 onclick="popUp('.../archiver.php?...')" 里
  let archiverUrl = '';
  const archOnclick = firstAttr($, ['#gd5 a[onclick*="archiver"]'], 'onclick');
  if (archOnclick) archiverUrl = String(archOnclick).match(/https?:\/\/[^'"]*archiver\.php[^'"]*/i)?.[0] || '';
  if (!archiverUrl) archiverUrl = absUrl(firstAttr($, ['#gd5 a[href*="archiver"]'], 'href'), base);
  if (archiverUrl) archiverUrl = archiverUrl.replace(/&amp;/g, '&');
  if (!archiverUrl) warnings.push('#gd5 未找到归档下载链接');

  // 种子：旧布局把种子表放在 #gd4（表头为 name/size/posted），新布局 #gd4 是标签区，
  // 入口在 #gd5 的 onclick 里（数量写作 "(N)"）。两种都试，拿不到就留空 + warnings。
  const torrents = [];
  const $gd4 = $('#gd4');
  const gd4IsTagArea = $gd4.find('#taglist, .gt, td.tc').length > 0;
  if ($gd4.length && !gd4IsTagArea) {
    $gd4.find('tr').each((_, tr) => {
      const $tr = $(tr);
      const cells = $tr.find('td');
      if (cells.length < 2) return;
      const name = cells.first().text().replace(/\s+/g, ' ').trim();
      if (!name || /^name$/i.test(name)) return; // 跳过表头
      const a = $tr.find('a[href*=".torrent"], a[href*="torrent"]').first();
      const href = a.attr('href');
      torrents.push({ name, url: href ? absUrl(href, base) : '' });
    });
    if (!torrents.length) {
      // 有的页面只有一行 "No torrents found"
      const onlyText = $gd4.text().replace(/\s+/g, ' ').trim();
      if (onlyText && !/no torrents/i.test(onlyText)) warnings.push('#gd4 里没解析出种子行');
    }
  }

  const torrentText = firstText($, ['#gd5 a[onclick*="gallerytorrents"]', '#gd5 a[href*="gallerytorrents"]']);
  const torrentUrl = absUrl(
    firstAttr($, ['#gd5 a[href*="gallerytorrents"]'], 'href') ||
      (firstAttr($, ['#gd5 a[onclick*="gallerytorrents"]'], 'onclick') || '').match(/https?:\/\/[^'"]*gallerytorrents\.php[^'"]*/i)?.[0] ||
      '',
    base
  );
  const tcount = torrentText.match(/\((\d+)\)/)?.[1];
  if (!torrents.length && tcount && Number(tcount) > 0) {
    warnings.push(`详情页有 ${tcount} 个种子，列表需另请求 ${torrentUrl || 'gallerytorrents.php'}`);
  }

  // parent：旧布局是 #gnd（"This gallery is a parent of ..."），新布局在 #gdd 的 Parent 行
  let parent = null;
  const gndHtml = String($('#gnd').html() || '');
  const gndIds = galleryIdsFrom(gndHtml);
  const parentText = (info.parent || $('#gnd').text() || '').replace(/\s+/g, ' ').trim();
  if (gndIds) {
    parent = galleryUrl(gndIds.gid, gndIds.token, base);
  } else if (parentText && !/^none$/i.test(parentText)) {
    const pids = galleryIdsFrom(parentText);
    parent = pids ? galleryUrl(pids.gid, pids.token, base) : parentText;
  }

  // visible
  let visible = null;
  const visText = (info.visible || '').trim().toLowerCase();
  if (visText === 'yes' || visText === 'no') visible = visText === 'yes';
  else warnings.push('Visible 字段缺失或无法识别');

  const language = (info.language || '').trim();

  // 标签
  const tags = parseTags(html);
  const tagNs = Object.keys(tags);
  if (!tagNs.length) warnings.push('详情页没有取到标签');
  for (const w of tags.warnings || []) warnings.push(w);

  return {
    gid,
    token,
    url,
    title,
    jtitle,
    category,
    posted,
    uploader,
    uploaderUrl,
    rating,
    pages,
    size,
    favorite,
    tags,
    thumb,
    archiverUrl,
    torrents,
    parent,
    visible,
    language,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* warnings 挂载 + 自检                                                */
/* ------------------------------------------------------------------ */

/** 数组上挂 warnings（非索引属性，JSON 序列化不会带上） */
function attachWarnings(arr, warnings) {
  Object.defineProperty(arr, 'warnings', { value: warnings, enumerable: false, configurable: true });
  return arr;
}

/** 普通对象上挂不可枚举 warnings，避免污染 tags 的 namespace 键 */
function attachHiddenWarnings(obj, warnings) {
  Object.defineProperty(obj, 'warnings', { value: warnings, enumerable: false, configurable: true });
  return obj;
}

/**
 * 模块自检：优先跑 test/fixtures 下的离线快照；没有快照就只验证纯函数。
 * 不发网络请求。
 */
export async function __selftest() {
  const out = { module: 'gallery', ok: true, checks: [], warnings: [] };
  try {
    const url = galleryUrl(123, 'abc123', 'https://e-hentai.org');
    out.checks.push(['galleryUrl', url === 'https://e-hentai.org/g/123/abc123/']);
    const su = buildSearchUrl({ base: 'https://e-hentai.org' }, { query: 'a b&c', page: 2, category: ['manga', 'nonh'] });
    out.checks.push(['buildSearchUrl', su.includes('f_search=a%20b%26c') && su.includes('page=2') && su.includes('f_cats=260')]);

    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
    for (const [file, kind] of [
      ['home.html', 'list'],
      ['detail.html', 'detail'],
    ]) {
      const p = path.join(dir, file);
      if (!existsSync(p)) {
        out.warnings.push(`缺少 fixture ${file}，跳过`);
        continue;
      }
      const html = readFileSync(p, 'utf8');
      if (kind === 'list') {
        const items = parseGalleryList(html, { base: 'https://e-hentai.org' });
        out.checks.push([`parseGalleryList(${file})`, items.length > 0, `items=${items.length}`]);
        out.facts = { ...(out.facts || {}), listCount: items.length, firstTitle: items[0]?.title };
      } else {
        const d = parseGalleryDetail(html, { base: 'https://e-hentai.org' });
        out.checks.push([`parseGalleryDetail(${file})`, !!d, d ? `title=${d.title}` : 'null']);
        out.facts = { ...(out.facts || {}), detailTitle: d?.title, tags: d ? Object.keys(d.tags) : [] };
      }
    }
  } catch (e) {
    out.ok = false;
    out.warnings.push(`自检异常: ${e.message}`);
  }
  out.ok = out.ok && out.checks.every(([, pass]) => pass === true || pass === undefined ? true : !!pass);
  return out;
}

/* ------------------------------------------------------------------ */
/* 评论区（详情页 #cdiv）                                               */
/* ------------------------------------------------------------------ */

/**
 * 解析详情页评论区。结构：`#cdiv > a[name=c<id>] + div.c1`
 *   .c3  Posted on 08 November 2026, 16:00 by: <a>作者</a>
 *   .c5  Score <span>+10</span>
 *   .c6  id="comment_<id>" 正文
 *   .c7  投票明细（display:none）
 * @returns {{comments: Array<{id:number|null, at:string, author:string, score:string, text:string, votes:string}>, warnings: string[]}}
 */
export function parseComments(html) {
  const comments = [];
  const warnings = [];

  if (typeof html !== 'string' || !html.trim()) {
    warnings.push('详情页 HTML 为空');
    return { comments, warnings };
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    warnings.push(`HTML 解析失败: ${e.message}`);
    return { comments, warnings };
  }

  const box = $('#cdiv').first();
  if (!box.length) {
    warnings.push('#cdiv 不存在（这本没有评论，或页面结构变了）');
    return { comments, warnings };
  }

  box.find('div.c1').each((_, el) => {
    const $c = $(el);
    const textEl = $c.find('div.c6').first();
    const text = textEl.text().replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim();
    const idMatch = (textEl.attr('id') || '').match(/comment_(\d+)/);
    if (!text && !idMatch) return;

    const head = $c.find('div.c3').first().text().replace(/\s+/g, ' ').trim();
    const at = (head.match(/Posted on (.+?) by:/) || [])[1] || '';
    const author = $c.find('div.c3 a').first().text().trim();
    const score = $c.find('div.c5 span').first().text().trim();
    const votes = $c.find('div.c7').first().text().replace(/\s+/g, ' ').trim();

    comments.push({
      id: idMatch ? Number(idMatch[1]) : null,
      at: at.replace(/\s+/g, ' ').trim(),
      author,
      score,
      text,
      votes,
    });
  });

  if (!comments.length) warnings.push('评论区是空的');
  return { comments, warnings };
}

/**
 * 拉详情页并取评论（线上评论，不依赖是否下载过）。
 * @param {{gid:number|string, token:string, base?:string}} opts
 */
export async function galleryComments(client, { gid, token, base = DEFAULT_BASE }) {
  const url = galleryUrl(gid, token, base);
  const res = await client.get(url);
  const html = res?.text || '';
  const parsed = parseComments(html);
  // 同一次请求里顺手把标题捡出来，省得调用方再打一遍详情页
  const detail = parseGalleryDetail(html, { base, gid, token });
  return {
    url: res?.finalUrl || url,
    title: detail?.title || '',
    count: parsed.comments.length,
    comments: parsed.comments,
    warnings: [...(res?.warnings || []), ...parsed.warnings],
  };
}
