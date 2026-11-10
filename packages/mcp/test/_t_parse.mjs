// _t_parse.mjs — 真机验证：抓 1 个首页 + 1 个详情页（走 SOCKS5），存 fixture，再跑解析器。
// 真实请求预算 ≤5；fixtures 已存在时默认复用（--refetch 强制重抓）。
//   node test/_t_parse.mjs            # 复用 fixture，0 次网络
//   node test/_t_parse.mjs --refetch  # 重抓（首页 1 + 详情 1 = 2 次网络）
//   node test/_t_parse.mjs --gdata    # 额外测一次 api.php gdata（+1 次网络）
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGalleryList, parseGalleryDetail, parseTags, parseNextPage, galleryUrl } from '../src/gallery.js';
import { parsePageEntries } from '../src/pages.js';
import { batchMeta } from '../src/browse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

const AGENT = new SocksProxyAgent('socks5h://127.0.0.1:10808'); // 必须 socks5h：远端 DNS
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let hits = 0;

function request(method, url, { body = null, referer = null } = {}) {
  if (++hits > 5) throw new Error('超过 5 次真实请求上限');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' };
    if (referer) headers.Referer = referer;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      { host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, agent: AGENT, headers, timeout: 30000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), finalUrl: url })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 给解析器用的最小 client（get/post 语义对齐 http.js 契约） */
const client = {
  get: (url) => request('GET', url),
  post: (url, opts = {}) =>
    request('POST', url, {
      body: opts.json ? JSON.stringify(opts.json) : opts.body || null,
      referer: opts.referer || null,
    }),
};

const refetch = process.argv.includes('--refetch');
const withGdata = process.argv.includes('--gdata');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const has = (f) => fs.existsSync(path.join(FIX, f));
const one = (s, n = 150) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

let homeHtml;
let detailHtml;

if (!refetch && has('home.html') && has('detail.html')) {
  homeHtml = read('home.html');
  detailHtml = read('detail.html');
  console.log('[fixture] 复用已抓页面（0 次网络）');
} else {
  const home = await request('GET', 'https://e-hentai.org/');
  homeHtml = home.text;
  fs.writeFileSync(path.join(FIX, 'home.html'), homeHtml);
  console.log('[net] 首页', home.status, homeHtml.length, 'bytes');

  const link = homeHtml.match(/href="(https:\/\/e-hentai\.org\/g\/\d+\/[0-9a-f]+\/)"/)?.[1];
  const det = await request('GET', link, { referer: 'https://e-hentai.org/' });
  detailHtml = det.text;
  fs.writeFileSync(path.join(FIX, 'detail.html'), detailHtml);
  console.log('[net] 详情', det.status, detailHtml.length, 'bytes', link);
}

/* ---------------- 解析器实跑 ---------------- */
const base = 'https://e-hentai.org';

console.log('\n=== parseGalleryList(home) ===');
const items = parseGalleryList(homeHtml, { base });
console.log('条数:', items.length, '| warnings:', items.warnings);
console.log('首条:', JSON.stringify(items[0], null, 1));
console.log('末条 title:', one(items.at(-1)?.title, 60));
const withThumb = items.filter((i) => i.thumb).length;
const withPages = items.filter((i) => i.pages).length;
const withUploader = items.filter((i) => i.uploader).length;
const withPosted = items.filter((i) => i.posted).length;
console.log(`字段覆盖: thumb ${withThumb}/${items.length} · pages ${withPages} · uploader ${withUploader} · posted ${withPosted}`);

console.log('\n=== parseGalleryList(search.html 表格布局) ===');
if (has('search.html')) {
  const sItems = parseGalleryList(read('search.html'), { base });
  console.log('条数:', sItems.length, '| warnings:', sItems.warnings);
  console.log('首条:', JSON.stringify({ gid: sItems[0]?.gid, title: one(sItems[0]?.title, 50), category: sItems[0]?.category, pages: sItems[0]?.pages, uploader: sItems[0]?.uploader, posted: sItems[0]?.posted }));
  console.log('next:', JSON.stringify(parseNextPage(read('search.html'), { base })));
} else {
  console.log('(无 fixture，跳过)');
}

console.log('\n=== parseGalleryDetail(detail) ===');
const detail = parseGalleryDetail(detailHtml, { base });
console.log(one(JSON.stringify({
  gid: detail?.gid, token: detail?.token, title: detail?.title, category: detail?.category,
  posted: detail?.posted, uploader: detail?.uploader, rating: detail?.rating, pages: detail?.pages,
  size: detail?.size, parent: detail?.parent, visible: detail?.visible, language: detail?.language,
  archiver: detail?.archiverUrl, thumb: one(detail?.thumb, 80),
}), 700));
console.log('tags:', JSON.stringify(detail?.tags));
console.log('warnings:', detail?.warnings);

console.log('\n=== parseNextPage(home) ===');
console.log(JSON.stringify(parseNextPage(homeHtml, { base })));

if (has('multipage.html')) {
  console.log('\n=== parsePageEntries(multipage) ===');
  const mp = read('multipage.html');
  const pages = parsePageEntries(mp, { base });
  console.log('条数:', pages.length, '| warnings:', pages.warnings);
  console.log('前 3:', JSON.stringify(pages.slice(0, 3)));
  console.log('index 区间:', pages[0]?.index, '..', pages.at(-1)?.index);
}

if (has('imagepage.html')) {
  console.log('\n=== resolveImage(离线回放 imagepage.html) ===');
  // 用假 client 把已抓的图片页喂进去：0 次网络，但走的是真实 resolveImage 路径
  const { resolveImage } = await import('../src/pages.js');
  const pageUrl = 'https://e-hentai.org/s/96f43585df/4317466-1';
  const imgHtml = read('imagepage.html');
  const fake = { get: async (u) => ({ status: 200, text: imgHtml, finalUrl: u }) };
  const r = await resolveImage(fake, pageUrl);
  console.log(JSON.stringify({ index: r.index, showKey: r.showKey, width: r.width, height: r.height, url: one(r.url, 90), reloadUrl: r.reloadUrl, warnings: r.warnings }, null, 1));
}

if (withGdata) {
  console.log('\n=== batchMeta(gdata, 1 次请求, 2 条) ===');
  const seed = items.slice(0, 2).map((i) => ({ gid: i.gid, token: i.token, title: i.title }));
  const r = await batchMeta(client, { base, items: seed });
  console.log('warnings:', r.warnings);
  console.log('返回:', one(JSON.stringify(r.items.map((i) => ({
    gid: i.gid, title: i.title, jpn: i.titleJpn, cat: i.category, pages: i.pages, size: i.size,
    rating: i.rating, uploader: i.uploader, posted: i.posted, tags: i.tags?.length, ns: Object.keys(i.tagsByNs || {}),
  }))), 600));
}

console.log('\n真实请求总数:', hits);
