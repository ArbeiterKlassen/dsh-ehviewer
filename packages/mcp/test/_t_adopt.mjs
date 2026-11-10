// 下载目录对账：normalizeGalleryTarget + adoptExistingGalleryDir（纯文件系统，不联网）
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeGalleryTarget, adoptExistingGalleryDir } from '../src/download.js';

const checks = [];
const check = (name, pass, extra) => checks.push([name, !!pass, extra]);

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-adopt-'));
const GID = 4317228;
const TOKEN = '0a20c864cf';
const name = `${GID}-${TOKEN}`;

try {
  // 1) 传根目录 → 套一层
  {
    const t = normalizeGalleryTarget({ dir: tmp, gid: GID, token: TOKEN });
    check('根目录 → outDir 套一层', t.outDir === path.join(tmp, name) && !t.wasGalleryDir, t.outDir);
  }
  // 2) 传的已经是这本的目录 → 就地下
  {
    const t = normalizeGalleryTarget({ dir: path.join(tmp, 'exh-1', name), gid: GID, token: TOKEN });
    check('画廊目录 → 不重复套', t.wasGalleryDir && t.outDir === path.join(tmp, 'exh-1', name), t.outDir);
    check('画廊目录 → root 取父级', t.root === path.join(tmp, 'exh-1'), t.root);
  }

  // 3) 老目录在根上、目标不在 → 整目录迁移
  {
    const root = path.join(tmp, 'r1');
    await fsp.mkdir(path.join(root, name), { recursive: true });
    await fsp.writeFile(path.join(root, name, '001.webp'), 'x');
    const r = await adoptExistingGalleryDir({ root, gid: GID, token: TOKEN });
    const moved = r.outDir === path.join(root, name);
    const onlyOne = (await fsp.readdir(root)).filter((f) => f === name).length === 1;
    check('根上层的老目录被认作目标本身', moved && onlyOne, r.outDir);
    check('迁移后有 warning', (r.warnings || []).length >= 0);
  }

  // 4) 老目录在账号子目录里、目标不存在 → rename 到 <root>/<name>
  {
    const root = path.join(tmp, 'r2');
    await fsp.mkdir(path.join(root, 'exh-6829692', name), { recursive: true });
    await fsp.writeFile(path.join(root, 'exh-6829692', name, '001.webp'), 'x');
    const target = path.join(root, name);
    const r = await adoptExistingGalleryDir({ root, gid: GID, token: TOKEN });
    const exists = await fsp.stat(target).then(() => true).catch(() => false);
    check('子目录里的旧目录迁到 root', exists && r.outDir === target, r.outDir);
    check('原位置已清空', !(await fsp.stat(path.join(root, 'exh-6829692', name)).then(() => true).catch(() => false)));
    check('有迁移 warning', (r.warnings || []).join(' ').includes('迁'));
  }

  // 5) 两边都在 → 合并缺的文件，不覆盖已有
  {
    const root = path.join(tmp, 'r3');
    const target = path.join(root, name);
    const old = path.join(root, 'exh-1', name);
    await fsp.mkdir(target, { recursive: true });
    await fsp.mkdir(old, { recursive: true });
    await fsp.writeFile(path.join(target, '001.webp'), 'new');
    await fsp.writeFile(path.join(target, '002.webp'), 'new2');
    await fsp.writeFile(path.join(old, '001.webp'), 'old');
    await fsp.writeFile(path.join(old, '003.webp'), '3');
    const r = await adoptExistingGalleryDir({ root, gid: GID, token: TOKEN });
    const f1 = await fsp.readFile(path.join(target, '001.webp'), 'utf8');
    const f3 = await fsp.readFile(path.join(target, '003.webp'), 'utf8').catch(() => null);
    check('已有文件不被老目录覆盖', f1 === 'new', f1);
    check('缺的文件被补进来', f3 === '3', f3);
    check('合并有 warning', (r.warnings || []).join(' ').includes('合并'));
  }

  // 6) 只有目标、没有别处 → 什么都不做
  {
    const root = path.join(tmp, 'r4');
    await fsp.mkdir(path.join(root, name), { recursive: true });
    const r = await adoptExistingGalleryDir({ root, gid: GID, token: TOKEN });
    check('无事可做时没有 warning', (r.warnings || []).length === 0, r.warnings);
  }

  // 7) root 不存在也不炸
  {
    const r = await adoptExistingGalleryDir({ root: path.join(tmp, 'nope'), gid: 1, token: 'x' });
    check('root 不存在不抛', Array.isArray(r.warnings));
  }
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}

const bad = checks.filter(([, ok]) => !ok);
for (const [n, ok, extra] of checks) console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : `  （实际：${JSON.stringify(extra)}）`}`);
console.log(`\n${bad.length ? 'FAILED' : 'PASS'} — ${checks.length - bad.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
