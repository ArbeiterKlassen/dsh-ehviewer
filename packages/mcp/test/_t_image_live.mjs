// 临时：真实图片页验证 resolveImage（画廊页 1 次 + 图片页 1 次，共 2 次请求）
import { SocksProxyAgent } from 'socks-proxy-agent';
import https from 'node:https';
import { resolveImage, parsePageEntries } from '../src/pages.js';

const AGENT = new SocksProxyAgent('socks5h://127.0.0.1:10808');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0';
let hits = 0;

function req(method, url, referer) {
  hits += 1;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (referer) headers.Referer = referer;
    const r = https.request(
      { host: u.hostname, port: 443, path: u.pathname + u.search, method, agent: AGENT, headers, timeout: 30000 },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, text: b, finalUrl: url, headers: res.headers }));
      }
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

const client = { get: (u, o = {}) => req('GET', u, o.referer) };

const galleryUrl = 'https://e-hentai.org/g/4316857/4582e5402c/';
const mp = await client.get(`${galleryUrl}?p=0`, { referer: galleryUrl });
const entries = parsePageEntries(mp.text, { base: 'https://e-hentai.org' });
console.log('页链接:', entries.length, '首条', entries[0]?.url);

const img = await resolveImage(client, entries[0].url);
console.log(JSON.stringify({
  index: img.index,
  urlLen: img.url?.length,
  hasKeystamp: img.url?.includes('keystamp'),
  hasWebp: /\.(webp|jpg|png|gif)(\?|$)/i.test(img.url || ''),
  tail: img.url?.slice(-40),
  width: img.width,
  height: img.height,
  showKey: img.showKey,
  referer: img.referer,
  reloadUrl: img.reloadUrl,
  warnings: img.warnings,
}, null, 1));
console.log('真实请求:', hits);
