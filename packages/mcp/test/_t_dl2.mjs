// test/_t_dl2.mjs —— 第二轮硬化验收（不联网、纯 mock）
// 覆盖：短包重试、取消、自适应降速、meta v1→v2 读 + 续传字节校验、
//       store 裁剪 / compactStore / stats、subs 增量早停与输出压缩、磁盘保护。
// 跑法：node test/_t_dl2.mjs
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import {
  downloadGallery,
  cancelDownload,
  readMeta,
  normalizeMeta,
  MIN_FREE_BYTES,
} from '../src/download.js';
import { checkSubs, compactItem } from '../src/subs.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
};

const tmpRoots = [];
async function tmp(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一页一条的假 pages：只关心下标 */
function deps(pages, resolveImage, extra = {}) {
  return { listPages: async () => pages, resolveImage, ...extra };
}

// ── 1. 短包重试 / meta 完整性 ──────────────────────────────────────────────
async function testShortBody() {
  console.log('[短包]');
  const dir = await tmp('eh2-short-');
  const pages = [
    { index: 1, url: 'https://e-hentai.org/s/ok/1-1' },
    { index: 2, url: 'https://e-hentai.org/s/dead/1-2' },
  ];

  let shortTries = 0;
  const client = {
    async getBinary(url) {
      if (url.includes('dead')) {
        // 永远短包：10 字节，但 content-length 说 100
        return { status: 200, headers: { 'content-length': '100' }, buffer: Buffer.alloc(10) };
      }
      shortTries += 1;
      // 前两次给短包，第三次补齐 —— 校验必须能自己恢复
      const n = shortTries < 3 ? 10 : 100;
      return { status: 200, headers: { 'content-length': '100' }, buffer: Buffer.alloc(n) };
    },
  };

  const _deps = deps(pages, async (c, pageUrl) => ({
    index: 1,
    url: pageUrl.includes('/dead/') ? 'https://img.example/dead.jpg' : 'https://img.example/ok.jpg',
    warnings: [],
  }));

  const res = await downloadGallery({
    client,
    gallery: { gid: 501, token: 'tok', title: 'Short Body' },
    dir,
    concurrency: 1,
    _deps,
  });

  ok('短包重试后成功 1 张', res.downloaded === 1, { downloaded: res.downloaded });
  ok('前两次短包被重试（共 3 次请求）', shortTries === 3, { shortTries });
  ok('永久短包记失败', res.failed.length === 1, { failed: res.failed });
  ok('失败项标 kind=short 并带 expected/received', res.failed[0].kind === 'short' && res.failed[0].expected === 100 && res.failed[0].received === 10, { f: res.failed[0] });

  const failedJson = JSON.parse(await fsp.readFile(path.join(res.dir, 'failed.json'), 'utf8'));
  ok('failed.json 落盘且不阻断其余图片', failedJson.length === 1 && failedJson[0].index === 2, { failedJson });

  const files = (await fsp.readdir(res.dir)).sort();
  ok('成功的图已落盘、无 .part 残留', files.includes('001.jpg') && !files.some((f) => f.endsWith('.part')), { files });

  const meta = JSON.parse(await fsp.readFile(path.join(res.dir, 'meta.json'), 'utf8'));
  ok('meta v2 结构', meta.version === 2 && meta.gid === 501 && Array.isArray(meta.pages) && meta.pages.length === 2, { meta });
  ok('meta.pages 记 status/bytes', meta.pages[0].status === 'downloaded' && meta.pages[0].bytes === 100 && meta.pages[1].status === 'failed', { pages: meta.pages });
  ok('meta 兼容旧字段 gallery/images', meta.gallery.gid === 501 && meta.images.length === 2);
}

// ── 2. 取消 ────────────────────────────────────────────────────────────────
async function testCancel() {
  console.log('[取消]');
  const dir = await tmp('eh2-cancel-');
  const pages = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, url: `https://e-hentai.org/s/p${i + 1}/1-${i + 1}` }));

  let fetches = 0;
  const client = {
    async getBinary(url) {
      fetches += 1;
      await sleep(20);
      const buf = Buffer.from(`IMG:${url}`);
      return { status: 200, headers: { 'content-length': String(buf.length) }, buffer: buf };
    },
  };
  const _deps = deps(pages, async (c, pageUrl) => ({ index: 1, url: `https://img.example/${pageUrl.slice(-1)}.jpg` }));

  const res = await downloadGallery({
    client,
    gallery: { gid: 502, token: 'tok' },
    dir,
    concurrency: 2,
    _deps,
    onProgress: (p) => {
      if (p.done === 1) cancelDownload(502);
    },
  });

  ok('返回 cancelled=true', res.cancelled === true);
  ok('取消后没把 8 张全下完', res.downloaded < 8, { downloaded: res.downloaded });
  ok('取消不产生 failed', res.failed.length === 0, { failed: res.failed });
  ok('取消后不再发请求（fetches 明显少于 8）', fetches <= 4, { fetches });

  const meta = JSON.parse(await fsp.readFile(path.join(res.dir, 'meta.json'), 'utf8'));
  ok('meta.status=cancelled', meta.status === 'cancelled', { status: meta.status });
  ok('meta 里未轮到的图标 cancelled', meta.pages.filter((p) => p.status === 'cancelled').length > 0, { pages: meta.pages.map((p) => p.status) });

  const files = await fsp.readdir(res.dir);
  ok('取消后无 .part 残留', !files.some((f) => f.endsWith('.part')), { files });
  ok('没有活跃任务时 cancelDownload 返回 false', cancelDownload(99999) === false);

  // 续传：取消过的目录再跑一次应该能补齐（这里只验不会把已完成的重下）
  let refetched = 0;
  const client2 = {
    async getBinary(url) {
      refetched += 1;
      const buf = Buffer.from(`IMG:${url}`);
      return { status: 200, headers: { 'content-length': String(buf.length) }, buffer: buf };
    },
  };
  const res2 = await downloadGallery({ client: client2, gallery: { gid: 502, token: 'tok' }, dir, concurrency: 2, _deps });
  ok('取消后续传：已下完的跳过、总量补齐', res2.skipped >= 1 && res2.downloaded + res2.skipped === 8, { d: res2.downloaded, s: res2.skipped, f: refetched });
}

// ── 3. 自适应降速（429） ──────────────────────────────────────────────────
async function testAdaptive() {
  console.log('[限流]');
  const dir = await tmp('eh2-rl-');
  const pages = Array.from({ length: 4 }, (_, i) => ({ index: i + 1, url: `https://e-hentai.org/s/q${i + 1}/1-${i + 1}` }));

  let calls = 0;
  const client = {
    async getBinary(url) {
      calls += 1;
      if (calls === 1) {
        const err = new Error('HTTP 429');
        err.status = 429;
        throw err;
      }
      const buf = Buffer.from(`IMG:${url}`);
      return { status: 200, headers: { 'content-length': String(buf.length) }, buffer: buf };
    },
  };
  const _deps = deps(pages, async (c, pageUrl) => ({ index: 1, url: `https://img.example/x${pageUrl.slice(-1)}.jpg` }));

  const t0 = Date.now();
  const res = await downloadGallery({
    client,
    gallery: { gid: 503, token: 'tok' },
    dir,
    concurrency: 4,
    rateLimitBackoffMs: 60,
    _deps,
  });
  const elapsed = Date.now() - t0;

  ok('429 后仍全部下完', res.downloaded === 4 && res.failed.length === 0, { d: res.downloaded, f: res.failed });
  ok('记录限流 warning', res.warnings.length >= 1 && /限流/.test(res.warnings[0]), { warnings: res.warnings });
  ok('warning 里写明并发下调', /并发\s*\d+→\d+/.test(res.warnings[0]), { warnings: res.warnings });
  ok('退避时长被采用（≥ 传进去的 60ms）', elapsed >= 60, { elapsed });

  // temporarily banned 文本也要认得（http.js 抛的是 EHBlocked，没有 status）
  let calls2 = 0;
  const client2 = {
    async getBinary(url) {
      calls2 += 1;
      if (calls2 === 1) throw new Error('Your IP address is temporarily banned for exceeding the limits');
      const buf = Buffer.from(`IMG:${url}`);
      return { status: 200, headers: { 'content-length': String(buf.length) }, buffer: buf };
    },
  };
  const dir2 = await tmp('eh2-rl2-');
  const res2 = await downloadGallery({
    client: client2,
    gallery: { gid: 504, token: 'tok' },
    dir: dir2,
    concurrency: 2,
    rateLimitBackoffMs: 30,
    _deps,
  });
  ok('temporarily banned 也按限流降速', res2.warnings.length >= 1 && res2.downloaded === 4, { w: res2.warnings, d: res2.downloaded });
}

// ── 4. meta v1→v2 读 + 续传字节校验 ──────────────────────────────────────
async function testMetaCompat() {
  console.log('[meta]');
  const dir = await tmp('eh2-meta-');
  const out = path.join(dir, '9-tk'); // downloadGallery 的真实落盘目录是 <root>/<gid>-<token>
  await fsp.mkdir(out, { recursive: true });
  const v1 = {
    gallery: { gid: 9, token: 'tk', title: 'old', url: 'https://e-hentai.org/g/9/tk/' },
    total: 1,
    downloaded: 1,
    skipped: 0,
    failed: 0,
    status: 'complete',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    images: [{ index: 1, url: 'https://img.example/1.jpg', file: '001.jpg', bytes: 5, status: 'downloaded' }],
  };
  await fsp.writeFile(path.join(out, 'meta.json'), JSON.stringify(v1), 'utf8');

  const meta = await readMeta(out);
  ok('v1 能读成 v2', !!meta && meta.version === 2 && meta.fromVersion === 1, { meta });
  ok('v1→v2 保留 gid/token/title', meta.gid === 9 && meta.token === 'tk' && meta.title === 'old');
  ok('v1→v2 从 url 补 site', meta.site === 'https://e-hentai.org', { site: meta.site });
  ok('v1→v2 映射 pages[].bytes', meta.pages.length === 1 && meta.pages[0].bytes === 5, { pages: meta.pages });
  ok('坏 meta 返回 null', (await (async () => {
    const bad = await tmp('eh2-badmeta-');
    await fsp.writeFile(path.join(bad, 'meta.json'), '{not json', 'utf8');
    return readMeta(bad);
  })()) === null);
  ok('normalizeMeta 空值安全', normalizeMeta(null) === null && normalizeMeta('x') === null);

  // 大小和 meta 一致 → 跳过；被截断 → 重下
  await fsp.writeFile(path.join(out, '001.jpg'), Buffer.alloc(5), 'utf8');
  let gets = 0;
  const client = {
    async getBinary() {
      gets += 1;
      const buf = Buffer.from('12345');
      return { status: 200, headers: { 'content-length': String(buf.length) }, buffer: buf };
    },
  };
  const _deps = deps([{ index: 1, url: 'https://e-hentai.org/s/z/1-1' }], async () => ({ index: 1, url: 'https://img.example/1.jpg' }));

  const r1 = await downloadGallery({ client, gallery: { gid: 9, token: 'tk' }, dir, concurrency: 1, _deps });
  ok('大小与 meta 一致 → 跳过', r1.skipped === 1 && r1.downloaded === 0 && gets === 0, { r1: { d: r1.downloaded, s: r1.skipped }, gets });

  await fsp.writeFile(path.join(out, '001.jpg'), Buffer.alloc(3), 'utf8'); // 截断
  const r2 = await downloadGallery({ client, gallery: { gid: 9, token: 'tk' }, dir, concurrency: 1, _deps });
  ok('大小与 meta 不符 → 重下', r2.downloaded === 1 && r2.skipped === 0, { d: r2.downloaded, s: r2.skipped });
  const meta2 = await readMeta(out);
  ok('重下后 meta 已是 v2', meta2.version === 2 && meta2.pages[0].bytes === 5, { meta2 });
}

// ── 5. 磁盘保护 ────────────────────────────────────────────────────────────
async function testDiskGuard() {
  console.log('[磁盘]');
  const dir = await tmp('eh2-disk-');
  const client = { async getBinary() { throw new Error('不该被调用'); } };
  const _deps = deps([{ index: 1, url: 'https://e-hentai.org/s/a/1-1' }], async () => ({ index: 1, url: 'https://img.example/a.jpg' }), {
    freeBytes: async () => 100 * 1024 * 1024,
  });

  let err = null;
  try {
    await downloadGallery({ client, gallery: { gid: 505, token: 'tok' }, dir, _deps });
  } catch (e) {
    err = e;
  }
  ok('空间不足直接拒绝', !!err && err.code === 'ENOSPC_GUARD', { err: err && err.message });
  ok('拒绝理由是人话', !!err && /只剩|不够|清点空间/.test(err.message), { msg: err && err.message });
  ok('默认阈值 200MB', MIN_FREE_BYTES === 200 * 1024 * 1024);

  const dir2 = await tmp('eh2-disk2-');
  let okRes = null;
  try {
    okRes = await downloadGallery({
      client: { async getBinary() { const b = Buffer.from('x'); return { status: 200, headers: { 'content-length': '1' }, buffer: b }; } },
      gallery: { gid: 506, token: 'tok' },
      dir: dir2,
      _deps: deps([{ index: 1, url: 'https://e-hentai.org/s/a/1-1' }], async () => ({ index: 1, url: 'https://img.example/a.jpg' }), {
        freeBytes: async () => 5 * 1024 * 1024 * 1024,
      }),
    });
  } catch (e) {
    okRes = e;
  }
  ok('空间够就正常下', okRes && okRes.downloaded === 1, { okRes });
}

// ── 6. store 容量治理 ─────────────────────────────────────────────────────
async function testStoreGc() {
  console.log('[store 容量]');
  const dir = await tmp('eh2-store-');
  store.__setDataDir(dir);

  // 直接堆 5100 行（模拟跑了很久的 history.jsonl）
  const bulk = Array.from({ length: 5100 }, (_, i) => JSON.stringify({ type: 'browse', i })).join('\n') + '\n';
  await fsp.writeFile(path.join(dir, 'history.jsonl'), bulk, 'utf8');

  await store.addHistory({ type: 'download', gid: 777, title: 'trim me' });
  const after = (await fsp.readFile(path.join(dir, 'history.jsonl'), 'utf8')).split('\n').filter((l) => l.trim());
  ok('超过 5000 行自动裁剪到 3000', after.length === 3000, { n: after.length });
  ok('裁剪保留最近的记录（含刚写的那条）', JSON.parse(after[after.length - 1]).gid === 777, { last: after[after.length - 1] });

  // search 超限
  for (let i = 0; i < 505; i += 1) await store.addSearch(`q${i}`);
  // 订阅 seen 超限：markSeen 自己就会收口，所以直接改文件模拟「老版本留下的超标文件」
  const sub = await store.addSub({ query: 'overflow' });
  await store.markSeen(sub.id, Array.from({ length: 3000 }, (_, i) => `g${i}`));
  const subsPath = path.join(dir, 'subs.json');
  const rawSubs = JSON.parse(await fsp.readFile(subsPath, 'utf8'));
  rawSubs[0].seen = Array.from({ length: 3500 }, (_, i) => `x${i}`);
  await fsp.writeFile(subsPath, JSON.stringify(rawSubs, null, 2) + '\n', 'utf8');

  const s1 = await store.stats();
  ok('stats 报 history 行数', s1.files.history.records === 3000, { h: s1.files.history });
  ok('stats 报字节数与总量', s1.files.history.bytes > 0 && s1.bytes >= s1.files.history.bytes, { s1 });
  ok('stats 报上限', s1.limits.historyLines === 5000 && s1.limits.historyKeep === 3000 && s1.limits.search === 500);

  const c = await store.compactStore();
  ok('compactStore 不动已合规的 history', c.history.trimmed === false && c.history.after === 3000, { h: c.history });
  ok('compactStore 收到 search 上限', c.search.after === 500, { s: c.search });
  ok('compactStore 收到订阅 seen', c.subs.seenTrimmed === 1, { subs: c.subs });
  const subsAfter = await store.listSubs();
  ok('seen 裁剪后只留最近 3000', subsAfter[0].seen.length === 3000 && subsAfter[0].seen[0] === 'x500', { n: subsAfter[0].seen.length, head: subsAfter[0].seen[0] });

  const s2 = await store.stats();
  ok('compactStore 后 search 条数 = 500', s2.files.search.records === 500, { s: s2.files.search });

  // 原子性：不留 .tmp
  const files = await fsp.readdir(dir);
  ok('store 无 .tmp 残留', !files.some((f) => f.endsWith('.tmp')), { files });
}

// ── 7. subs 增量早停 ──────────────────────────────────────────────────────
async function testSubsIncremental() {
  console.log('[subs 增量]');
  const dir = await tmp('eh2-subs-');
  store.__setDataDir(dir);

  const subA = await store.addSub({ query: 'A' }); // 第 0 页全新，第 1 页重复 → 2 页
  const subB = await store.addSub({ query: 'B' }); // 第 0 页全见过 → 1 页
  const subC = await store.addSub({ query: 'C' }); // 每页都新 → 卡在 3 页
  const subD = await store.addSub({ query: 'D' }); // 直接报错

  await store.markSeen(subB.id, Array.from({ length: 25 }, (_, i) => String(1000 + i)));

  const mk = (start, n = 25) =>
    Array.from({ length: n }, (_, i) => ({
      gid: start + i,
      token: `t${start + i}`,
      title: `T${start + i}`,
      pages: 20,
      tagsPreview: ['noise'],
      uploader: 'noise',
    }));

  const calls = { A: [], B: [], C: [], D: [] };
  const _deps = {
    search: async (c, { query, page }) => {
      calls[query].push(page);
      if (query === 'D') throw new Error('429 too many requests');
      if (query === 'A') return mk(page === 0 ? 101 : 101); // 两页同内容
      if (query === 'B') return mk(1000); // 全在 seen 里
      return mk(2000 + page * 100); // 每页都新
    },
  };

  const res = await checkSubs({ client: {}, base: 'https://e-hentai.org', _deps });
  const byId = new Map(res.map((r) => [r.id, r]));

  const a = byId.get(subA.id);
  ok('A：整页重复即停（2 页）', a.pagesFetched === 2 && calls.A.length === 2, { pagesFetched: a.pagesFetched, calls: calls.A });
  ok('A：只回 25 条新作品', a.newItems.length === 25, { n: a.newItems.length });
  ok('A：newItems 只含四字段', Object.keys(a.newItems[0]).sort().join(',') === 'gid,pages,title,token', { keys: Object.keys(a.newItems[0]) });
  ok('A：不带 tagsPreview/uploader', !('tagsPreview' in a.newItems[0]) && !('uploader' in a.newItems[0]));

  const b = byId.get(subB.id);
  ok('B：整页 gid 都在 seen 里 → 只拉 1 页', b.pagesFetched === 1 && calls.B.length === 1 && b.newItems.length === 0, { b: { p: b.pagesFetched, n: b.newItems.length } });

  const c = byId.get(subC.id);
  ok('C：最多 3 页就收手', c.pagesFetched === 3 && calls.C.length === 3, { calls: calls.C });
  ok('C：三页新作品都报出来', c.newItems.length === 75, { n: c.newItems.length });

  const d = byId.get(subD.id);
  ok('D：失败带 lastError', typeof d.lastError === 'string' && d.lastError.length > 0, { d });
  ok('D：仍保留 error 字段（兼容旧调用方）', typeof d.error === 'string');
  ok('D：失败不影响其它订阅', a.newItems.length === 25 && c.newItems.length === 75);

  ok('compactItem 只留四字段', Object.keys(compactItem({ gid: 1, token: 't', title: 'x', pages: 3, tagsPreview: [] })).sort().join(',') === 'gid,pages,title,token');
}

// ── main ───────────────────────────────────────────────────────────────────
try {
  await testShortBody();
  await testCancel();
  await testAdaptive();
  await testMetaCompat();
  await testDiskGuard();
  await testStoreGc();
  await testSubsIncremental();
} catch (err) {
  fail += 1;
  console.log(`\n✗ 未捕获异常：${err && err.stack ? err.stack : err}`);
} finally {
  for (const d of tmpRoots) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
