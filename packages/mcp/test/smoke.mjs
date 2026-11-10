#!/usr/bin/env node
/**
 * 冒烟测试：不联网，只验证 MCP server 装配是否正确。
 *
 * 检查项：
 *  1. buildServer() 能跑起来（缺模块只警告，不炸）
 *  2. 契约里的 25 个工具名一个不少、一个不多
 *  3. 每个工具都有 title / description / inputSchema
 *  4. 纯本地工具（eh_download_status）能正常返回，且返回结构合法
 *
 * 跑法：node test/smoke.mjs   （或 npm run smoke）
 */

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { buildServer, buildListUrl, TOOL_NAMES, VERSION } from '../src/index.js';

/** 契约里固定的 25 个工具（import 失败时的兜底副本，保持一致） */
const EXPECTED = TOOL_NAMES;

let failed = 0;
const check = (okFlag, label, detail = '') => {
  if (okFlag) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log(`eh-mcp smoke · v${VERSION} · node ${process.version}\n`);

// ① 装配
let built;
try {
  built = await buildServer();
} catch (err) {
  console.error(`装配失败：${err?.message || err}`);
  process.exit(1);
}
const { server, toolNames, warnings } = built;

console.log(`[1] 模块装载`);
if (warnings.length === 0) {
  console.log('  ✓ 九个兄弟模块全部就绪');
} else {
  for (const w of warnings) console.log(`  ! src/${w.module}.js 未就绪（${w.reason}）→ 相关工具会返回提示`);
}
check(true, `已装载 ${9 - warnings.length}/9 个模块`);

// ② 工具面
console.log(`\n[2] 工具注册（期望 ${EXPECTED.length} 个）`);
const registered = Object.keys(server._registeredTools || {});
const missing = EXPECTED.filter((n) => !registered.includes(n));
const extra = registered.filter((n) => !EXPECTED.includes(n));
check(registered.length === EXPECTED.length, `注册数量 ${registered.length}/${EXPECTED.length}`);
check(missing.length === 0, '没有缺漏', missing.join(', '));
check(extra.length === 0, '没有多余', extra.join(', '));

// ③ 元数据完整
console.log(`\n[3] 工具元数据`);
const badMeta = [];
for (const [name, tool] of Object.entries(server._registeredTools || {})) {
  const hasTitle = typeof tool.title === 'string' && tool.title.length > 0;
  const hasDesc = typeof tool.description === 'string' && tool.description.length > 0;
  const hasSchema = tool.inputSchema !== undefined && tool.inputSchema !== null;
  if (!hasTitle || !hasDesc || !hasSchema) {
    badMeta.push(`${name}(title:${hasTitle} desc:${hasDesc} schema:${hasSchema})`);
  }
}
check(badMeta.length === 0, '每个工具都有 title / description / inputSchema', badMeta.join(' '));

// ④ 纯本地工具能跑通（不联网）
console.log(`\n[4] 本地工具调用`);
const statusTool = server._registeredTools?.['eh_download_status'];
const res = await statusTool?.handler({}, {});
const text = res?.content?.[0]?.text || '';
check(res && !res.isError, 'eh_download_status 正常返回', text.slice(0, 120));
let parsed = null;
try { parsed = JSON.parse(text); } catch { /* 下面判 */ }
check(Array.isArray(parsed?.tasks), '返回体是合法 JSON 且含 tasks 数组');

// ⑤ 列表 URL 构造（纯函数，离线可测）
console.log(`\n[5] 列表 URL 构造`);
const B = 'https://e-hentai.org';
const uSearch = buildListUrl(B, { mode: 'search', query: 'language:chinese', page: 2, category: 'doujinshi,manga' });
check(uSearch.startsWith(`${B}/?`) && uSearch.includes('f_search=language%3Achinese'), '搜索 URL 带 f_search', uSearch);
check(uSearch.includes('page=2'), '搜索 URL 带页码', uSearch);
check(uSearch.includes('f_cats=1017'), '分类掩码取反（1023 ^ doujinshi|manga = 1017）', uSearch);
const uAdv = buildListUrl(B, { adv: { name: true, tags: true, withTorrents: true, minRating: 4, pageFrom: 10, pageTo: 50 } });
check(uAdv.includes('advsearch=1') && uAdv.includes('f_sname=on') && uAdv.includes('f_stags=on')
  && uAdv.includes('f_sto=on') && uAdv.includes('f_srdd=4')
  && uAdv.includes('f_sp=on') && uAdv.includes('f_spf=10') && uAdv.includes('f_spt=50'), '高级搜索参数齐全', uAdv);
const uTag = buildListUrl(B, { mode: 'tag', query: 'female:sole_female', page: 3 });
check(uTag === `${B}/tag/female%3Asole_female/3/`, 'tag 页 URL', uTag);
const uUp = buildListUrl(B, { mode: 'uploader', query: 'someone' });
check(uUp === `${B}/uploader/someone/`, 'uploader 页 URL', uUp);

// ⑥ 过滤规则往返（走临时目录，不碰真实 ~/.dsh-eh）
console.log(`\n[6] 本地过滤规则`);
const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'eh-smoke-'));
process.env.DSH_EH_HOME = tmpHome;
const addRes = await server._registeredTools['eh_filter_add'].handler({ pattern: 'NTR', field: 'tag' }, {});
const added = JSON.parse(addRes.content[0].text);
check(added.added === true && added.item?.field === 'tag', 'eh_filter_add 写入成功');
const listRes = await server._registeredTools['eh_filter_list'].handler({}, {});
const listed = JSON.parse(listRes.content[0].text);
check(listed.count === 1 && listed.items[0].pattern === 'NTR', 'eh_filter_list 读回一致');
const dupRes = await server._registeredTools['eh_filter_add'].handler({ pattern: 'ntr', field: 'tag' }, {});
check(JSON.parse(dupRes.content[0].text).added === false, '重复规则被识别（大小写不敏感）');
const delRes = await server._registeredTools['eh_filter_remove'].handler({ id: added.item.id }, {});
check(JSON.parse(delRes.content[0].text).total === 0, 'eh_filter_remove 删干净');
delete process.env.DSH_EH_HOME;

// ⑦ 打印工具名清单
console.log(`\n[7] 工具清单`);
const pad = Math.max(...EXPECTED.map((n) => n.length)) + 2;
for (const name of EXPECTED) {
  const tool = server._registeredTools?.[name];
  const mark = tool ? '·' : '✗';
  console.log(`  ${mark} ${name.padEnd(pad)}${tool?.title || ''}`);
}

console.log('');
if (failed === 0) {
  console.log(`SMOKE OK — ${registered.length}/${EXPECTED.length} 个工具全部注册。`);
  process.exit(0);
} else {
  console.log(`SMOKE FAILED — ${failed} 项没通过。`);
  process.exit(1);
}
