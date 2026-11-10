// 核心验证：① 本地假服务器验证重定向/表单/JSON/cookie/重试（不花外部请求）
//           ② 真机只打 2 次外部请求（e-hentai 200 + exhentai 302）
import http from 'node:http';
import { loadConfig, getConfigPath, __selftest as cfgSelf } from '../src/config.js';
import { createClient, EHBlocked, __selftest as httpSelf } from '../src/http.js';
import { baseUrl, __selftest as authSelf } from '../src/auth.js';

const out = { local: {}, live: {}, self: null, ok: false };
const step = (name, data) => {
  out.steps = [...(out.steps || []), name];
  console.log(`[${name}]`, JSON.stringify(data));
};

// ---------- 1. 本地假服务器 ----------
const hits = { flaky: 0 };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/redir') {
      res.writeHead(302, { location: '/final' });
      return res.end();
    }
    if (req.url === '/final') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<div class="itg">local ok</div>');
    }
    if (req.url === '/post') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          method: req.method,
          contentType: req.headers['content-type'] || '',
          origin: req.headers.origin || '',
          referer: req.headers.referer || '',
          body,
        }),
      );
    }
    if (req.url === '/setcookie') {
      res.writeHead(200, { 'set-cookie': ['igneous=zzz; Path=/; HttpOnly'], 'content-type': 'text/html' });
      return res.end('ok');
    }
    if (req.url === '/flaky') {
      hits.flaky += 1;
      if (hits.flaky === 1) {
        res.writeHead(503, { 'content-type': 'text/html' });
        return res.end('busy');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('recovered');
    }
    res.writeHead(404);
    res.end('nope');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const L = `http://127.0.0.1:${port}`;

const localClient = await createClient({ proxy: '', rateLimitMs: 0, retryTimes: 3 });
try {
  const follow = await localClient.get(`${L}/redir`);
  out.local.redirect = { status: follow.status, finalUrl: follow.finalUrl, hasItg: follow.text.includes('itg') };

  const noFollow = await localClient.get(`${L}/redir`, { redirect: false });
  out.local.redirectOff = { status: noFollow.status, location: noFollow.headers.location || null };

  const jsonPost = await localClient.post(`${L}/post`, { json: { method: 'gdata', gidlist: [[1, 'abc']] } });
  const jsonEcho = JSON.parse(jsonPost.text);
  out.local.postJson = {
    status: jsonPost.status,
    contentType: jsonEcho.contentType,
    origin: jsonEcho.origin,
    referer: jsonEcho.referer,
    body: jsonEcho.body,
  };

  const formPost = await localClient.post(`${L}/post`, {
    form: { UserName: 'u', PassWord: 'p', CookieDate: '1', submit: 'Log me in' },
  });
  const formEcho = JSON.parse(formPost.text);
  out.local.postForm = { contentType: formEcho.contentType, body: formEcho.body };

  await localClient.get(`${L}/setcookie`);
  out.local.cookieCapture = localClient.getCookies();

  const flaky = await localClient.get(`${L}/flaky`);
  out.local.retry = { status: flaky.status, body: flaky.text, attempts: hits.flaky };
} finally {
  await localClient.close();
  await new Promise((r) => server.close(r));
}

// ---------- 2. 真机（2 次外部请求） ----------
const cfg = await loadConfig();
step('config', {
  path: getConfigPath(),
  site: cfg.site,
  proxy: cfg.proxy,
  downloadDir: cfg.downloadDir,
  concurrency: cfg.concurrency,
  rateLimitMs: cfg.rateLimitMs,
});

const client = await createClient(cfg);
step('client', client.info());
try {
  const eh = await client.get('https://e-hentai.org/');
  out.live.eh = { status: eh.status, hasItg: eh.text.includes('itg'), len: eh.text.length, error: eh.error || null };

  const exh = await client.get('https://exhentai.org/', { redirect: false });
  out.live.exh = {
    status: exh.status,
    location: exh.headers.location || null,
    len: (exh.text || "").length,
    finalUrl: exh.finalUrl,
    error: exh.error || null,
  };
} finally {
  await client.close();
}

out.self = {
  config: await cfgSelf(),
  http: await httpSelf(),
  auth: await authSelf(),
  baseEh: baseUrl(cfg, 'e-hentai'),
  baseExh: baseUrl(cfg, 'exhentai'),
};

const localOk =
  out.local.redirect.status === 200 &&
  out.local.redirect.finalUrl.endsWith('/final') &&
  out.local.redirectOff.status === 302 &&
  out.local.postJson.contentType.includes('application/json') &&
  out.local.postJson.origin === L &&
  out.local.postForm.contentType.includes('application/x-www-form-urlencoded') &&
  out.local.postForm.body.includes('UserName=u') &&
  out.local.cookieCapture.igneous === 'zzz' &&
  out.local.retry.status === 200 &&
  out.local.retry.attempts === 2;

// 已登录（带 igneous）时 exhentai 直接 200 且有正文；未登录才 302 回 e-hentai。两种都算通。
const exhReachable =
  (out.live.exh.status === 200 && (out.live.exh.len || 0) > 5000) ||
  ((out.live.exh.status === 301 || out.live.exh.status === 302) &&
    /e-hentai\.org/.test(out.live.exh.location || ''));
const liveOk = out.live.eh.status === 200 && out.live.eh.hasItg && exhReachable;

out.ok = localOk && liveOk;
console.log('[local]', JSON.stringify(out.local));
console.log('[live]', JSON.stringify(out.live));
console.log('[selftest]', JSON.stringify(out.self));
console.log(out.ok ? 'CORE_OK' : `CORE_FAIL local=${localOk} live=${liveOk}`);
process.exitCode = out.ok ? 0 : 1;
