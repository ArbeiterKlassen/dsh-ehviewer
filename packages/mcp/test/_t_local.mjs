// 本地下载库索引的离线验证：不联网，全部在临时目录里造假画廊。
// 覆盖：meta v2 / v1 / account 子目录、增量重建、关键词、缩写、全称、正则、
//       排除、OR、非法正则降级、排序、分页、统计，外加 500 条压测。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'eh-local-index-'));
process.env.EH_LIBRARY_PATH = join(TMP, 'library.json');

const {
  scanLibrary,
  rebuildIndex,
  loadIndex,
  indexStats,
  search,
  parseQuery,
  matchEntry,
  indexPath,
  __selftest,
} = await import('../src/local-index.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  → ${detail}` : ''}`);
}
const json = (v) => JSON.stringify(v);

/* ---------- 0. 造假画廊 ---------- */
const root = join(TMP, 'library');
const dirA = join(root, 'aaa');
const dirB = join(root, 'bbb');
const dirC = join(root, 'acc1', 'ccc');
for (const d of [dirA, dirB, dirC]) mkdirSync(d, { recursive: true });

// v2：pages[] 带 bytes，tag 走 gallery.tags（贴 download.js 落盘的真实形状）
writeFileSync(
  join(dirA, 'meta.json'),
  json({
    version: 2,
    gid: 101,
    token: 'aaaaaaaaaa',
    title: 'Tentacle Garden',
    site: 'e-hentai',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
    total: 2,
    pages: [
      { index: 1, url: 'u1', file: '001.webp', bytes: 1000, status: 'downloaded' },
      { index: 2, url: 'u2', file: '002.webp', bytes: 2000, status: 'downloaded' },
    ],
    gallery: { gid: 101, token: 'aaaaaaaaaa', title: 'Tentacle Garden', category: 'Doujinshi', uploader: 'alice', tags: { female: ['tentacles'] } },
  }),
);

// v1：gallery + images，没有 finishedAt（downloadedAt 退回 meta 的 mtime）
writeFileSync(
  join(dirB, 'meta.json'),
  json({
    gallery: {
      gid: 202,
      token: 'bbbbbbbbbb',
      title: 'Loli Tentacle',
      url: 'https://e-hentai.org/g/202/bbbbbbbbbb/',
      category: 'Manga',
      pages: 3,
      uploader: 'bob',
      tags: { female: ['lolicon', 'tentacles'] },
    },
    images: [
      { index: 1, bytes: 500, status: 'downloaded' },
      { index: 2, bytes: 500, status: 'downloaded' },
      { index: 3, bytes: 500, status: 'downloaded' },
    ],
  }),
);

// v2 + account 子目录 + 日文标题 + 数组形式 tag
writeFileSync(
  join(dirC, 'meta.json'),
  json({
    version: 2,
    gid: 303,
    token: 'cccccccccc',
    title: '巨乳与触手',
    titleJpn: '巨乳と触手',
    site: 'exhentai',
    finishedAt: '2026-03-01T00:00:00.000Z',
    total: 5,
    pages: [1, 2, 3, 4, 5].map((i) => ({ index: i, url: `u${i}`, file: `00${i}.webp`, bytes: 1000, status: 'downloaded' })),
    tags: ['female:big breasts', 'f:tentacles'],
    category: 'Doujinshi',
    uploader: 'carol',
  }),
);
// 固定 v1 那本的 mtime，downloadedAt 才有确定值
utimesSync(join(dirB, 'meta.json'), new Date('2026-02-02T00:00:00Z'), new Date('2026-02-02T00:00:00Z'));

/* ---------- 1. 扫描 ---------- */
const scan1 = await scanLibrary({ root });
check('scanLibrary 找到 3 本', scan1.entries.length === 3, `len=${scan1.entries.length}`);
check('无 warning', scan1.warnings.length === 0, json(scan1.warnings));
const byGid = Object.fromEntries(scan1.entries.map((e) => [e.gid, e]));
check(
  'v2 pages/bytes 归一',
  byGid[101].pages === 2 && byGid[101].sizeBytes === 3000,
  json({ p: byGid[101].pages, s: byGid[101].sizeBytes }),
);
check(
  'v1 images 归一',
  byGid[202].pages === 3 && byGid[202].sizeBytes === 1500,
  json({ p: byGid[202].pages, s: byGid[202].sizeBytes }),
);
check('v1 title/uploader 兜底', byGid[202].title === 'Loli Tentacle' && byGid[202].uploader === 'bob');
check('v1 没 finishedAt → 用 mtime', String(byGid[202].downloadedAt || '').startsWith('2026-02-02'), byGid[202].downloadedAt);
check('site 从 v1 url 补', byGid[202].site === 'https://e-hentai.org', byGid[202].site);
check(
  '数组形式 tag + 缩写归一',
  byGid[303].tags.includes('female:big breasts') && byGid[303].tags.includes('female:tentacles') && byGid[303].tags.length === 2,
  json(byGid[303].tags),
);
check('tagMap 分命名空间', json(byGid[303].tagMap.female) === json(['big breasts', 'tentacles']), json(byGid[303].tagMap));
check('account 取自目录层', byGid[303].account === 'acc1' && byGid[101].account === null, json({ c: byGid[303].account, a: byGid[101].account }));
check('titleJpn 保留', byGid[303].titleJpn === '巨乳と触手', byGid[303].titleJpn);

/* ---------- 2. 增量重建 ---------- */
const r1 = await rebuildIndex({ root });
check('首次 rebuild added=3', r1.added === 3 && r1.total === 3 && r1.removed === 0, json(r1));
check('索引文件已写', r1.indexFile === indexPath() && statSync(r1.indexFile).size > 0, `${r1.indexFile} ${statSync(r1.indexFile).size}B`);

const r2 = await rebuildIndex({ root });
check('第二次 rebuild added=0 / updated=0', r2.added === 0 && r2.updated === 0 && r2.removed === 0 && r2.total === 3, json(r2));
check('第二次全部复用（没重读 meta）', r2.reused === 3 && r2.scanned === 0, json({ reused: r2.reused, scanned: r2.scanned }));

// 动一本：给 B 加一张图 → updated=1
const metaB = JSON.parse(readFileSync(join(dirB, 'meta.json'), 'utf8'));
metaB.images.push({ index: 4, bytes: 500, status: 'downloaded' });
writeFileSync(join(dirB, 'meta.json'), json(metaB));
const r3 = await rebuildIndex({ root });
check('改一本 → updated=1', r3.updated === 1 && r3.added === 0 && r3.total === 3, json(r3));
const r4 = await rebuildIndex({ root });
check('再跑一次回到全零', r4.added === 0 && r4.updated === 0 && r4.removed === 0, json(r4));

// 删一本 → removed=1
rmSync(dirA, { recursive: true, force: true });
const r5 = await rebuildIndex({ root });
check('删目录 → removed=1', r5.removed === 1 && r5.total === 2, json(r5));
const r6 = await rebuildIndex({ root });
check('重扫稳定', r6.total === 2 && r6.added === 0, json(r6));

// 换个目录名放回来（走一次全量解析，不命中旧缓存）
const dirA2 = join(root, 'ddd');
mkdirSync(dirA2, { recursive: true });
writeFileSync(
  join(dirA2, 'meta.json'),
  json({
    version: 2,
    gid: 101,
    token: 'aaaaaaaaaa',
    title: 'Tentacle Garden',
    finishedAt: '2026-01-01T10:05:00.000Z',
    total: 2,
    pages: [
      { index: 1, bytes: 1000, status: 'downloaded' },
      { index: 2, bytes: 2000, status: 'downloaded' },
    ],
    gallery: { category: 'Doujinshi', uploader: 'alice', tags: { female: ['tentacles'] } },
  }),
);
const r7 = await rebuildIndex({ root });
check('补回第三本', r7.total === 3 && r7.added === 1, json(r7));

/* ---------- 3. 搜索 ---------- */
const q = (s, o) => search(s, o);
const gids = (arr) => arr.map((i) => i.gid).sort();

check('loadIndex 可读', (await loadIndex())?.entries.length === 3);
check(
  '搜索结果字段精简',
  (() => {
    const one = q('tentacle')[0];
    return json(Object.keys(one).sort()) === json(['dir', 'gid', 'pages', 'tags', 'title', 'token']);
  })(),
  json(Object.keys(q('tentacle')[0]).sort()),
);

check('裸关键词 title 命中', json(gids(q('garden'))) === json([101]), json(gids(q('garden'))));
check('裸关键词 tag 命中 3 本', q('tentacle').length === 3, json(gids(q('tentacle'))));
check('裸关键词大小写不敏感', q('TENTACLE').length === 3);
check('裸关键词中文原样命中标题', json(gids(q('巨乳'))) === json([303]), json(gids(q('巨乳'))));
check('缩写 f:tentacles 命中 3 本', q('f:tentacles').length === 3, json(gids(q('f:tentacles'))));
check('全称 female:tentacles 命中 3 本', q('female:tentacles').length === 3, json(gids(q('female:tentacles'))));
check('带空格 tag（引号）精确命中', json(gids(q('female:"big breasts"'))) === json([303]), json(gids(q('female:"big breasts"'))));
check('正则 /tentacle/ 命中 3 本', q('/tentacle/').length === 3, json(gids(q('/tentacle/'))));
check('正则只打 tag：tag:/big breasts/', json(gids(q('tag:/big breasts/'))) === json([303]), json(gids(q('tag:/big breasts/'))));
check('正则忽略大小写 flags', q('/TENTACLE/i').length === 3);
check(
  '正则无效 → warning 不抛',
  (() => {
    try {
      const r = q('/(/');
      return r.length === 0 && Array.isArray(r.warnings) && r.warnings.length === 1 && /正则无效/.test(r.warnings[0]);
    } catch {
      return false;
    }
  })(),
);
check('排除 -loli', json(gids(q('tentacle -loli'))) === json([101, 303]), json(gids(q('tentacle -loli'))));
check('排除也认 tag（-lolicon）', json(gids(q('-lolicon'))) === json([101, 303]), json(gids(q('-lolicon'))));
check('OR：lolicon|"big breasts"', json(gids(q('lolicon|"big breasts"'))) === json([202, 303]), json(gids(q('lolicon|"big breasts"'))));
check('AND：tentacle 巨乳 → 只剩 1 本', json(gids(q('tentacle 巨乳'))) === json([303]), json(gids(q('tentacle 巨乳'))));
check('AND：f:tentacles f:lolicon → 1 本', json(gids(q('f:tentacles f:lolicon'))) === json([202]), json(gids(q('f:tentacles f:lolicon'))));

/* ---------- 4. 排序 / 分页 ---------- */
const sortPages = q('', { sort: 'pages', limit: 10 });
check('sort=pages 降序', json(sortPages.map((i) => i.pages)) === json([5, 4, 2]), json(sortPages.map((i) => i.pages)));
const sortSize = q('', { sort: 'size', limit: 10 });
check('sort=size 降序', json(sortSize.map((i) => i.gid)) === json([303, 101, 202]), json(sortSize.map((i) => i.gid)));
const sortTitle = q('', { sort: 'title', limit: 10 });
check(
  'sort=title 升序',
  sortTitle.every((x, i) => i === 0 || String(sortTitle[i - 1].title).localeCompare(String(x.title), 'zh') <= 0),
  json(sortTitle.map((i) => i.title)),
);
// 默认按 downloadedAt 降序：B 的 meta 刚被改写，mtime 最新，排在 303 前面
const sortDefault = q('', { limit: 10 });
check('默认 downloadedAt 降序', json(sortDefault.map((i) => i.gid)) === json([202, 303, 101]), json(sortDefault.map((i) => i.gid)));
const page1 = q('tentacle', { limit: 2, offset: 0 });
const page2 = q('tentacle', { limit: 2, offset: 2 });
check(
  'limit/offset 分页',
  page1.length === 2 && page2.length === 1 && page1.total === 3 && page1[0].gid !== page1[1].gid && page2[0].gid !== page1[0].gid && page2[0].gid !== page1[1].gid,
  json({ p1: gids(page1), p2: gids(page2), total: page1.total }),
);
check('offset 越界回空', q('tentacle', { limit: 2, offset: 99 }).length === 0);

/* ---------- 5. 统计 ---------- */
const st = indexStats();
check('indexStats 条数与体积', st.total === 3 && st.sizeBytes === 3000 + 2000 + 5000, json({ total: st.total, size: st.sizeBytes }));
check(
  'indexStats 分组',
  st.byAccount['(none)'] === 2 && st.byAccount.acc1 === 1 && st.byCategory.Doujinshi === 2 && st.byCategory.Manga === 1,
  json({ a: st.byAccount, c: st.byCategory }),
);
check('indexStats 有构建时间', typeof st.builtAt === 'string' && !Number.isNaN(Date.parse(st.builtAt)), st.builtAt);

/* ---------- 6. 解析/匹配纯函数 ---------- */
const pq = parseQuery('f:tentacles -loli /tentacle/ a|b');
check('parseQuery 4 个子句', pq.clauses.length === 4, json(pq.clauses.map((c) => c.type)));
check('parseQuery 缩写展开', pq.clauses[0].ns === 'female' && pq.clauses[0].value === 'tentacles');
check('parseQuery 排除 / 正则 / OR', pq.clauses[1].neg && pq.clauses[2].type === 'regex' && pq.clauses[3].alts.length === 2);
const fake = { gid: 1, token: 't', title: 'X', tags: ['female:tentacles'], pages: 1, sizeBytes: 1, dir: '/x' };
check(
  'matchEntry 纯函数可判定',
  matchEntry(fake, parseQuery('f:tentacles').clauses) === true && matchEntry(fake, parseQuery('f:lolicon').clauses) === false,
);

/* ---------- 7. 500 条压测 ---------- */
function synth(n) {
  const list = [];
  const cats = ['Doujinshi', 'Manga', 'Artist CG', 'Game CG'];
  for (let i = 0; i < n; i += 1) {
    const tags = ['female:big breasts', 'female:tentacles', 'female:sole female'];
    if (i % 3 === 0) tags.push('female:lolicon');
    if (i % 5 === 0) tags.push('language:chinese');
    list.push({
      gid: 1000 + i,
      token: `${i}`.padStart(10, 'a'),
      title: `Gallery ${i} ${i % 7 === 0 ? 'Tentacle' : 'Story'}`,
      titleJpn: `ギャラリー ${i}`,
      tags,
      tagMap: {},
      uploader: `user${i % 20}`,
      category: cats[i % cats.length],
      pages: 10 + (i % 90),
      sizeBytes: 1_000_000 + i * 1000,
      dir: `/lib/g${i}`,
      site: 'e-hentai',
      downloadedAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      account: i % 4 === 0 ? 'acc' : null,
    });
  }
  return list;
}
const big = synth(500);
function timeIt(fn, rounds = 50) {
  fn(); // 预热 JIT / 派生缓存
  const t0 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < rounds; i += 1) hits += fn().length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { avgMs: +(ms / rounds).toFixed(3), hits: hits / rounds };
}
const benchTag = timeIt(() => search('f:tentacles', { entries: big, limit: 50 }));
const benchAnd = timeIt(() => search('f:tentacles f:lolicon -language:chinese', { entries: big, limit: 50 }));
const benchRegex = timeIt(() => search('/tentacle/i tentacle', { entries: big, limit: 50 }));
console.log('[bench 500]', json({ tag: benchTag, and: benchAnd, regex: benchRegex }));

check('500 条 tag 查询 < 5ms', benchTag.avgMs < 5, `${benchTag.avgMs}ms`);
check('500 条 AND 查询 < 5ms', benchAnd.avgMs < 5, `${benchAnd.avgMs}ms`);
check('500 条正则查询 < 15ms', benchRegex.avgMs < 15, `${benchRegex.avgMs}ms`);
const allHit = search('f:tentacles', { entries: big, limit: 500 });
check('500 条全命中 / 分页切得动', allHit.length === 500 && allHit.total === 500 && benchTag.hits === 50, json({ total: allHit.total, returned: allHit.length }));

/* ---------- 8. 模块自检 ---------- */
const self = await __selftest();
check('__selftest 通过', self.ok, json(self.warnings));

/* ---------- 收尾 ---------- */
const sz = statSync(indexPath()).size;
console.log(`[index] ${indexPath()} ${sz}B  entries=3`);
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`PASS ${pass}/${fail}`);
rmSync(TMP, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
