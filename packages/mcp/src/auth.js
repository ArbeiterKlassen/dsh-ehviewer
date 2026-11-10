// 登录 / cookie 导入 / 登录状态 / 站点判定与切换
// 安全约定：任何返回值里都不出现 cookie 原文，只回有效性、用户名、member id。
import { loadConfig, saveConfig } from './config.js';
import { createClient } from './http.js';

const EH = 'https://e-hentai.org';
const EXH = 'https://exhentai.org';
const FORUMS = 'https://forums.e-hentai.org';
const LOGIN_URL = `${FORUMS}/index.php?act=Login&CODE=01`;
const LOGIN_PAGE = `${FORUMS}/index.php?act=Login&CODE=00`;
const FORUM_INDEX = `${FORUMS}/index.php?act=idx`;

/** 只保留登录真正需要的几个 cookie 名 */
const KEEP_COOKIES = new Set(['ipb_member_id', 'ipb_pass_hash', 'session_id', 'igneous']);

/** igneous 大约一个月轮换一次；60 分钟内成功刷新过就不再打网络 */
const IGNEOUS_TTL_MS = 60 * 60 * 1000;

/** 刷新入口：论坛首页最灵（必须带论坛 cookie 才会下发），主站根是兜底 */
const IGNEOUS_SOURCES = [`${FORUMS}/index.php`, `${EH}/`];

/** 进程内刷新状态（MCP server 常驻才有意义，重启后自然再刷一次） */
let igneousState = { at: 0, ok: false, len: 0 };

/** 刷新重入锁：http 的自愈会反过来调这里，探测失败又可能再触发一轮，必须挡住 */
let refreshing = false;

/** 站点名归一：exh/ex/exhentai → exhentai，其余 → e-hentai */
function normSite(site) {
  const s = String(site || '').toLowerCase().trim();
  if (['exhentai', 'exh', 'ex', 'ex-hentai'].includes(s)) return 'exhentai';
  return 'e-hentai';
}

/** 站点根 URL */
export function baseUrl(cfg, site) {
  const s = normSite(site || (cfg && cfg.site) || 'e-hentai');
  return s === 'exhentai' ? EXH : EH;
}

/** "k=v; k2=v2" → {k: v}（丢掉 Set-Cookie 属性段） */
function parseCookieString(str) {
  const out = {};
  if (typeof str !== 'string') return out;
  for (const part of str.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (!k) continue;
    if (['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'version'].includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** 没给 client 就临时造一个，用完关掉 */
async function ensureClient(cfg, client) {
  if (client) return { client, owned: null };
  const c = await createClient(cfg);
  return { client: c, owned: c };
}

/** 从 Set-Cookie 数组里挑出登录凭证 */
function pickAuthCookies(setCookieList) {
  const out = {};
  const list = Array.isArray(setCookieList) ? setCookieList : setCookieList ? [setCookieList] : [];
  for (const raw of list) {
    const first = String(raw).split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (!KEEP_COOKIES.has(k) || !v) continue;
    if (v === 'deleted') continue; // EH 注销 cookie 时下发的占位值，不是凭证
    out[k] = v;
  }
  return out;
}

/** URL → 小写 hostname（解析失败给空串） */
function hostOf(urlStr) {
  try {
    return new URL(String(urlStr)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 去标签 + 压空白（用户名常被 <b> 之类的装饰包着） */
function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 从页面里认人。论坛写 "Logged in as: <a showuser=..>"，主站写法随版本变，
 * 所以给三个模式兜底；认不出就 null——宁可空着也不猜。
 */
function pickUser(html) {
  const s = String(html || '');
  const patterns = [
    /Logged in as:?\s*<a[^>]*showuser=(\d+)[^>]*>([\s\S]{1,80}?)<\/a>/i,
    /Welcome (?:back)?[,:]?\s*<a[^>]*showuser=(\d+)[^>]*>([\s\S]{1,80}?)<\/a>/i,
    /<a[^>]*showuser=(\d+)[^>]*>([\s\S]{1,80}?)<\/a>/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return { memberId: m[1], username: stripTags(m[2]) || null };
  }
  const bare = /Logged in as:?\s*([A-Za-z0-9_\-[\]\.]{2,40})/i.exec(s);
  if (bare) return { memberId: null, username: bare[1] };
  return { memberId: null, username: null };
}

/**
 * 从主站首页抠 GP / hath 加成。页面改版频繁，抠不到就给 null——
 * 这两个数字只是给人看的，猜错比空着更糟。
 */
function pickWallet(html) {
  const s = String(html || '');
  const n = (m) => (m ? Number(String(m[1]).replace(/,/g, '')) : null);
  const gp =
    n(/\bid=["']?(?:gp|gsp)["']?[^>]*>\s*([\d,]+)/i.exec(s)) ??
    n(/\bclass=["'][^"']*(?:gp|gsp)[^"']*["'][^>]*>\s*([\d,]+)/i.exec(s)) ??
    n(/\bGP:\s*([\d,]{1,15})/i.exec(s)) ??
    null;
  const hathPerks = n(/(?:Hath Perks?|hathperks)[^0-9]{0,24}([\d,]{1,10})/i.exec(s)) ?? null;
  return { gp, hathPerks };
}

/**
 * igneous 形如 16~17 位小写字母数字。
 * 必须排掉 "deleted"：EH 在某些响应里会下发 Set-Cookie: igneous=deleted 作废当前值，
 * 把它当新值写回配置等于自己把登录搞掉（踩过一次）。
 */
function looksLikeIgneous(v) {
  return typeof v === 'string' && v !== 'deleted' && /^[a-z0-9]{8,64}$/i.test(v);
}

/**
 * 从一次响应里挑出「新」的 igneous。
 * 两条来源都看：Set-Cookie 是正路；有些代理会吞掉 Set-Cookie，
 * 但 client 的 cookie 罐已经落下来了——只要它和刷新前不同，就是新的。
 */
function pickIgneous(res, client, before) {
  const fresh = pickAuthCookies((res && res.headers && res.headers['set-cookie']) || []).igneous;
  if (looksLikeIgneous(fresh) && fresh !== before) return fresh;
  const jar = client && client.getCookies ? client.getCookies() : null;
  const fromJar = jar && jar.igneous;
  if (looksLikeIgneous(fromJar) && fromJar !== before) return fromJar;
  return '';
}

/**
 * 论坛登录：POST 表单拿 Set-Cookie，成功后写回配置
 * @returns {{ok: boolean, username: string, message: string}}
 */
export async function login({ cfg, username, password }) {
  const config = cfg || (await loadConfig());
  const name = String(username || '').trim();
  if (!name || !password) {
    return { ok: false, username: name, message: '用户名或密码为空' };
  }

  const owned = await createClient(config);
  try {
    const res = await owned.post(LOGIN_URL, {
      form: { UserName: name, PassWord: String(password), CookieDate: '1', submit: 'Log me in' },
      referer: LOGIN_PAGE,
      redirect: false,
    });

    if (!res || res.status === 0) {
      return { ok: false, username: name, message: `网络请求失败：${(res && res.error) || '未知错误'}` };
    }

    const html = res.text || '';
    const picked = pickAuthCookies(res.headers && res.headers['set-cookie']);

    const failedText = /Username or password incorrect|Sorry, an error occurred|You have been banned|account has been suspended/i.test(html);
    const successText = /You are now logged in|logged in successfully|Thank you,? you are now logged in/i.test(html);

    const ok = !failedText && (Boolean(picked.ipb_member_id && picked.ipb_pass_hash) || successText);
    if (!ok) {
      return {
        ok: false,
        username: name,
        message: failedText ? '登录失败：用户名或密码错误，或账号被限制' : '登录失败：未拿到登录 cookie',
      };
    }

    // 写回配置（只存我们要的几个）
    const merged = { ...(config.cookies || {}), ...picked };
    const next = await saveConfig({ cookies: merged });
    Object.assign(config, next);
    owned.setCookies(next.cookies);

    // igneous 由论坛/主站域下发，缺它 exhentai 必 302；登录后立刻串一次拿回来
    if (!config.cookies.igneous) {
      await refreshIgneous({ cfg: config, client: owned, force: true });
    }

    return { ok: true, username: name, message: '登录成功，凭证已写入配置' };
  } finally {
    await owned.close();
  }
}

/**
 * 导入 cookie：支持 "a=1; b=2" 整串，也支持对象；写回配置
 */
export async function setCookies({ cfg, cookieString, cookies }) {
  const config = cfg || (await loadConfig());
  const incoming = {
    ...parseCookieString(cookieString),
    ...(cookies && typeof cookies === 'object' ? Object.fromEntries(Object.entries(cookies).map(([k, v]) => [k, String(v)])) : {}),
  };
  const merged = { ...(config.cookies || {}), ...incoming };
  // 记录这份 cookie 是什么时候导进来的：igneous 大约一个月一换，超过 25 天就该提醒重导
  const next = await saveConfig({ cookies: merged, cookieUpdatedAt: Date.now() });
  Object.assign(config, next);
  const keys = Object.keys(next.cookies);
  return { ok: keys.length > 0, count: keys.length, keys, cfg: next };
}

/**
 * 现在这份 igneous 还能不能进 exhentai。
 * 「没拿到新值」有两种完全不同的原因：服务器觉得旧的还有效（不用管），
 * 或者 cookie 真废了（要报警）。探一次首页才能分清。
 */
async function exhUsable(c) {
  try {
    const res = await c.get(`${EXH}/`, { redirect: false });
    if (!res || res.status !== 200 || res.needsRelogin) return false;
    if (/sadpanda/i.test(String((res.headers && res.headers['content-disposition']) || ''))) return false;
    return Boolean(String(res.text || '').trim());
  } catch {
    return false;
  }
}

/**
 * 刷新 exhentai 的 igneous。
 *
 * 背景：igneous 约一个月轮换一次，过期后 exhentai 会 302 回 e-hentai 或吐 sad panda。
 * 修法（抄 EhViewer）：拿现有的论坛 cookie 串一次论坛首页，服务端就会在 Set-Cookie
 * 里下发新的 igneous；论坛不灵时再串主站根。
 *
 * 返回值只有长度，不含明文；任何失败都收成 {ok:false, reason}，不抛异常。
 *
 * @param {object}  o
 * @param {object}  o.cfg      配置对象（会被就地更新 cookies）
 * @param {object}  o.client   复用调用方的 client，cookie 罐才同步
 * @param {boolean} o.force    忽略 60 分钟缓存
 * @param {boolean} o.persist  是否写盘（测试里设 false，别碰真实 config）
 * @param {string[]} o.sources 刷新入口（测试可替换）
 * @returns {{ok:boolean, changed:boolean, igneousLen:number, cached?:boolean, reason?:string}}
 */
export async function refreshIgneous({
  cfg,
  client,
  force = false,
  persist = true,
  sources = IGNEOUS_SOURCES,
} = {}) {
  const config = cfg || (await loadConfig());
  const before = String((config.cookies && config.cookies.igneous) || '');

  // 60 分钟内成功刷过就吃缓存：igneous 一个月才换，重复请求只会招限流
  if (!force && igneousState.ok && Date.now() - igneousState.at < IGNEOUS_TTL_MS) {
    return { ok: true, changed: false, igneousLen: before.length, cached: true };
  }

  // http 的自愈会反过来调这里，探测失败又可能再触发一轮，重入直接放弃
  if (refreshing) {
    return { ok: false, changed: false, igneousLen: before.length, reason: '正在刷新 igneous，跳过重入' };
  }
  refreshing = true;

  const { client: c, owned } = await ensureClient(config, client);
  try {
    for (const url of sources) {
      let res = null;
      try {
        res = await c.get(url, { redirect: true });
      } catch {
        continue; // 一个入口不通就换下一个
      }
      if (!res || res.status === 0) continue;

      const next = pickIgneous(res, c, before);
      if (!next) continue;

      // 先同步 cookie 罐，再落盘：后面重试的那个请求要靠罐里的新值
      if (c.setCookies) c.setCookies({ igneous: next });
      if (persist) {
        const saved = await saveConfig({ cookies: { ...(config.cookies || {}), igneous: next } });
        Object.assign(config, saved);
      } else {
        config.cookies = { ...(config.cookies || {}), igneous: next };
      }

      igneousState = { at: Date.now(), ok: true, len: next.length };
      return { ok: true, changed: next !== before, igneousLen: next.length };
    }

    // 没下发新值不等于 cookie 死了：老值可能本来就有效，探一眼 exhentai 再决定要不要报警
    if (await exhUsable(c)) {
      igneousState = { at: Date.now(), ok: true, len: before.length };
      return { ok: true, changed: false, igneousLen: before.length, verified: true };
    }
  } finally {
    refreshing = false;
    if (owned) await owned.close();
  }

  // 两个入口都没给、exhentai 也进不去：是真失效了
  igneousState = { at: Date.now(), ok: false, len: before.length };
  return {
    ok: false,
    changed: false,
    igneousLen: before.length,
    reason: '论坛被 Cloudflare 拦、主站也没下发 igneous，跑 eh_login 或从浏览器重导 cookie',
  };
}

/**
 * 登录状态：请求主站根（拿用户名 / GP / hath），论坛页兜底认人
 * 绝不回传 cookie 原文。
 */
export async function status({ cfg, client }) {
  const config = cfg || (await loadConfig());
  const { client: c, owned } = await ensureClient(config, client);

  try {
    // site=auto 时先探 exhentai：进得去就按 exhentai 算，被 302 回 EH 再按 e-hentai 算
    const explicit = config.site && config.site !== 'auto' ? normSite(config.site) : null;
    const home = `${explicit ? baseUrl(config, explicit) : EXH}/`;
    let res = await c.get(home, { redirect: true });
    let html = (res && res.text) || '';

    // 主站打不开（代理挂了 / 被限流）就退回论坛首页，至少还能报登录态
    let usedForums = false;
    if (!res || res.status === 0) {
      usedForums = true;
      res = await c.get(FORUM_INDEX, { redirect: true });
      html = (res && res.text) || '';
    }

    // 站点按真实落地域名判断；退回论坛时沿用配置里的站点声明
    const finalHost = hostOf((res && res.finalUrl) || home);
    const site = usedForums ? normSite(config.site || 'e-hentai') : finalHost.includes('exhentai.org') ? 'exhentai' : 'e-hentai';

    let { memberId, username } = pickUser(html);

    // 主站认不出人（exhentai 首页被 302 / 回空页）就用论坛页补一次
    if (!username && !usedForums) {
      const fres = await c.get(FORUM_INDEX, { redirect: true }).catch(() => null);
      const fu = pickUser((fres && fres.text) || '');
      if (fu.username) {
        username = fu.username;
        memberId = fu.memberId;
      }
    }

    const jar = c.getCookies ? c.getCookies() : {};
    if (!memberId && jar.ipb_member_id) memberId = String(jar.ipb_member_id);

    const hasCred = Boolean(jar.ipb_member_id && jar.ipb_pass_hash);
    const loginForm = /act=Login&(?:amp;)?CODE=0[01]/i.test(html);
    const loggedIn =
      Boolean(username || memberId) ||
      /act=Login&(?:amp;)?CODE=03/i.test(html) ||
      /\bLog ?Out\b/i.test(html) ||
      // 页面有内容却没认出人：按「凭证在、站点认」处理；空页说明 exhentai 不认这份 cookie
      (hasCred && !loginForm && html.trim().length > 0);

    const wallet = pickWallet(html);
    // igneous 大约一个月一换：导 cookie 满 25 天就提醒一次，别等它某天突然失效
    const cookieUpdatedAt = Number(config.cookieUpdatedAt || 0) || null;
    const cookieAgeDays = cookieUpdatedAt ? Math.floor((Date.now() - cookieUpdatedAt) / 864e5) : null;
    return {
      loggedIn,
      username: username || null,
      memberId: memberId || null,
      site,
      gp: wallet.gp,
      hathPerks: wallet.hathPerks,
      ...(cookieAgeDays !== null ? { cookieAgeDays } : {}),
      ...(cookieAgeDays !== null && cookieAgeDays >= 25
        ? { hint: 'cookie 已导入 ' + cookieAgeDays + ' 天，igneous 快到期了，从浏览器重导一次' }
        : {}),
      // 只有 http 自愈失败（cookie 在场但站点不认）时才带这个标记，平时不占位
      ...(res && res.needsRelogin ? { needsRelogin: true } : {}),
    };
  } catch {
    return { loggedIn: false, username: null, memberId: null, site: 'e-hentai', gp: null, hathPerks: null };
  } finally {
    if (owned) await owned.close();
  }
}

/**
 * 判定实际可用站点：cfg.site 明确就照办；auto 时探 exhentai 根，
 * 302 回 e-hentai 说明没权限 → e-hentai，否则 exhentai。
 */
export async function mode({ cfg, client }) {
  const config = cfg || (await loadConfig());
  if (config.site && config.site !== 'auto') return normSite(config.site);

  const { client: c, owned } = await ensureClient(config, client);
  try {
    const res = await c.get(`${EXH}/`, { redirect: false });
    if (!res || res.status === 0) return 'e-hentai';

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = String((res.headers && res.headers.location) || '');
      // 跳回 e-hentai = EXH 不可用
      return /e-hentai\.org/i.test(loc) ? 'e-hentai' : 'exhentai';
    }

    // 200 且页面非空 = 真的能进 EXH（空页/夹页都算不可用）
    if (res.status === 200) return String(res.text || '').trim() ? 'exhentai' : 'e-hentai';
    return 'e-hentai';
  } catch {
    return 'e-hentai';
  } finally {
    if (owned) await owned.close();
  }
}

/** 切站点：写 site 字段 */
export async function switchSite({ cfg, target }) {
  const config = cfg || (await loadConfig());
  const t = String(target || '').toLowerCase().trim();
  const site = t === 'auto' ? 'auto' : normSite(t);
  const next = await saveConfig({ site });
  Object.assign(config, next);
  return next;
}

/** 自检（不联网） */
export async function __selftest() {
  const cfg = { site: 'auto', cookies: {} };
  const ok =
    baseUrl(cfg, 'exhentai') === EXH &&
    baseUrl(cfg, 'e-hentai') === EH &&
    baseUrl({ site: 'exhentai' }) === EXH &&
    typeof login === 'function' &&
    typeof status === 'function' &&
    typeof refreshIgneous === 'function';
  return { module: 'auth', ok, eh: EH, exh: EXH };
}
