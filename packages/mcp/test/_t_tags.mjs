// 标签字典的离线验证：不联网，只读 src/tags-db.json 与 src/tags-alias.json
// （缺文件 / 坏别名时验证 fail-soft）
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import {
  loadTags,
  suggestTags,
  translate,
  expandQuery,
  namespaceOf,
  abbrOf,
  allNamespaces,
  aliasOf,
  listAliases,
  loadAliases,
  __selftest,
} from '../src/tags.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` → ${detail}`}`);
};

/* ---------- 1. 装载 ---------- */
const db = await loadTags();
const nsCount = Object.keys(db.namespaces).length;
const tagCount = Object.values(db.tags).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`[db] builtAt=${db.builtAt} ns=${nsCount} tags=${tagCount} zh=${Object.keys(db.zhIndex).length}`);
check('构建产物可用（12 个 ns）', nsCount === 12 && tagCount > 8000, `tags=${tagCount}`);
check('装载无 warning', db.warnings.length === 0, db.warnings.join(' | ') || 'clean');

/* ---------- 2. suggestTags ---------- */
const big = suggestTags('big b');
check('suggestTags("big b") 命中', big.length > 0, big[0]);
check('suggestTags 结果是紧凑字符串', big.every((x) => typeof x === 'string' && x.includes(':')), big.slice(0, 3).join(' / '));
check('suggestTags 英文前缀优先且 female 靠前', String(big[0]).startsWith('female:') && big.some((x) => x.startsWith('female:big breasts')), big.slice(0, 3).join(' / '));

const zhHit = suggestTags('巨乳');
check('suggestTags 支持中文子串', zhHit.some((x) => x.startsWith('female:big breasts')), zhHit[0]);

const scoped = suggestTags('b', { ns: 'f', limit: 5 });
check('suggestTags 支持 ns 缩写过滤', scoped.length > 0 && scoped.every((x) => x.startsWith('female:')), scoped.slice(0, 2).join(' / '));
check('suggestTags 空输入返回空数组', suggestTags('').length === 0);

/* ---------- 3. translate ---------- */
check('translate("巨乳")', translate('巨乳') === 'female:big breasts', translate('巨乳'));
check('translate 缩写展开 f:big breasts', translate('f:big breasts') === 'female:big breasts', translate('f:big breasts'));
check('translate 未知返回 null', translate('这个词库里没有') === null);

/* ---------- 4. expandQuery ---------- */
const ex = expandQuery('巨乳 中文');
const pair = ex.replaced.find(([from]) => from === '巨乳');
check('expandQuery 替换中文整词', pair?.[1] === 'female:big breasts', JSON.stringify(ex.replaced));
check('expandQuery 两段都替换', ex.query === 'female:big breasts language:chinese', ex.query);
check('expandQuery 未收录词给 warning', expandQuery('不存在的词').warnings.some((w) => w.includes('不存在的词')), 'ok');

const noTouch = expandQuery('big breasts');
check('expandQuery 不改英文原词', noTouch.query === 'big breasts' && noTouch.replaced.length === 0, noTouch.query);

const abbrQ = expandQuery('f:big breasts');
check('expandQuery 展开缩写前缀', abbrQ.query === 'female:big breasts', abbrQ.query);

const partial = expandQuery('巨');
check('expandQuery 不做半词替换', partial.query === '巨' && partial.replaced.length === 0, partial.query);

/* ---------- 4b. 口语别名表 ---------- */
check('replaced 带 source', ex.replaced.every((r) => r.length === 3 && ['alias', 'zh', 'abbr'].includes(r[2])), JSON.stringify(ex.replaced));
check('别名来源标 alias、缩写标 abbr', pair?.[2] === 'alias' && abbrQ.replaced[0]?.[2] === 'abbr', `${pair?.[2]} / ${abbrQ.replaced[0]?.[2]}`);

const aliases = listAliases();
const deadAliases = aliases.filter(({ tag }) => translate(tag) !== tag);
check('别名目标都存在于库', aliases.length >= 20 && deadAliases.length === 0, `${aliases.length} 条，坏 ${deadAliases.map((a) => `${a.alias}→${a.tag}`).join('; ') || 0} 条`);

check('aliasOf("NTR")', aliasOf('NTR') === 'female:netorare', aliasOf('NTR'));
check('aliasOf 大小写不敏感', aliasOf('ntr') === 'female:netorare' && aliasOf('查不到的口语词') === null, aliasOf('ntr'));
check('中文整段可直接被别名吃掉（无空格也认）', expandQuery('无码汉化').query === 'other:uncensored language:translated', expandQuery('无码汉化').query);

// 非法别名：目标 tag 不存在 → 载入时丢弃，不参与替换
const badAliasPath = join(tmpdir(), `eh-tags-alias-bad-${process.pid}.json`);
writeFileSync(badAliasPath, JSON.stringify({ version: 1, aliases: { 测试别名: 'female:no such tag' } }), 'utf8');
const badTable = await loadAliases({ path: badAliasPath });
check('非法别名被忽略', badTable.entries.length === 0 && badTable.warnings.some((w) => w.includes('测试别名')), badTable.warnings[0]);
const badQ = expandQuery('测试别名', { aliasPath: badAliasPath });
check('非法别名不参与替换', badQ.query === '测试别名' && badQ.replaced.length === 0, badQ.query);
rmSync(badAliasPath, { force: true });

// 别名文件缺失：只丢别名，中文反查与缩写照常
const noAliasQ = expandQuery('巨乳 f:big breasts', { aliasPath: join(tmpdir(), `eh-no-alias-${process.pid}.json`) });
check(
  '别名文件缺失时回落正常',
  noAliasQ.query === 'female:big breasts female:big breasts' && noAliasQ.warnings.some((w) => w.includes('别名表不可用')),
  noAliasQ.query,
);

/* ---------- 5. 命名空间 ---------- */
check('namespaceOf("female:big breasts")', namespaceOf('female:big breasts') === 'female');
check('namespaceOf("f:big breasts")', namespaceOf('f:big breasts') === 'female');
check('namespaceOf 无前缀返回 null', namespaceOf('big breasts') === null);
check('abbrOf("female")', abbrOf('female') === 'f', abbrOf('female'));
check('abbrOf 反查自身', abbrOf('l') === 'l', abbrOf('l'));

const all = allNamespaces();
check('allNamespaces 12 条且带 count', all.length === 12 && all.every((n) => n.count > 0 && n.abbr), all.map((n) => `${n.abbr}:${n.count}`).join(' '));

/* ---------- 6. 缺文件容错 ---------- */
const missing = await loadTags({ path: fileURLToPath(new URL('./__no_such_tags_db__.json', import.meta.url)) });
check('缺文件返回空结构', missing.warnings.length === 1 && Object.keys(missing.tags).length === 0, missing.warnings[0]);
check('缺文件时联想不抛', Array.isArray(suggestTags('big')) && suggestTags('zzzz').length === 0);

/* ---------- 7. 抽样中文 ---------- */
const samples = [
  ['big breasts', '巨乳'], ['lolicon', '萝莉'], ['chinese', '汉语'],
  ['sole female', '单女主'], ['nakadashi', '中出'],
];
const wrong = samples.filter(([tag, zh]) => {
  const t = translate(zh);
  return !t || !t.endsWith(`:${tag}`);
});
check('中文抽样 5 个都对', wrong.length === 0, wrong.map(([t, zh]) => `${zh}→${translate(zh) ?? 'null'}（期望 ${t}）`).join('; ') || 'all ok');

/* ---------- 8. 模块自检 ---------- */
const self = await __selftest();
check('__selftest 通过', self.ok, JSON.stringify(self.facts));

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`PASS ${pass}/${fail}`);
process.exitCode = fail ? 1 : 0;
