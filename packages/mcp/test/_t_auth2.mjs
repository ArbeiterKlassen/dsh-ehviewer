// auth 自愈层验证：
//   ① mock：igneous 解析 / 60 分钟缓存 / force 绕过 / 双入口兜底 / 失败不抛
//   ② 真机：flush 掉缓存 force 刷一次（1~2 个真实请求），确认 exhentai 仍能 200
// 全程不打印 cookie 明文，只用长度。
import { loadConfig } from '../src/config.js';
import { createClient } from '../src/http.js';
import { refreshIgneous, status, mode, baseUrl } from '../src/auth.js';

const out = { mock: {}, live: {}, ok: false };
const fails = [];
const check = (okFlag, label, detail = '') => {
  if (!okFlag) fails.push(label);
  console.log(`${okFlag ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * 假 client：只实现 refreshIgneous 用到的四个方法。
 * responses 按调用次数取（最后一条会重复用），用来模拟「论坛不通、主站才给」。
 */
function mockClient({ responses = [{}], throws = false, exh = { status: 200, text: '' } } = {}) {
  const calls = [];
  let jar = { ipb_member_id: '1', ipb_pass_hash: 'hash', igneous: 'OLDTAG' };
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (throws) throw new Error('socket hang up');
      // exhentai 探测单独给脚本：默认当「igneous 已失效」（200 + 空正文）
      if (String(url).includes('exhentai.org')) {
        return { status: exh.status, headers: {}, text: exh.text, finalUrl: url };
      }
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r.jarPatch) jar = { ...jar, ...r.jarPatch };
      return {
        status: r.status ?? 200,
        headers: r.setCookie && r.setCookie.length ? { 'set-cookie': r.setCookie } : {},
        text: r.text ?? '<html>ok</html>',
        finalUrl: url,
      };
    },
    getCookies: () => ({ ...jar }),
    setCookies(obj) {
      Object.assign(jar, obj);
      return { ...jar };
    },
    async close() {},
  };
}

const freshCfg = () => ({
  site: 'exhentai',
  cookies: { ipb_member_id: '1', ipb_pass_hash: 'hash', igneous: 'OLDTAG' },
});

// ---------- ① Set-Cookie 解析 ----------
{
  const client = mockClient({ responses: [{ setCookie: ['igneous=NEWIGNEOUS; Path=/; HttpOnly'] }] });
  const cfg = freshCfg();
  const r = await refreshIgneous({ cfg, client, force: true, persist: false });
  out.mock.header = r;
  check(r.ok && r.changed && r.igneousLen === 10, 'mock: 从 Set-Cookie 取到新 igneous');
  check(cfg.cookies.igneous === 'NEWIGNEOUS', 'mock: 值写回 cfg.cookies（只回长度不回明文）');
  check(!JSON.stringify(r).includes('NEWIGNEOUS') && !JSON.stringify(r).includes('OLDTAG'), 'mock: 返回值里没有明文');

  // ---------- ② 60 分钟缓存 ----------
  const before = client.calls.length;
  const r2 = await refreshIgneous({ cfg, client, persist: false });
  out.mock.cached = r2;
  check(r2.ok && r2.cached === true && client.calls.length === before, 'mock: 60 分钟内直接吃缓存，不再发请求');

  // ---------- ③ force 绕过缓存 ----------
  const forced = mockClient({ responses: [{ setCookie: ['igneous=FORCEDTAG'] }] });
  const r3 = await refreshIgneous({ cfg, client: forced, force: true, persist: false });
  check(r3.ok && r3.changed && forced.calls.length === 1, 'mock: force 无视缓存，真的又请求了一次');
}

// ---------- ④ 只靠 cookie 罐变化也能认出新值 ----------
{
  const client = mockClient({ responses: [{ jarPatch: { igneous: 'FROMJAR01' } }] });
  const cfg = freshCfg();
  const r = await refreshIgneous({ cfg, client, force: true, persist: false });
  out.mock.jar = r;
  check(r.ok && r.changed && cfg.cookies.igneous === 'FROMJAR01', 'mock: Set-Cookie 被吞时退回 cookie 罐比对');
}

// ---------- ⑤ 第一个入口不给、第二个给 ----------
{
  const client = mockClient({
    responses: [{ setCookie: [] }, { setCookie: ['igneous=SECONDSRC'] }],
  });
  const cfg = freshCfg();
  const r = await refreshIgneous({ cfg, client, force: true, persist: false });
  out.mock.fallback = { ...r, hits: client.calls.length };
  check(r.ok && client.calls.length === 2 && cfg.cookies.igneous === 'SECONDSRC', 'mock: 入口一失败自动换入口二');
}

// ---------- ⑥ 两个入口都不给 → ok:false + reason（不抛） ----------
{
  const client = mockClient({ responses: [{ setCookie: [] }] });
  const cfg = freshCfg();
  const r = await refreshIgneous({ cfg, client, force: true, persist: false });
  out.mock.fail = r;
  check(r.ok === false && typeof r.reason === 'string' && r.reason.length <= 120, 'mock: 拿不到 igneous → ok:false + 短 reason');
  check(cfg.cookies.igneous === 'OLDTAG', 'mock: 失败不动原 cookie');

  const boom = mockClient({ throws: true });
  const rb = await refreshIgneous({ cfg: freshCfg(), client: boom, force: true, persist: false });
  check(rb.ok === false && typeof rb.reason === 'string', 'mock: 请求抛异常也只回 ok:false（不外抛）');
}

// ---------- ⑦ igneous=deleted 是作废占位值，绝不能写回 ----------
{
  const client = mockClient({
    responses: [{ setCookie: ['igneous=deleted; Path=/'] }],
    exh: { status: 200, text: '<html>ok</html>' },
  });
  const cfg = freshCfg();
  const r = await refreshIgneous({ cfg, client, force: true, persist: false });
  out.mock.deleted = r;
  check(cfg.cookies.igneous === 'OLDTAG' && r.changed === false, 'mock: Set-Cookie 里的 igneous=deleted 被丢弃');
}

// ---------- ⑧ status 认人 / 抠 GP（mock，不发请求） ----------
{
  const homeHtml =
    '<a href="https://forums.e-hentai.org/index.php?showuser=42">Yuki</a>' +
    '<div id="gp">12,345</div><div>[<a href="https://e-hentai.org/hathperks.php">Hath Perks</a>]</div>';
  const fake = {
    calls: [],
    async get(url) {
      this.calls.push(url);
      return { status: 200, headers: {}, text: homeHtml, finalUrl: url };
    },
    getCookies: () => ({ ipb_member_id: '42', ipb_pass_hash: 'h', igneous: 'X'.repeat(16) }),
    async close() {},
  };
  const st = await status({ cfg: { site: 'exhentai', cookies: { ipb_member_id: '42', ipb_pass_hash: 'h' } }, client: fake });
  out.mock.status = st;
  check(st.username === 'Yuki' && st.memberId === '42' && st.gp === 12345 && st.site === 'exhentai', 'mock: status 解析用户名 / memberId / GP');
}

// ---------- ⑨ 真机：force 刷一次 + 确认 exhentai 还进得去 ----------
const cfg = await loadConfig();
const client = await createClient(cfg);
try {
  const t0 = Date.now();
  const r = await refreshIgneous({ cfg, client, force: true });
  out.live.refresh = { ...r, ms: Date.now() - t0 };

  const st = await status({ cfg, client });
  out.live.status = st;

  const exh = await client.get('https://exhentai.org/', { redirect: false });
  out.live.exh = {
    status: exh.status,
    location: exh.headers?.location || null,
    len: (exh.text || '').length,
    needsRelogin: Boolean(exh.needsRelogin),
    error: exh.error || null,
  };

  out.live.mode = await mode({ cfg, client });
  out.live.site = st.site;

  check(r.ok === true, 'live: refreshIgneous 成功', `changed=${r.changed} verified=${Boolean(r.verified)} len=${r.igneousLen} ${out.live.refresh.ms}ms`);
  check(exh.status === 200, 'live: exhentai 首页 200（没被 302 回 e-hentai）', `status=${exh.status}`);
  check(st.site === 'exhentai', 'live: status.site 仍是 exhentai', `site=${st.site}`);
  check(!JSON.stringify({ ...st, ...r }).includes(cfg.cookies.igneous || '\u0000'), 'live: 返回体不含 igneous 明文');
} finally {
  await client.close();
}

// ---------- ⑩ 认证失效：自愈跑过仍不行 → needsRelogin + 一行提示（不抛、不循环） ----------
{
  const bare = await createClient({
    ...cfg,
    cookies: { ipb_member_id: cfg.cookies.ipb_member_id, ipb_pass_hash: cfg.cookies.ipb_pass_hash },
  });
  try {
    const r = await bare.get('https://exhentai.org/', { redirect: false });
    out.live.noIgneous = { status: r.status, len: (r.text || '').length, needsRelogin: Boolean(r.needsRelogin), error: r.error || null };
    check(
      r.needsRelogin === true && typeof r.error === 'string' && r.error.length <= 120,
      'live: 缺 igneous → needsRelogin + 紧凑提示',
      `status=${r.status} ${r.error}`,
    );
  } finally {
    await bare.close();
  }
}

console.log('\n[mock]', JSON.stringify(out.mock));
console.log('[live]', JSON.stringify(out.live));
out.ok = fails.length === 0;
console.log(out.ok ? 'AUTH2_OK' : `AUTH2_FAIL ${fails.join(' | ')}`);
process.exitCode = out.ok ? 0 : 1;
