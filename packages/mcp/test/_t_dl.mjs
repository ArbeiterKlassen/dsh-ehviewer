// test/_t_dl.mjs —— 本地 fixture 校验（不联网、不真实下载）
// 覆盖：store 写入/读取/原子性、downloadGallery 续传/跳过/失败记录、archiver 三步解析、checkSubs diff。
// 跑法：node test/_t_dl.mjs
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import { downloadGallery, archiveInfo, requestArchive, extFromUrl, imageFileName } from '../src/download.js';
import { checkSubs, diffNew } from '../src/subs.js';

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

function listFiles(dir) {
  return fsp.readdir(dir).then((f) => f.sort());
}

const tmpRoots = [];

// ── 1. store ───────────────────────────────────────────────────────────────
async function testStore() {
  console.log('[store]');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-test-store-'));
  tmpRoots.push(dir);
  store.__setDataDir(dir);

  // 历史
  await store.addHistory({ type: 'search', query: 'blue archive', title: 'Blue Archive' });
  await store.addHistory({ type: 'browse', title: 'Fate Zero', gid: 100 });
  await store.addHistory({ type: 'download', title: 'Fate Zero Vol.2', gid: 101 });
  ok('history 三条', (await store.listHistory({ limit: 10 })).length === 3);
  ok('history 默认最近优先', (await store.listHistory({}))[0].type === 'download');
  ok('history 按 type 过滤', (await store.listHistory({ type: 'browse' })).length === 1);
  ok('history 按 title 模糊', (await store.listHistory({ query: 'fate' })).length === 2);
  ok('history limit 生效', (await store.listHistory({ limit: 1 })).length === 1);

  // 搜索去重 + 上限
  await store.addSearch('touhou');
  await store.addSearch('  TOUHOU  ');
  const s1 = await store.listSearch({});
  ok('search 去重（忽略大小写/空白）', s1.length === 1, { s1 });
  ok('search count 累加', s1[0].count === 2, { count: s1[0].count });

  for (let i = 0; i < 505; i += 1) await store.addSearch(`q${i}`);
  const searchFile = JSON.parse(await fsp.readFile(path.join(dir, 'search.json'), 'utf8'));
  ok('search.json 上限 500', searchFile.length === 500, { n: searchFile.length });
  ok('search.json 最近优先', searchFile[0].query === 'q504', { head: searchFile[0].query });

  // 订阅
  const a = await store.addSub({ query: 'fate', category: 'doujinshi' });
  const b = await store.addSub('FATE');
  ok('addSub 按 query 去重', !!a && !!b && a.id === b.id, { a, b });
  ok('addSub 字段完整', ['id', 'query', 'category', 'seen', 'lastCheckAt', 'createdAt'].every((k) => k in a));
  ok('listSubs 一条', (await store.listSubs()).length === 1);

  const m = await store.markSeen(a.id, ['11', 12, '11']);
  ok('markSeen 合并去重', m.seen.length === 2, { seen: m.seen });
  ok('markSeen 更新 lastCheckAt', typeof m.lastCheckAt === 'string' && m.lastCheckAt.length > 0);
  ok('markSeen 不存在返回 null', (await store.markSeen('nope', ['1'])) === null);

  // 原子性：不应有 .tmp 残留，JSON 都能解析
  const files = await listFiles(dir);
  ok('无 .tmp 残留', !files.some((f) => f.endsWith('.tmp')), { files });
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    let parsed = null;
    try {
      parsed = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
    } catch {
      parsed = null;
    }
    ok(`${f} 可解析`, parsed !== null);
  }

  // 坏行容错：往 history.jsonl 里塞半行
  await fsp.appendFile(path.join(dir, 'history.jsonl'), '{"broken":\n', 'utf8');
  ok('history 跳过坏行', (await store.listHistory({ limit: 10 })).length === 3);

  ok('removeSub 成功', await store.removeSub(a.id));
  ok('removeSub 重复返回 false', (await store.removeSub(a.id)) === false);
  ok('removeSub 后为空', (await store.listSubs()).length === 0);

  const st = await store.__selftest();
  ok('store.__selftest', st.ok, { checks: st.checks.filter((c) => !c.ok) });
}

// ── 2. downloadGallery ─────────────────────────────────────────────────────
function makeClient(state) {
  return {
    async getBinary(url, opts) {
      state.calls.push({ url, referer: opts && opts.referer });
      if (url.includes('bad')) {
        const err = new Error('HTTP 403');
        err.status = 403;
        throw err;
      }
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from(`IMG:${url}`) };
    },
    async get(url) {
      state.gets.push(url);
      return { status: 200, text: state.getHtml ?? '<html></html>', finalUrl: url };
    },
    async post(url, opts) {
      state.posts.push({ url, opts });
      const next = state.postQueue && state.postQueue.length ? state.postQueue.shift() : '<html></html>';
      return { status: 200, text: next, finalUrl: url };
    },
  };
}

async function testDownload() {
  console.log('[download]');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-test-dl-'));
  tmpRoots.push(dir);

  const pages = [
    { index: 1, url: 'https://e-hentai.org/s/aaa/1-1' },
    { index: 2, url: 'https://e-hentai.org/s/bbb/1-2' },
    { index: 3, url: 'https://e-hentai.org/s/ccc/1-3' }, // 图片 403
    { index: 4, url: 'https://e-hentai.org/s/ddd/1-4' }, // 解析就失败
  ];

  const _deps = {
    listPages: async () => pages,
    resolveImage: async (client, pageUrl) => {
      if (pageUrl.includes('/ddd/')) throw new Error('image page 结构缺失');
      const n = pageUrl.slice(-1);
      return {
        index: Number(n),
        url: pageUrl.includes('/ccc/') ? 'https://img.example/bad.jpg' : `https://img.example/${n}.jpg`,
        reloadUrl: null,
        showKey: null,
        width: 1280,
        height: 1800,
        warnings: [],
      };
    },
  };

  const state = { calls: [], gets: [], posts: [], postQueue: [] };
  const client = makeClient(state);

  const progress = [];
  const gallery = { gid: 12345, token: 'deadbeef', title: 'Fixture Gallery', url: 'https://e-hentai.org/g/12345/deadbeef/' };

  const r1 = await downloadGallery({
    client,
    gallery,
    dir,
    concurrency: 2,
    onProgress: (p) => progress.push({ done: p.done, total: p.total }),
    _deps,
  });

  ok('返回目录 <gid>-<token>', path.basename(r1.dir) === '12345-deadbeef', { dir: r1.dir });
  ok('成功 2 张', r1.downloaded === 2, { got: r1.downloaded });
  ok('跳过 0 张', r1.skipped === 0);
  ok('失败 2 条（403 + 解析失败）', r1.failed.length === 2, { failed: r1.failed });
  ok('失败项带 index/url/error', r1.failed.every((f) => f.index && 'url' in f && f.error));

  const files = await listFiles(r1.dir);
  ok('文件 001.jpg / 002.jpg', files.includes('001.jpg') && files.includes('002.jpg'), { files });
  ok('无 .part 残留', !files.some((f) => f.endsWith('.part')), { files });

  const meta = JSON.parse(await fsp.readFile(path.join(r1.dir, 'meta.json'), 'utf8'));
  ok('meta.gallery.gid', meta.gallery.gid === 12345);
  ok('meta.status=partial', meta.status === 'partial', { status: meta.status });
  ok('meta.images 四条', meta.images.length === 4, { n: meta.images.length });
  ok('meta 每条记 url/index', meta.images.every((x) => 'url' in x && 'index' in x && 'page' in x));
  ok('meta 计数一致', meta.downloaded === 2 && meta.failed === 2);

  const failedJson = JSON.parse(await fsp.readFile(path.join(r1.dir, 'failed.json'), 'utf8'));
  ok('failed.json 两条', failedJson.length === 2, { n: failedJson.length });
  ok('403 图重试 3 次', failedJson.find((f) => f.index === 3).attempts === 3, { f: failedJson.find((f) => f.index === 3) });

  ok(
    '每张图都带 Referer（图片页 URL）',
    state.calls.length >= 2 && state.calls.every((c) => typeof c.referer === 'string' && c.referer.includes('/s/')),
    { calls: state.calls.slice(0, 2) },
  );
  ok('onProgress 回调 4 次', progress.length === 4, { n: progress.length });
  ok('onProgress done 递增到 total', progress.at(-1).done === 4 && progress.at(-1).total === 4, { last: progress.at(-1) });

  // 续传
  const r2 = await downloadGallery({ client, gallery, dir, concurrency: 2, _deps });
  ok('续传：跳过 2 张已存在', r2.skipped === 2, { got: r2.skipped });
  ok('续传：不重复下载', r2.downloaded === 0, { got: r2.downloaded });
  ok('续传：失败仍记录', r2.failed.length === 2);

  // 零字节文件应重下
  await fsp.writeFile(path.join(r2.dir, '001.jpg'), '');
  const r3 = await downloadGallery({ client, gallery, dir, _deps });
  ok('零字节文件重下', r3.downloaded === 1 && r3.skipped === 1, { d: r3.downloaded, s: r3.skipped });

  // 全成功时 failed.json 应被清掉
  const allOk = {
    listPages: async () => [{ index: 1, url: 'https://e-hentai.org/s/ok/2-1' }],
    resolveImage: async () => ({ index: 1, url: 'https://img.example/ok.jpg', warnings: [] }),
  };
  const r4 = await downloadGallery({ client, gallery: { gid: 999, token: 't' }, dir, _deps: allOk });
  ok('全成功 meta.status=complete', JSON.parse(await fsp.readFile(path.join(r4.dir, 'meta.json'), 'utf8')).status === 'complete');
  ok('全成功不写 failed.json', !(await listFiles(r4.dir)).includes('failed.json'));

  ok('extFromUrl', extFromUrl('https://x/a/b.PNG?x=1') === 'png' && extFromUrl('https://x/a/b') === 'jpg');
  ok('imageFileName 补零', imageFileName(7, 'webp') === '007.webp');

  const st = await import('../src/download.js').then((m2) => m2.__selftest());
  ok('download.__selftest', st.ok, { checks: st.checks.filter((c) => !c.ok) });
}

// ── 3. archiver（三步） ────────────────────────────────────────────────────
async function testArchive() {
  console.log('[archive]');

  const detailHtml = `<div id="gd5"><p>This gallery is available for download in the original format.<br>
    Download Cost: 42 GP</p><a href="/archiver.php?gid=12345&amp;token=deadbeef">Archive Download</a></div>`;

  const archiverHtml = `<div id="gd5"><p>Download Cost: 42 GP · Your GP: 1000</p>
    <a href="/archiver.php?gid=12345&amp;token=deadbeef&amp;or=org">Original</a>
    <a href="/archiver.php?gid=12345&amp;token=deadbeef&amp;or=resample">Resample</a></div>`;

  const formHtml = `<form action="/archiver.php?gid=12345&amp;token=deadbeef&amp;or=resample" method="post">
    <input type="hidden" name="dltype" value="res">
    <input type="hidden" name="dlcheck" value="abc123"></form>`;

  const finalHtml = `<p>Your archive is ready.</p><a href="/archive/12345-deadbeef.zip">Download</a>`;
  const queueHtml = `<p>You are currently in the queue. Your position: 7</p>`;

  const state = { calls: [], gets: [], posts: [], postQueue: [], getHtml: detailHtml };
  const client = makeClient(state);

  // archiveInfo：从详情页 #gd5 抠链接与费用
  const info = await archiveInfo(client, { gallery: { gid: 12345, token: 'deadbeef', url: 'https://e-hentai.org/g/12345/deadbeef/' } });
  ok('archiveInfo available', info.available === true);
  ok('archiveInfo cost=42', info.cost === 42, { cost: info.cost });
  ok('archiveInfo url 绝对化', info.url === 'https://e-hentai.org/archiver.php?gid=12345&token=deadbeef', { url: info.url });
  ok('archiveInfo hint 有内容', typeof info.hint === 'string' && info.hint.length > 0);

  const before = state.gets.length;
  const info2 = await archiveInfo(client, { gallery: { gid: 1, token: 't', html: detailHtml } });
  ok('archiveInfo 复用传入 html，不再请求', info2.cost === 42 && state.gets.length === before);

  // dryRun：只走第 1 步
  state.getHtml = archiverHtml;
  state.postQueue = [formHtml, finalHtml];
  const dry = await requestArchive(client, {
    gallery: { gid: 12345, token: 'deadbeef', url: 'https://e-hentai.org/g/12345/deadbeef/' },
  });
  ok('requestArchive 默认 dryRun', dry.dryRun === true && dry.ok === false);
  ok('dryRun 不 POST', state.posts.length === 0, { posts: state.posts.length });
  ok('dryRun 报费用', dry.cost === 42, { cost: dry.cost });
  ok('dryRun 报可用分辨率', Array.isArray(dry.resolutions) && dry.resolutions.includes('org') && dry.resolutions.includes('resample'), {
    r: dry.resolutions,
  });
  ok('dryRun message 说明未提交', /dry-run|未提交/.test(dry.message), { message: dry.message });
  ok('dryRun 给出 archiverUrl', typeof dry.archiverUrl === 'string' && dry.archiverUrl.includes('archiver.php'));

  // 真提交（仅 fixture）：POST #1 带 hathdl_xres，POST #2 带 dltype/dlcheck
  const real = await requestArchive(client, {
    gallery: { gid: 12345, token: 'deadbeef', url: 'https://e-hentai.org/g/12345/deadbeef/' },
    res: 'org',
    dryRun: false,
  });
  ok('三步共 POST 两次', state.posts.length === 2, { n: state.posts.length });
  ok('第 1 次 POST 到 or=org 链接', state.posts[0].url.includes('or=org'), { url: state.posts[0].url });
  ok('第 1 次 form hathdl_xres=org', state.posts[0].opts.form.hathdl_xres === 'org', { form: state.posts[0].opts.form });
  ok(
    '第 2 次带 dltype/dlcheck',
    state.posts[1].opts.form.dltype === 'res' && state.posts[1].opts.form.dlcheck === 'abc123',
    { form: state.posts[1].opts.form },
  );
  ok('解析出 /archive 直链', real.ok === true && real.url === 'https://e-hentai.org/archive/12345-deadbeef.zip', { real });

  // 队列：ok=true 但没有直链
  state.postQueue = [formHtml, queueHtml];
  const queued = await requestArchive(client, {
    gallery: { gid: 12345, token: 'deadbeef', url: 'https://e-hentai.org/g/12345/deadbeef/' },
    dryRun: false,
  });
  ok('队列页 ok=true 无直链', queued.ok === true && queued.url === null, { queued });
  ok('队列提示带 position', /position|排队/i.test(queued.message), { message: queued.message });
}

// ── 4. checkSubs ───────────────────────────────────────────────────────────
async function testSubs() {
  console.log('[subs]');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-test-subs-'));
  tmpRoots.push(dir);
  store.__setDataDir(dir);

  const sub1 = await store.addSub({ query: 'fate' });
  const sub2 = await store.addSub({ query: 'touhou' });

  let round = 0;
  const seenQueries = [];
  const client = { get: async () => ({ status: 200, text: '' }) };
  const _deps = {
    search: async (c, { query }) => {
      seenQueries.push(query);
      if (query === 'fate') {
        return round === 0
          ? [
              { gid: 1, token: 'a', title: 'F1' },
              { gid: 2, token: 'b', title: 'F2' },
              { gid: 3, token: 'c', title: 'F3' },
            ]
          : [
              { gid: 4, token: 'd', title: 'F4' }, // 新
              { gid: 1, token: 'a', title: 'F1' }, // 旧
            ];
      }
      return [{ gid: 90, token: 'x', title: 'T1' }];
    },
  };

  const t0 = Date.now();
  const r1 = await checkSubs({ client, base: 'https://e-hentai.org', _deps });
  const elapsed = Date.now() - t0;

  ok('两个订阅都返回', r1.length === 2, { n: r1.length });
  ok('首次全部算新', r1[0].newItems.length === 3 && r1[1].newItems.length === 1, { r1: r1.map((x) => x.newItems.length) });
  ok('订阅间至少 1.5s 间隔', elapsed >= 1400, { elapsed });
  ok('两个订阅都真的查了', seenQueries.length === 2, { seenQueries });

  const subsAfter = await store.listSubs();
  ok('seen 已写回 store', subsAfter.find((s) => s.id === sub1.id).seen.length === 3);

  round = 1;
  const r2 = await checkSubs({ client, base: 'https://e-hentai.org', _deps });
  const fate2 = r2.find((x) => x.id === sub1.id);
  ok('diff 只报新 gid', fate2.newItems.length === 1 && String(fate2.newItems[0].gid) === '4', { fate2 });
  ok('没有新作品时为空', r2.find((x) => x.id === sub2.id).newItems.length === 0);

  const _depsBad = {
    search: async (c, { query }) => {
      if (query === 'fate') throw new Error('429 too many');
      return [{ gid: 91, token: 'y', title: 'T2' }];
    },
  };
  const r3 = await checkSubs({ client, base: 'https://e-hentai.org', _deps: _depsBad });
  ok('失败订阅记 error', r3[0].error && r3[0].newItems.length === 0, { r3: r3[0] });
  ok('其它订阅照常', r3[1].newItems.length === 1, { r3: r3[1] });

  ok('diffNew 纯函数', diffNew([{ gid: 1 }, { gid: 1 }, { gid: 2 }], ['1']).length === 1);
  const st = await import('../src/subs.js').then((m) => m.__selftest());
  ok('subs.__selftest', st.ok, { checks: st.checks.filter((c) => !c.ok) });
}

// ── main ───────────────────────────────────────────────────────────────────
try {
  await testStore();
  await testDownload();
  await testArchive();
  await testSubs();
} catch (err) {
  fail += 1;
  console.log(`\n✗ 未捕获异常：${err && err.stack ? err.stack : err}`);
} finally {
  for (const d of tmpRoots) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
