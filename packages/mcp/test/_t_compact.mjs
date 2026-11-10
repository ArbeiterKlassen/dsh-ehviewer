#!/usr/bin/env node
/**
 * 省 token 专项测试（离线，不联网）。
 *
 * 断言：
 *  1. 字段裁剪（默认字段集 / fields 覆盖）
 *  2. tsv 格式（表头 + 一行一条）
 *  3. limit / offset / hasMore / nextOffset
 *  4. null / 空串 / 空数组 省略（不是回 null）
 *  5. 复合工具存在 + 关键入参
 *  6. 所有工具 description ≤ 60 字
 *  7. 列表类工具都暴露 fields / format / limit / offset
 *  8. 高级搜索用站内真实字段名（f_sname / f_sdt1 / f_sfl …）
 *
 * 跑法：node test/_t_compact.mjs
 */

import process from 'node:process';
import { buildServer, TOOL_NAMES, __compact } from '../src/index.js';

const {
  packList, shapeItem, compact, toTsv, parseFields, flattenDetail, clampLimit, DEFAULTS,
} = __compact;

let failed = 0;
const check = (okFlag, label, detail = '') => {
  if (okFlag) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
/** zod schema → 字段名表（兼容 object / optional 包装） */
const shapeOf = (schema) => {
  if (!schema) return {};
  const d = schema.def || schema._def || {};
  if (d.type === 'object' && d.shape) return d.shape;
  if (d.innerType) return shapeOf(d.innerType);
  if (schema.shape) return schema.shape;
  return {};
};
const bodyOf = (res) => {
  try { return JSON.parse(res?.content?.[0]?.text || ''); } catch { return null; }
};
const textOf = (res) => res?.content?.[0]?.text || '';

/* 30 条假数据：页数/评分有的有有的没有，用来验裁剪与省略 */
const LIST = Array.from({ length: 30 }, (_, i) => ({
  gid: 1000 + i,
  token: `tok${String(i).padStart(8, '0')}`,
  title: `Gallery ${i}`,
  pages: i % 3 === 0 ? null : 20 + i,
  category: 'doujinshi',
  url: `https://e-hentai.org/g/${1000 + i}/tok${i}/`,
  thumb: 'https://ehgt.org/t/x.jpg',
  tagsPreview: ['a', 'b'],
}));

console.log(`eh-mcp compact · ${TOOL_NAMES.length} 个工具\n`);

// ① 字段裁剪
console.log('[1] 字段裁剪');
{
  const body = bodyOf(packList('eh_search', { site: 'exhentai', items: LIST }));
  check(body?.tool === 'eh_search', 'body.tool 存在', body?.tool);
  check(body?.site === 'exhentai', 'body.site 是实际站点', body?.site);
  check(body?.count === 10, '默认 limit=10', String(body?.count));
  check(body?.hasMore === true, 'hasMore 正确（30 条里只回 10）');
  check(body?.nextOffset === 10, 'nextOffset=10', String(body?.nextOffset));
  const keys = Object.keys(body.items[1]).sort().join(',');
  check(keys === 'category,gid,pages,title,token', `默认字段 = gid,token,title,pages,category（实际 ${keys}）`);
  check(!('pages' in body.items[0]), '本身没有 pages 的条目不会补 null');
  check(!('url' in body.items[0]) && !('thumb' in body.items[0]) && !('tagsPreview' in body.items[0]),
    '默认不带 url / thumb / tagsPreview');
  check(!('total' in body) && !('shown' in body), '旧外壳 total/shown 已去掉');
}
{
  const body = bodyOf(packList('eh_find', { site: 'e-hentai', items: LIST, fields: 'gid,title,rating' }));
  const keys = Object.keys(body.items[0]).sort().join(',');
  check(keys === 'gid,title', `fields 覆盖生效（实际 ${keys}）`);
}

// ② tsv
console.log('\n[2] tsv 格式');
{
  const res = packList('eh_search', { site: 'e-hentai', items: LIST.slice(0, 3), format: 'tsv' });
  const lines = textOf(res).split('\n');
  check(lines[0] === 'gid\ttoken\ttitle\tpages\tcategory', '首行是表头', lines[0]);
  check(lines.length === 4, `一行一条（3 条 + 表头，实际 ${lines.length} 行）`);
  check(lines[1].split('\t').length === 5, '列数与表头一致');
}
{
  const res = packList('eh_search', { items: [], format: 'tsv' });
  check(textOf(res) === 'gid\ttoken\ttitle\tpages\tcategory', '空列表只回表头', textOf(res));
}

// ③ limit / offset
console.log('\n[3] limit / offset');
{
  const body = bodyOf(packList('eh_recent', { site: 'e-hentai', items: LIST, limit: 5, offset: 25 }));
  check(body.count === 5, 'offset=25 取到 5 条', String(body.count));
  check(body.hasMore === false, '已经到底 hasMore=false');
  check(!('nextOffset' in body), '到底时不给 nextOffset');
  check(body.items[0].gid === 1025, 'offset 真的跳过了', String(body.items[0].gid));
}
{
  const body = bodyOf(packList('eh_recent', { items: LIST, limit: 999 }));
  check(body.count === LIST.length, 'limit 超过可用条数时全给（不会凭空造）', String(body.count));
  check(clampLimit(999) === 50, 'limit 上限收敛到 50', String(clampLimit(999)));
  check(clampLimit(0) === DEFAULTS.LIMIT_DEFAULT, 'limit=0 回落默认值');
}

// ④ null / 空串省略
console.log('\n[4] 空值省略');
{
  const shaped = shapeItem({ gid: 1, title: null, token: '', pages: 0, category: undefined }, ['gid', 'title', 'token', 'pages', 'category']);
  check(Object.keys(shaped).join(',') === 'gid,pages', `只留 gid,pages（实际 ${Object.keys(shaped).join(',')}）`);
  check(shaped.pages === 0, '0 不当空值丢掉');
  const c = compact({ a: null, b: '', c: [], d: {}, e: 0, f: false, g: 'x' });
  check(Object.keys(c).join(',') === 'e,f,g', `compact 去掉空壳（实际 ${Object.keys(c).join(',')}）`);
}
{
  const body = bodyOf(packList('eh_popular', { items: LIST.slice(0, 2), warnings: [] }));
  check(!('warnings' in body), 'warnings 为空时不出现');
  const body2 = bodyOf(packList('eh_popular', { items: LIST.slice(0, 2), warnings: ['w1'] }));
  check(Array.isArray(body2?.warnings) && body2.warnings[0] === 'w1', 'warnings 非空才出现');
}

// ⑤ 详情拍平
console.log('\n[5] 详情拍平');
{
  const flat = flattenDetail({
    gid: 7, token: 'abc', title: 'T', category: 'manga', pages: 42, size: '1.2 GB',
    rating: 4.5, language: 'chinese', favorite: { slot: 3, name: 'faves' },
    tags: { female: ['a', 'b'], male: ['c'] }, warnings: ['w'],
  });
  check(flat.tagsCount === 3, 'tags 折成 tagsCount', String(flat.tagsCount));
  check(flat.favorite === 3, 'favorite 只留槽位号', String(flat.favorite));
  check(!('tags' in flat), '默认不带完整 tags');
  check('tags' in flattenDetail({ tags: { female: ['a'] } }, { full: true }), 'full=true 才带 tags');
}

// ⑥ 复合工具 + 工具面
console.log('\n[6] 工具面');
const { server, toolNames } = await buildServer();
const tools = server._registeredTools || {};
for (const name of ['eh_find', 'eh_open', 'eh_read', 'eh_quick', 'eh_image_search']) {
  check(Boolean(tools[name]), `${name} 已注册`);
}
check(Object.keys(shapeOf(tools['eh_find'].inputSchema)).includes('query'), 'eh_find 入参有 query');
check(Object.keys(shapeOf(tools['eh_open'].inputSchema)).includes('pages'), 'eh_open 入参有 pages');
check(Object.keys(shapeOf(tools['eh_read'].inputSchema)).includes('count'), 'eh_read 入参有 count');
check(Object.keys(shapeOf(tools['eh_gallery'].inputSchema)).includes('full'), 'eh_gallery 有 full');

const LIST_TOOLS = [
  'eh_search', 'eh_find', 'eh_popular', 'eh_recent', 'eh_watched', 'eh_favorites',
  'eh_toplists', 'eh_uploader', 'eh_tag_page', 'eh_batch_meta', 'eh_history', 'eh_pages',
];
const missing = [];
for (const name of LIST_TOOLS) {
  const ks = Object.keys(shapeOf(tools[name]?.inputSchema));
  if (!['fields', 'format', 'limit', 'offset'].every((k) => ks.includes(k))) missing.push(name);
}
check(missing.length === 0, '列表类工具都支持 fields/format/limit/offset', missing.join(','));

// ⑦ description 长度
console.log('\n[7] description 长度');
const longDesc = Object.entries(tools)
  .filter(([, t]) => String(t.description || '').length > 60)
  .map(([n, t]) => `${n}(${t.description.length})`);
check(longDesc.length === 0, '全部 ≤60 字', longDesc.join(' '));

// ⑧ 高级搜索字段
console.log('\n[8] 高级搜索字段');
const advKeys = Object.keys(shapeOf(shapeOf(tools['eh_search'].inputSchema).adv));
for (const k of ['name', 'tags', 'desc', 'torrentName', 'withTorrents', 'expunged', 'lowPower', 'downvoted', 'disableLang', 'disableUploader', 'disableTags']) {
  check(advKeys.includes(k), `adv.${k}`);
}
check(advKeys.includes('torr') && advKeys.includes('del') && advKeys.includes('exp'), '旧名保留为别名');

console.log('');
if (failed === 0) {
  console.log(`COMPACT OK — ${toolNames.length} 个工具，省 token 约定全部成立。`);
  process.exit(0);
} else {
  console.log(`COMPACT FAILED — ${failed} 项没通过。`);
  process.exit(1);
}
