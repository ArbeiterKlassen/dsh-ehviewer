// 收藏夹三件套自测：收藏内搜索 URL、收藏备注解析、fav.json 缓存、按账号下载目录。
// 全程不联网：HTTP 用 mock client，store 写临时目录。
// 跑法：node test/_t_fav.mjs   期望最后一行 PASS n/0
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  DEFAULTS,
  DEFAULT_DOWNLOAD_DIR,
  LEGACY_DEFAULT_DOWNLOAD_DIR,
  downloadDirWarnings,
  resolveDownloadDir,
} from '../src/config.js';
import { buildFavoritesUrl, favorites, favNotes, parseFavNotes } from '../src/browse.js';
import {
  __setDataDir,
  saveFavorites,
  loadFavorites,
  searchFavorites,
  stats,
} from '../src/store.js';

let total = 0;
let failed = 0;
const check = (name, cond, extra) => {
  total += 1;
  if (cond) return;
  failed += 1;
  console.log(`  FAIL ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
};

/* ------------------------------------------------------------------ */
/* mock client：只记 URL，返回预置 HTML                                 */
/* ------------------------------------------------------------------ */

function mockClient(html) {
  return {
    calls: [],
    async get(url) {
      this.calls.push(url);
      return { status: 200, text: html, headers: {}, finalUrl: url };
    },
  };
}

/** 表格布局（table.itg.gltc）的收藏页：第一本带备注 .glft，第二本没备注 */
const FAV_HTML = `<!DOCTYPE html><html><body>
<table class="itg gltc"><tbody>
<tr>
  <td class="gl1c glcat"><div class="cn ct1">Misc</div></td>
  <td class="gl2c"><a href="https://e-hentai.org/g/111/aaaa111111/"><img src="https://ehgt.org/t1.jpg" /></a></td>
  <td class="gl3c glname">
    <a href="https://e-hentai.org/g/111/aaaa111111/">
      <div class="glink">Alpha Archive</div>
      <div><div class="gt" title="female:sole female">f:sole female</div></div>
    </a>
    <div class="glft">我的备注 alpha</div>
  </td>
  <td class="gl4c glhide"><div><a href="https://e-hentai.org/uploader/u1">u1</a></div><div>20 pages</div></td>
</tr>
<tr>
  <td class="gl1c glcat"><div class="cn ct2">Doujinshi</div></td>
  <td class="gl2c"><a href="https://e-hentai.org/g/222/bbbb222222/"><img src="https://ehgt.org/t2.jpg" /></a></td>
  <td class="gl3c glname">
    <a href="https://e-hentai.org/g/222/bbbb222222/"><div class="glink">Beta Book</div></a>
  </td>
  <td class="gl4c glhide"><div><a href="https://e-hentai.org/uploader/u2">u2</a></div><div>30 pages</div></td>
</tr>
</tbody></table>
</body></html>`;

const NO_NOTE_HTML = `<!DOCTYPE html><html><body>
<div class="itg gld">
  <div class="gl1t"><div class="gl2c"><a href="https://e-hentai.org/g/333/cccc333333/"><img src="x" /></a></div></div>
</div>
</body></html>`;

/* ------------------------------------------------------------------ */
/* 1. 默认下载路径 + resolveDownloadDir                                */
/* ------------------------------------------------------------------ */

check('默认路径含 .dsh/eh-downloads', DEFAULTS.downloadDir.includes(path.join('.dsh', 'eh-downloads')), DEFAULTS.downloadDir);
check('DEFAULT_DOWNLOAD_DIR 与 DEFAULTS 一致', DEFAULTS.downloadDir === DEFAULT_DOWNLOAD_DIR);
check('accountScoped 默认开', DEFAULTS.accountScoped === true);

const CFG = { downloadDir: path.resolve('D:/tmp/eh-dl'), accountScoped: true };

check(
  'account: exhentai',
  resolveDownloadDir(CFG, { memberId: 12345, site: 'exhentai' }) === path.join(CFG.downloadDir, 'exh-12345'),
  resolveDownloadDir(CFG, { memberId: 12345, site: 'exhentai' }),
);
check(
  'account: e-hentai',
  resolveDownloadDir(CFG, { memberId: '678', site: 'e-hentai' }) === path.join(CFG.downloadDir, 'eh-678'),
  resolveDownloadDir(CFG, { memberId: '678', site: 'e-hentai' }),
);
check(
  'account: 无 memberId → anon',
  resolveDownloadDir(CFG, {}) === path.join(CFG.downloadDir, 'anon'),
  resolveDownloadDir(CFG, {}),
);
check(
  'accountScoped=false 不分层',
  resolveDownloadDir({ ...CFG, accountScoped: false }, { memberId: 12345, site: 'exhentai' }) === CFG.downloadDir,
);
check('旧默认值给出 warning', downloadDirWarnings(LEGACY_DEFAULT_DOWNLOAD_DIR).length === 1);
check('新默认值没有 warning', downloadDirWarnings(DEFAULT_DOWNLOAD_DIR).length === 0);

/* ------------------------------------------------------------------ */
/* 2. 收藏内搜索 URL                                                   */
/* ------------------------------------------------------------------ */

const u1 = buildFavoritesUrl('https://e-hentai.org/', { cat: 'all', page: 2, query: 'big breasts' });
check(
  'URL: favcat+f_search+sn/st/sf+page 顺序',
  u1 === 'https://e-hentai.org/favorites.php?favcat=all&f_search=big%20breasts&sn=on&st=on&sf=on&page=2',
  u1,
);

const u2 = buildFavoritesUrl('https://exhentai.org', { cat: 3, page: 0 });
check('URL: 无 query 不带 sn/st/sf', u2 === 'https://exhentai.org/favorites.php?favcat=3&page=0', u2);

const u3 = buildFavoritesUrl('https://e-hentai.org', { cat: 99, page: -1, query: '  ' });
check('URL: 非法 cat 归 0 / page 归 0', u3 === 'https://e-hentai.org/favorites.php?favcat=0&page=0', u3);

const client1 = mockClient(FAV_HTML);
const fav1 = await favorites(client1, { base: 'https://e-hentai.org', cat: 1, page: 3, query: 'alpha' });
check(
  'favorites 实际请求 URL',
  client1.calls[0] === 'https://e-hentai.org/favorites.php?favcat=1&f_search=alpha&sn=on&st=on&sf=on&page=3',
  client1.calls[0],
);
check('favorites 带上 query/cat', fav1.query === 'alpha' && fav1.cat === '1');
check('favorites 列表结构不变', Array.isArray(fav1.items) && fav1.items.length === 2 && Array.isArray(fav1.warnings), fav1.items.length);

const client2 = mockClient(FAV_HTML);
const fav2 = await favorites(client2, { base: 'https://e-hentai.org', cat: 'all' });
check('favorites cat=all 不加 sn/st/sf', client2.calls[0] === 'https://e-hentai.org/favorites.php?favcat=all&page=0', client2.calls[0]);

/* ------------------------------------------------------------------ */
/* 3. 收藏备注解析                                                     */
/* ------------------------------------------------------------------ */

const parsed = await parseFavNotes(FAV_HTML);
check('parseFavNotes 命中备注', parsed.notes['111'] === '我的备注 alpha', parsed.notes);
check('parseFavNotes 没备注的不编造', parsed.notes['222'] === undefined, parsed.notes);

const client3 = mockClient(FAV_HTML);
const fn = await favNotes(client3, { base: 'https://e-hentai.org', cat: 0 });
check('favNotes 请求收藏页', client3.calls[0] === 'https://e-hentai.org/favorites.php?favcat=0&page=0', client3.calls[0]);
check('favNotes 返回 {gid: note}', fn.notes['111'] === '我的备注 alpha' && fn.warnings.length === 0, fn);

const client4 = mockClient(NO_NOTE_HTML);
const fn2 = await favNotes(client4, { base: 'https://e-hentai.org', cat: 0 });
check('favNotes 解析不到 → 空对象 + warning', Object.keys(fn2.notes).length === 0 && fn2.warnings.length === 1, fn2);

/* ------------------------------------------------------------------ */
/* 4. fav.json 缓存                                                    */
/* ------------------------------------------------------------------ */

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-fav-'));
__setDataDir(tmp);

const saved = await saveFavorites([
  { gid: 111, token: 'aaaa111111', title: 'Alpha Archive', tags: ['female:sole female', 'language:chinese'], note: '我的备注 alpha', cat: '0' },
  { gid: 222, token: 'bbbb222222', title: 'Beta Book', tags: ['male:sole male'], note: '', cat: 1 },
  { title: '没有 gid 的脏记录' },
]);
check('saveFavorites 丢弃无 gid 记录', saved.items.length === 2, saved.items.length);
check('fav.json 版本与时间', saved.version === 1 && typeof saved.updatedAt === 'string', saved);

const loaded = await loadFavorites();
check('loadFavorites 回读条数', loaded.items.length === 2, loaded.items.length);
check('loadFavorites 字段齐全', ['gid', 'token', 'title', 'tags', 'note', 'cat'].every((k) => k in loaded.items[0]), Object.keys(loaded.items[0]));

check('searchFavorites 标题子串', (await searchFavorites('alpha')).length === 1);
check('searchFavorites 不分大小写', (await searchFavorites('ALPHA')).length === 1);
check('searchFavorites 标签子串', (await searchFavorites('chinese')).length === 1);
check('searchFavorites note: 字段', (await searchFavorites('note:备注')).length === 1);
check('searchFavorites title: 字段不误命中 note', (await searchFavorites('title:备注')).length === 0);
check('searchFavorites ns:value 标签', (await searchFavorites('female:sole female')).length === 1);
check('searchFavorites 多词 AND', (await searchFavorites('alpha archive')).length === 1);
check('searchFavorites 无命中为空', (await searchFavorites('nope')).length === 0);
check('searchFavorites 空 query 返回全部', (await searchFavorites('')).length === 2);
check('searchFavorites limit 生效', (await searchFavorites('', { limit: 1 })).length === 1);

const raw = JSON.parse(await fsp.readFile(path.join(tmp, 'fav.json'), 'utf8'));
check('fav.json 落盘结构', raw.version === 1 && Array.isArray(raw.items) && raw.items.length === 2, Object.keys(raw));

const st = await stats();
check('stats 带上 fav 文件', st.files.fav && st.files.fav.records === 2, st.files.fav);

// 损坏文件不能让读取炸掉
await fsp.writeFile(path.join(tmp, 'fav.json'), '{ 坏掉的 json', 'utf8');
const broken = await loadFavorites();
check('fav.json 损坏 → 空壳不抛', broken.items.length === 0 && broken.version === 1, broken);

/* ------------------------------------------------------------------ */

await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
__setDataDir(null);

console.log(`PASS ${total - failed}/${failed}`);
process.exit(failed === 0 ? 0 : 1);
