// 配置读写：~/.dsh-eh/config.json
// 约定：读配置永不抛异常；写配置原子落盘（.tmp + rename）。
// 另管一件事：下载根目录的默认值、按账号分层（resolveDownloadDir）与启动时建目录。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** 配置目录 = dataDir = ~/.dsh-eh */
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.dsh-eh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/**
 * 新默认下载根目录：放在 ~/.dsh 下，和 dsh 自己的数据挨着。
 * 不用项目目录，是因为换工作区 / 重装 node_modules 时 downloads 容易被清掉。
 */
export const DEFAULT_DOWNLOAD_DIR = path.join(HOME, '.dsh', 'eh-downloads');

/**
 * 旧默认值。老配置里如果是它，继续照旧用（有人已经把几百 G 下在那儿了，
 * 强行改路径等于让程序找不到文件），只在 warnings 里提示新默认在哪。
 */
export const LEGACY_DEFAULT_DOWNLOAD_DIR = path.resolve('downloads'); // 老版本默认目录（相对启动目录），只用来提示迁移

/** 桌面 Chrome 的 UA（EH 对移动端 UA 有单独的页面结构，统一用桌面版） */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 默认配置（loadConfig 会以此为底做深合并） */
export const DEFAULTS = Object.freeze({
  site: 'auto', // auto | e-hentai | exhentai
  proxy: 'socks5://127.0.0.1:10808',
  cookies: {},
  userAgent: DESKTOP_UA,
  downloadDir: DEFAULT_DOWNLOAD_DIR,
  // 按账号分目录：同一个下载根下每个账号一个子目录，
  // 免得换号/多号时不同账号的下载混在一起。
  accountScoped: true,
  concurrency: 4,
  rateLimitMs: 800,
  dataDir: CONFIG_DIR,
});

/** 配置文件的绝对路径 */
export function getConfigPath() {
  return CONFIG_PATH;
}

/** 是不是「纯对象」（深合并只对纯对象递归，数组/类实例整体替换） */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：后面的覆盖前面的；只递归纯对象，其余值直接覆盖 */
function deepMerge(base, ...patches) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const patch of patches) {
    if (!isPlainObject(patch)) continue;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    }
  }
  return out;
}

/** 把外部写入的值收一收，避免类型脏掉整个客户端 */
function sanitize(cfg) {
  const out = { ...cfg };

  if (!['auto', 'e-hentai', 'exhentai'].includes(out.site)) out.site = 'auto';
  if (typeof out.proxy !== 'string') out.proxy = DEFAULTS.proxy;
  out.proxy = out.proxy.trim();

  if (!isPlainObject(out.cookies)) out.cookies = {};
  // cookie 只保留字符串值
  out.cookies = Object.fromEntries(
    Object.entries(out.cookies)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => [String(k), String(v)]),
  );

  if (typeof out.userAgent !== 'string' || !out.userAgent.trim()) out.userAgent = DESKTOP_UA;
  if (typeof out.downloadDir !== 'string' || !out.downloadDir.trim()) out.downloadDir = DEFAULTS.downloadDir;
  // 只有显式 false 才关；写成字符串 "false" 之类当默认（开）处理
  out.accountScoped = out.accountScoped !== false;

  const n = Number(out.concurrency);
  out.concurrency = Number.isFinite(n) ? Math.min(16, Math.max(1, Math.trunc(n))) : DEFAULTS.concurrency;

  const r = Number(out.rateLimitMs);
  out.rateLimitMs = Number.isFinite(r) ? Math.min(60000, Math.max(0, Math.trunc(r))) : DEFAULTS.rateLimitMs;

  if (typeof out.dataDir !== 'string' || !out.dataDir.trim()) out.dataDir = CONFIG_DIR;
  return out;
}

/** 展开开头的 ~（配置里手写 '~/xxx' 很常见） */
function expandHome(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~') return HOME;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(HOME, s.slice(2));
  return s;
}

/** 路径比较：统一分隔符、去尾斜杠、忽略大小写（Windows 上 D:\x 与 d:/x 是一回事） */
function samePath(a, b) {
  const norm = (v) => String(v ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
}

/** 旧默认值提示：只记一条 warning，不迁移目录（理由见 LEGACY_DEFAULT_DOWNLOAD_DIR） */
export function downloadDirWarnings(downloadDir) {
  if (samePath(downloadDir, LEGACY_DEFAULT_DOWNLOAD_DIR)) {
    return [
      `downloadDir 仍是旧默认值（${LEGACY_DEFAULT_DOWNLOAD_DIR}），新默认在 ${DEFAULT_DOWNLOAD_DIR}；想换用 eh_config_set 改`,
    ];
  }
  return [];
}

/** 下载根目录规范化（配置值 → 绝对路径） */
function resolveDownloadBase(dir) {
  const raw = expandHome(dir) || DEFAULT_DOWNLOAD_DIR;
  return path.resolve(raw);
}

// 进程内记住已经建过的目录，loadConfig 每次调用都试一遍 mkdir 太浪费
const _ensuredDirs = new Set();

/**
 * 建下载目录（启动 / 保存配置时用）。失败只返回 warning，不抛：
 * 目录建不起来也该让服务起来，用户还能改配置或手动建。
 * @returns {Promise<{ok: boolean, dir: string, warning?: string}>}
 */
export async function ensureDownloadDir(dir) {
  const target = resolveDownloadBase(dir);
  if (_ensuredDirs.has(target)) return { ok: true, dir: target };
  try {
    await fs.mkdir(target, { recursive: true });
    _ensuredDirs.add(target);
    return { ok: true, dir: target };
  } catch (err) {
    return { ok: false, dir: target, warning: `下载目录不可用（${target}）：${err?.code || err?.message || err}` };
  }
}

/**
 * 实际下载目录。
 * accountScoped 开（默认）时按账号分一层：exhentai 用 exh-<memberId>，
 * e-hentai 用 eh-<memberId>，没登录（无 memberId）用 anon。
 * memberId 由调用方传入（auth.status() 里有），这里不自己联网。
 *
 * @param {object} cfg 配置对象（loadConfig 的结果）
 * @param {{memberId?: string|number|null, site?: string}} [who]
 * @returns {string} 绝对路径
 */
export function resolveDownloadDir(cfg, { memberId, site } = {}) {
  const base = resolveDownloadBase(cfg?.downloadDir);
  if (cfg?.accountScoped === false) return base;

  const id = memberId === undefined || memberId === null ? '' : String(memberId).trim();
  if (!id) return path.join(base, 'anon');

  const s = String(site ?? '');
  const isExh = /^(exhentai|exh|ex)$/i.test(s.trim()) || /exhentai\.org/i.test(s);
  return path.join(base, `${isExh ? 'exh' : 'eh'}-${id}`);
}

/** 读盘（不存在 / 坏了都当空对象） */
async function readFileConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读配置：默认值 ← 文件，永不抛。
 * 顺手把下载目录建好（这就是「启动时建目录」的落点），诊断信息挂在 warnings 上。
 */
export async function loadConfig() {
  const fromDisk = await readFileConfig();
  const cfg = sanitize(deepMerge(DEFAULTS, fromDisk));

  const warnings = downloadDirWarnings(cfg.downloadDir);
  const ensured = await ensureDownloadDir(cfg.downloadDir);
  if (!ensured.ok) warnings.push(ensured.warning);

  // warnings 是给人/上层看的，不写进配置文件（saveConfig 会剥掉）
  return { ...cfg, warnings };
}

/** 原子写：先写 x.tmp 再 rename，避免半截文件 */
async function atomicWriteJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * 保存配置：默认值 ← 现有文件 ← patch，深合并后原子写，返回新配置
 * 写盘失败也返回合并后的配置（调用方至少能继续跑）。
 */
export async function saveConfig(patch = {}) {
  const fromDisk = await readFileConfig();
  const next = sanitize(deepMerge(DEFAULTS, fromDisk, patch));
  delete next.warnings; // 诊断信息只活在一次读取里，别落盘
  try {
    await atomicWriteJson(CONFIG_PATH, next);
  } catch {
    /* 磁盘问题不该把调用方带崩 */
  }
  // 改了下载目录顺便建好，省得第一次下载才发现目录不存在
  await ensureDownloadDir(next.downloadDir);
  return next;
}

/** 自检（不联网） */
export async function __selftest() {
  const cfg = await loadConfig();
  const ok =
    typeof cfg === 'object' &&
    typeof cfg.proxy === 'string' &&
    typeof cfg.downloadDir === 'string' &&
    typeof cfg.concurrency === 'number' &&
    typeof cfg.rateLimitMs === 'number' &&
    typeof cfg.accountScoped === 'boolean';
  return {
    module: 'config',
    ok,
    path: CONFIG_PATH,
    dataDir: cfg.dataDir,
    downloadDir: cfg.downloadDir,
    accountScoped: cfg.accountScoped,
    warnings: cfg.warnings || [],
  };
}
