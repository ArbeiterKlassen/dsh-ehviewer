// 带代理 / 限速 / cookie / 重试的 HTTP 客户端
// 传输路线（两条，按代理类型选）：
//   1) socks5 / socks5h → node:https(node:http) + socks-proxy-agent 的 SocksProxyAgent
//      undici 不认 http.Agent 系做 dispatcher，所以 SOCKS 这条路不用 fetch。
//   2) http(s) 代理 → undici fetch + ProxyAgent
//   3) 无代理 → node:https + 自带 keep-alive agent
// 两条路都收敛到 rawOnce()，上层只处理重定向 / 限速 / 重试 / cookie / 解码。
// 认证自愈：exhentai 拒绝访问（302 回 EH / sad panda / 空首页）时刷一次 igneous 重放请求，
// 仍不行就返回 needsRelogin:true，由上层提示跑 eh_login。
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** 被 EH 封 IP / 限流时的专用错误；其余网络问题都不抛给调用方 */
export class EHBlocked extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'EHBlocked';
    this.url = info.url || '';
    this.status = info.status || 0;
  }
}

/** 失败提示统一成一行中文、可行动、不贴堆栈：这些字符串会原样进 MCP 返回体喂给模型 */
const MSG_RATE = 'IP 被限流，等 10–30 分钟或换代理';
const MSG_RELOGIN = 'exhentai cookie 过期，跑 eh_login 或 eh_cookie_set';

const RETRY_STATUS = new Set([429, 502, 503]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const COOKIE_ATTRS = new Set([
  'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority', 'version', 'comment',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL → 小写 hostname（解析失败给空串） */
function hostOf(urlStr) {
  try {
    return new URL(String(urlStr)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 底层异常 → 一行可行动的提示。
 * 为什么压：error 会进 MCP 返回体，ENOTFOUND / 堆栈这类噪音只会淹没「下一步干什么」；
 * 这里只留判据 + 动作，长度压在 120 字以内。
 */
function compactError(e) {
  const msg = String((e && e.message) || e || '');
  const rules = [
    [/timeout|timed ?out|ETIMEDOUT|AbortError/i, '请求超时，确认代理在跑（默认 socks5 127.0.0.1:10808）或换节点'],
    [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|EADDRNOTAVAIL/i, '连不上代理或域名解析失败，检查 sing-box / DNS 后重试'],
    [/socket hang up|ECONNRESET|EPIPE|ECONNABORTED/i, '连接被重置，代理不稳，重试一次或换节点'],
    [/certificate|CERT_|TLS|SSL|self.signed/i, 'TLS 握手失败，代理可能在拦证书或出口被墙'],
    [/socks|proxy|代理/i, '代理握手失败，检查代理串（socks5://127.0.0.1:10808）'],
  ];
  for (const [re, text] of rules) if (re.test(msg)) return text;
  const one = msg.replace(/\s+/g, ' ').trim();
  return one ? `请求失败：${one.slice(0, 96)}` : '请求失败（无详细信息）';
}

/**
 * exhentai 拒绝访问的几种长相（抄 EhViewer 的判据）：
 *  - 302 回 e-hentai / forums（没 igneous 或 cookie 失效）
 *  - Sad Panda 图（Content-Disposition: ...sadpanda.jpg）
 *  - 首页 200 但正文为空（igneous 值错）
 * 只看 exhentai 自己的请求，别的域不掺和。
 */
function isExhAuthFailure(res, host) {
  if (!host || !/(^|\.)exhentai\.org$/.test(host)) return false;
  if (!res) return false;

  const headers = res.headers || {};
  if (/sadpanda/i.test(String(headers['content-disposition'] || ''))) return true;

  const loc = String(headers.location || '');
  if (loc && /(^|[./])(e-hentai|forums\.e-hentai)\.org/i.test(loc)) return true;

  const finalHost = hostOf(res.finalUrl);
  if (finalHost && finalHost !== host && /(^|\.)e-hentai\.org$/.test(finalHost)) return true;

  const text = String(res.text || '');
  if (/sad panda/i.test(text)) return true;
  if (res.status === 200 && host === 'exhentai.org' && !text.trim()) return true;
  return false;
}

/** 只给 EH 自家域名带 cookie，别把凭证漏给外站 */
function isEhHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return /(^|\.)(e-hentai\.org|exhentai\.org)$/.test(h);
}

/** 把 "k=v; k2=v2" 或对象统一成 {k: v}；顺手丢掉 Set-Cookie 的属性段 */
function parseCookieInput(input) {
  const out = {};
  if (!input) return out;
  if (typeof input === 'string') {
    for (const part of input.split(';')) {
      const s = part.trim();
      if (!s) continue;
      const i = s.indexOf('=');
      if (i <= 0) continue;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!k || COOKIE_ATTRS.has(k.toLowerCase())) continue;
      out[k] = v;
    }
    return out;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || v === null) continue;
      out[String(k)] = v;
    }
  }
  return out;
}

/**
 * SOCKS 用的 lookup 兜底：本机 DNS 不可用/被污染时把域名原样交给代理解析，
 * 这样配置里写 socks5:// 也能跑（否则 getaddrinfo ENOTFOUND 直接失败）。
 */
function lookupWithFallback(hostname, opts, cb) {
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err || !address) return cb(null, hostname, 4);
    cb(null, address, family);
  });
}

/**
 * 按代理串造传输层。
 * @returns {{kind:'socks'|'http'|'direct', agent?:any, dispatcher?:any, agents?:any, error?:string}}
 */
function buildTransport(proxy, timeoutMs) {
  const direct = () => ({
    kind: 'direct',
    agents: {
      'http:': new http.Agent({ keepAlive: true }),
      'https:': new https.Agent({ keepAlive: true }),
    },
  });

  if (!proxy || typeof proxy !== 'string' || !proxy.trim()) return direct();

  try {
    const u = new URL(proxy.trim());
    const proto = u.protocol.toLowerCase();

    // 1) HTTP(S) 代理 → undici ProxyAgent
    if (proto === 'http:' || proto === 'https:') {
      return { kind: 'http', dispatcher: new ProxyAgent(u.href) };
    }

    // 2) SOCKS → SocksProxyAgent（http.Agent 系，配 node:https）
    if (proto.startsWith('socks')) {
      // socks5:// 的默认语义是「本地解析」，但本机 DNS 对 exhentai.org 返回投毒地址
      // （2a03:2880:...face:b00c），本地解析会连到假 IP 被 TLS 重置。
      // 统一改写成 socks5h://（远端解析），语义才和实际可用路径一致。
      if (proto === 'socks5:' || proto === 'socks:') u.protocol = 'socks5h:';
      const agent = new SocksProxyAgent(u.href, { keepAlive: true, timeout: timeoutMs });
      return { kind: 'socks', agent, lookup: lookupWithFallback };
    }
  } catch {
    /* 代理串写错就直连，别把客户端带崩 */
  }

  const t = direct();
  t.error = `代理配置不可用：${proxy}`;
  return t;
}

/** 解压（node 那条路要自己处理，undici fetch 会自动解） */
function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buf;
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch {
    /* 解不开就按原文返回 */
  }
  return buf;
}

/** undici fetch 那条路（http 代理） */
async function requestViaUndici(urlStr, { method, headers, body, dispatcher, timeoutMs }) {
  const res = await undiciFetch(urlStr, {
    method,
    headers,
    body,
    redirect: 'manual',
    dispatcher,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const headersObj = {};
  for (const [k, v] of res.headers) headersObj[k.toLowerCase()] = v;
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (sc.length) headersObj['set-cookie'] = sc;
  return { status: res.status, headers: headersObj, buffer: buf };
}

/** node:http(s) 那条路（socks / 直连） */
function requestViaNode(urlStr, { method, headers, body, agent, lookup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent,
        lookup,
        servername: isHttps ? u.hostname : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            buffer: decodeBody(Buffer.concat(chunks), res.headers && res.headers['content-encoding']),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** headers → 普通对象（set-cookie 保持数组） */
function normalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === 'set-cookie') {
      out['set-cookie'] = Array.isArray(v) ? v : [v];
      continue;
    }
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** 按 content-type 的 charset 解码（EH 是 UTF-8，论坛偶有 latin1） */
function decodeText(buf, headers) {
  const ct = (headers && headers['content-type']) || '';
  const m = /charset\s*=\s*"?([^";]+)"?/i.exec(String(ct));
  let cs = (m && m[1] ? m[1] : 'utf-8').trim().toLowerCase();
  if (cs === 'utf8') cs = 'utf-8';
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 拼 URL + query */
function withQuery(url, query) {
  if (!query || typeof query !== 'object') return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      u.searchParams.delete(k);
      for (const item of v) u.searchParams.append(k, String(item));
    } else {
      u.searchParams.set(k, String(v));
    }
  }
  return u.href;
}

/**
 * 创建客户端
 * @param {object} cfg 由 config.loadConfig() 得来
 */
export async function createClient(cfg = {}) {
  const config = cfg || {};
  const ua =
    config.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const rateLimitMs = Number.isFinite(Number(config.rateLimitMs)) ? Number(config.rateLimitMs) : 800;
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 30_000;
  const maxRedirects = Number.isFinite(Number(config.maxRedirects)) ? Math.trunc(Number(config.maxRedirects)) : 5;
  const retryTimes = Number.isFinite(Number(config.retryTimes)) ? Math.trunc(Number(config.retryTimes)) : 3;

  const transport = buildTransport(config.proxy, timeoutMs);
  const proxyNote = transport.error || (transport.kind === 'direct' ? 'none' : transport.kind);

  /** cookie 罐（扁平，仅 EH 域生效） */
  const jar = parseCookieInput(config.cookies || {});
  /** 每站上次请求时间 */
  const lastHit = new Map();
  let closed = false;
  /** 自愈重入锁：一次请求链里最多刷一次 igneous */
  let healing = false;
  /** 回填当前 client，自愈时要把同一个 client 交给 auth（cookie 罐才同源） */
  let clientRef = null;

  function cookieHeaderFor(urlStr) {
    try {
      const host = new URL(urlStr).hostname;
      if (!isEhHost(host)) return '';
    } catch {
      return '';
    }
    const keys = Object.keys(jar);
    if (!keys.length) return '';
    return keys.map((k) => `${k}=${jar[k]}`).join('; ');
  }

  function absorbSetCookie(list) {
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    for (const raw of arr) {
      const first = String(raw).split(';')[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const k = first.slice(0, i).trim();
      const v = first.slice(i + 1).trim();
      if (!k || COOKIE_ATTRS.has(k.toLowerCase())) continue;
      if (v === '' || v === 'deleted') delete jar[k];
      else jar[k] = v;
    }
  }

  /** 每站限速 */
  async function throttle(urlStr) {
    let key = '';
    try {
      key = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      key = '';
    }
    const last = lastHit.get(key) || 0;
    const wait = rateLimitMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    lastHit.set(key, Date.now());
  }

  /**
   * 自愈：刷一次 igneous，然后把原请求原样重放一次。
   * 用动态 import 而不是顶部静态 import——auth.js 顶部就 import 本文件的 createClient，
   * 静态互引成环；这里只在真的失效时才去加载，代价只落在出事那一次。
   */
  async function healAuthFailure(method, urlStr, opts) {
    if (healing) return null;
    healing = true;
    try {
      const mod = await import('./auth.js');
      if (!mod || typeof mod.refreshIgneous !== 'function') return null;
      const r = await mod.refreshIgneous({ cfg: config, client: clientRef, force: true });
      if (!r || !r.ok) return null;
      return await request(method, urlStr, { ...opts, query: undefined, __noHeal: true }, 0);
    } catch (e) {
      if (e instanceof EHBlocked) throw e;
      return null;
    } finally {
      healing = false;
    }
  }

  /**
   * 最外层（hop 0）的收尾判决，只做两件事：
   *  1) 限流页（temporarily banned / kokomade）→ 抛 EHBlocked，让调用方停手
   *  2) exhentai 拒绝访问 → 刷一次 igneous 重放；仍不行就标 needsRelogin 交上层提示
   * 只在最外层判：重定向中途的中间页不触发自愈，免得一次请求里反复刷新。
   */
  async function inspectAuth(method, urlStr, opts, out) {
    const text = String(out.text || '');
    if (/temporarily banned/i.test(text)) {
      throw new EHBlocked(`${MSG_RATE}（temporarily banned）`, { url: urlStr, status: out.status });
    }
    if (/img\/kokomade\.jpg/i.test(text)) {
      throw new EHBlocked(`${MSG_RATE}（kokomade）`, { url: urlStr, status: out.status });
    }

    const host = hostOf(urlStr);
    if (!isExhAuthFailure(out, host)) return out;

    const again = opts.__noHeal ? null : await healAuthFailure(method, urlStr, opts);
    if (again && !isExhAuthFailure(again, host)) return again;
    return { ...(again || out), needsRelogin: true, error: MSG_RELOGIN };
  }

  /** 一次底层请求（未重试、未跟随重定向） */
  function rawOnce(urlStr, { method, headers, body }) {
    if (transport.kind === 'http') {
      return requestViaUndici(urlStr, { method, headers, body, dispatcher: transport.dispatcher, timeoutMs });
    }
    let agent = null;
    if (transport.kind === 'socks') agent = transport.agent;
    else {
      try {
        agent = transport.agents[new URL(urlStr).protocol] || null;
      } catch {
        agent = null;
      }
    }
    return requestViaNode(urlStr, {
      method,
      headers,
      body,
      agent,
      lookup: transport.kind === 'socks' ? transport.lookup : undefined,
      timeoutMs,
    });
  }

  /** 带 5xx/429 退避重试 */
  async function fetchOnce(urlStr, reqOpts) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retryTimes; attempt++) {
      await throttle(urlStr);
      try {
        const res = await rawOnce(urlStr, reqOpts);
        if (RETRY_STATUS.has(res.status) && attempt < retryTimes) {
          await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 150));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < retryTimes) {
          await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 150));
          continue;
        }
      }
    }
    throw lastErr || new Error('request failed');
  }

  /** 核心请求：手动跟随重定向，返回 {status, headers, text, finalUrl} */
  async function request(method, inputUrl, opts = {}, hop = 0) {
    const { query, headers = {}, referer, redirect = true, form, json, body } = opts;
    const urlStr = withQuery(String(inputUrl), query);

    let origin = '';
    let proto = '';
    try {
      const u = new URL(urlStr);
      origin = `${u.protocol}//${u.host}`;
      proto = u.protocol;
    } catch {
      return { status: 0, headers: {}, text: '', finalUrl: urlStr, error: `无效 URL：${urlStr}` };
    }

    const hdrs = {
      'user-agent': ua,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      referer: referer || `${origin}/`,
      ...headers,
    };
    // EH 的写操作（登录 / api.php）会看 Origin
    if (method !== 'GET' && (proto === 'http:' || proto === 'https:') && !hdrs.origin) {
      hdrs.origin = origin;
    }
    const cookie = cookieHeaderFor(urlStr);
    if (cookie && !hdrs.cookie) hdrs.cookie = cookie;

    let payload = body;
    if (json !== undefined && json !== null) {
      payload = typeof json === 'string' ? json : JSON.stringify(json);
      hdrs['content-type'] = 'application/json';
    } else if (form && typeof form === 'object') {
      payload = new URLSearchParams(
        Object.entries(form)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      hdrs['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (payload && !hdrs['content-length'] && typeof payload === 'string') {
      hdrs['content-length'] = String(Buffer.byteLength(payload));
    }

    try {
      const res = await fetchOnce(urlStr, { method, headers: hdrs, body: payload });
      const resHeaders = normalizeHeaders(res.headers);
      absorbSetCookie(resHeaders['set-cookie']);

      const status = res.status;
      // redirect: false → 不跟；true / 省略 → 跟满 maxRedirects；数字 → 跟这么多跳
      const follow =
        redirect === false
          ? 0
          : redirect === true || redirect === undefined
            ? maxRedirects
            : Number.isFinite(Number(redirect))
              ? Math.trunc(Number(redirect))
              : maxRedirects;

      if (REDIRECT_STATUS.has(status) && hop < follow) {
        const loc = resHeaders.location;
        if (loc) {
          const nextUrl = new URL(loc, urlStr).href;
          // 303 / 301 / 302 统一降级成 GET；307 / 308 保持原方法
          const nextMethod = status === 307 || status === 308 ? method : 'GET';
          const next = await request(nextMethod, nextUrl, { ...opts, query: undefined, form: undefined, json: undefined, body: undefined }, hop + 1);
          // 跳过去之后才是真结果：起点是 exhentai、落地成 e-hentai，就是 cookie 失效
          return hop === 0 ? await inspectAuth(method, urlStr, opts, next) : next;
        }
      }

      const text = decodeText(res.buffer, resHeaders);

      // buffer 一并带出：图片/压缩包这类二进制内容必须用 buffer，text 是解码后的残渣
      const out = { status, headers: resHeaders, text, buffer: res.buffer, finalUrl: urlStr };
      return hop === 0 ? await inspectAuth(method, urlStr, opts, out) : out;
    } catch (e) {
      if (e instanceof EHBlocked) throw e;
      // 网络/解析失败不外抛
      return { status: 0, headers: {}, text: '', finalUrl: urlStr, error: compactError(e) };
    }
  }

  const client = {
    /** GET -> {status, headers, text, finalUrl} */
    get: (url, opts) => request('GET', url, opts),
    /**
     * GET 二进制 -> {status, headers, buffer, text, finalUrl}
     * 图片 / zip 必须走这条：text 是解码残渣，buffer 才是原始字节。
     */
    getBinary: (url, opts) => request('GET', url, opts),
    /** POST：{form} 走表单，{json} 走 application/json -> 同上 */
    post: (url, opts) => request('POST', url, opts || {}),
    /** 写入 cookie（字符串或对象），同步回 cfg.cookies */
    setCookies(input) {
      Object.assign(jar, parseCookieInput(input));
      if (config.cookies && typeof config.cookies === 'object') Object.assign(config.cookies, jar);
      return { ...jar };
    },
    /** 读 cookie 副本 */
    getCookies() {
      return { ...jar };
    },
    /** 传输层摘要（排障用，不含代理串） */
    info() {
      return { transport: transport.kind, proxy: proxyNote, rateLimitMs, cookies: Object.keys(jar).length, closed };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (transport.kind === 'http') await transport.dispatcher.close();
        else if (transport.kind === 'socks') transport.agent.destroy();
        else if (transport.agents) {
          transport.agents['http:'].destroy();
          transport.agents['https:'].destroy();
        }
      } catch {
        /* 忽略 */
      }
    },
  };

  clientRef = client;
  return client;
}

/** 自检（不联网）：验证构造、方法齐、cookie 解析正确 */
export async function __selftest() {
  const client = await createClient({ proxy: '', rateLimitMs: 0, cookies: { ipb_member_id: '1' } });
  const cookies = client.setCookies('igneous=abc; Path=/; HttpOnly');
  const ok =
    typeof client.get === 'function' &&
    typeof client.post === 'function' &&
    cookies.igneous === 'abc' &&
    cookies.Path === undefined &&
    client.getCookies().ipb_member_id === '1';
  await client.close();
  return { module: 'http', ok };
}
