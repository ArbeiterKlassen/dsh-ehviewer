// 评论区解析 + 笔记库（离线，不联网）
import { parseComments } from '../src/gallery.js';
import * as notes from '../src/notes.js';

const HTML = `<!DOCTYPE html><div id="cdiv" class="gm">
<a name="c8798709"></a><div class="c1">
  <div class="c2">
    <div class="c3">Posted on 08 November 2026, 16:00 by: &nbsp; <a href="https://exhentai.org/uploader/seele44615">seele44615</a></div>
    <div class="c4 nosel">[Vote+]</div>
    <div class="c5 nosel" onmouseover="x()">Score <span id="comment_score_8798709">+10</span></div>
    <div class="c"></div>
  </div>
  <div class="c6" id="comment_8798709">大车压小孩太色了</div>
  <div class="c7" id="cvotes_8798709" style="display:none">Base +4, <span>桀桀桀大魔王 +6</span></div>
</div>
<a name="c8799820"></a><div class="c1">
  <div class="c3">Posted on 09 November 2026, 03:13 by: &nbsp; <a href="https://exhentai.org/uploader/zhuji700">zhuji700</a></div>
  <div class="c5 nosel">Score <span>+18</span></div>
  <div class="c6" id="comment_8799820">好看好看
还得是小孩开大车</div>
</div>
<div id="chd"><p id="postnewcomment">[Post New Comment]</p></div>
</div>`;

const checks = [];
const check = (name, pass, extra) => checks.push([name, !!pass, extra]);

const r = parseComments(HTML);
check('解析出 2 条', r.comments.length === 2, r.comments.length);
const c0 = r.comments[0] || {};
check('id', c0.id === 8798709, c0.id);
check('作者', c0.author === 'seele44615', c0.author);
check('时间', c0.at === '08 November 2026, 16:00', c0.at);
check('评分', c0.score === '+10', c0.score);
check('正文', c0.text === '大车压小孩太色了', c0.text);
check('投票明细', /Base \+4/.test(c0.votes || ''), c0.votes);
check('多行正文保留换行', (r.comments[1]?.text || '').includes('\n'), r.comments[1]?.text);
check('无 #cdiv 时给 warning', (() => {
  const x = parseComments('<html><body>nothing</body></html>');
  return x.comments.length === 0 && x.warnings.length > 0;
})());
check('空 HTML 不抛', (() => {
  const x = parseComments('');
  return Array.isArray(x.comments) && x.warnings.length === 1;
})());

const st = await notes.__selftest();
check('notes.__selftest', st.ok === true);

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass, extra] of checks) {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `  （实际：${JSON.stringify(extra)}）`}`);
}
console.log(`\n${failed.length ? 'COMMENTS FAILED' : 'PASS'} — ${checks.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
