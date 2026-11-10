#!/usr/bin/env node
/**
 * 只跑不联网的测试（CI 用）。会起网络的那些（_t_core / _t_index / _t_image_live / _t_mcp）
 * 需要真 cookie 与代理，自己手动跑。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = [
  'smoke.mjs',
  '_t_parse.mjs',
  '_t_exports.mjs',
  '_t_local.mjs',
  '_t_adopt.mjs',
  '_t_fav.mjs',
  '_t_comments.mjs',
  '_t_compact.mjs',
  '_t_dl.mjs',
  '_t_dl2.mjs',
  '_t_tags.mjs',
];

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, file)], { cwd: path.join(here, '..'), stdio: 'inherit' });
  child.on('exit', (code) => resolve({ file, code: code ?? 1 }));
});

let bad = 0;
for (const f of files) {
  console.log(`\n── ${f} ──`);
  const r = await run(f);
  if (r.code !== 0) { bad += 1; console.log(`✗ ${f} 退出码 ${r.code}`); }
}
console.log(bad ? `\n${bad} 个测试文件失败` : '\n全部离线测试通过');
process.exit(bad ? 1 : 0);
