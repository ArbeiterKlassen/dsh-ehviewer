import fs from 'node:fs';
import * as cfg from '../src/config.js';
import * as web from '../src/http.js';
import * as auth from '../src/auth.js';

const need = {
  config: ['DEFAULTS', 'getConfigPath', 'loadConfig', 'saveConfig'],
  http: ['EHBlocked', 'createClient'],
  auth: ['baseUrl', 'login', 'setCookies', 'status', 'mode', 'switchSite'],
};
const missing = [];
for (const [mod, names] of Object.entries(need)) {
  const pack = { config: cfg, http: web, auth }[mod];
  for (const n of names) if (!(n in pack)) missing.push(`${mod}.${n}`);
}

// 配置原子写 round-trip（跑完还原现场）
const p = cfg.getConfigPath();
const existed = fs.existsSync(p);
const before = existed ? fs.readFileSync(p, 'utf8') : null;
const saved = await cfg.saveConfig({ rateLimitMs: 1234, cookies: { probe: 'x' } });
const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
const reload = await cfg.loadConfig();
const roundTrip = saved.rateLimitMs === 1234 && onDisk.rateLimitMs === 1234 && reload.rateLimitMs === 1234 && reload.cookies.probe === 'x';
if (existed) fs.writeFileSync(p, before); else fs.rmSync(p, { force: true });

const d = cfg.DEFAULTS;
console.log(JSON.stringify({
  missing,
  roundTrip,
  defaults: { site: d.site, proxy: d.proxy, downloadDir: d.downloadDir, concurrency: d.concurrency, rateLimitMs: d.rateLimitMs, uaHasChrome: /Chrome\/\d+/.test(d.userAgent), dataDir: d.dataDir },
  baseUrlAuto: auth.baseUrl({ site: 'auto' }, 'exhentai'),
}, null, 0));
process.exitCode = missing.length === 0 && roundTrip ? 0 : 1;
