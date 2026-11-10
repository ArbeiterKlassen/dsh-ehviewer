/**
 * dsh-eh-panel — host half.
 *
 * 只做三件事：
 *   1) 启动时探活配置里的 url（默认 127.0.0.1:7712），没在监听就把面板脚本用 node 拉起来
 *      （detached + stdio ignore + unref，不阻塞宿主启动；失败只打日志，绝不抛）。
 *   2) 暴露同源路由 /api/dsh-eh/{ensure,status}，浏览器半边在打开新窗口前顺手调一下。
 *   3) 插件卸载 / 宿主退出时把拉起来的子进程收掉（只收自己起的；别人起的 7712 不碰）。
 *
 * 为什么要自己找 node：桌面版宿主跑在 Electron 里，process.execPath 是 DSH 的 exe，
 * 直接拿它 spawn 等于又开一个 GUI。
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { basename, delimiter, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-eh-panel'
export const inject = []

const DEFAULT_URL = 'http://127.0.0.1:7712/'
/** 面板脚本：优先环境变量，其次同仓库的 packages/panel，最后从依赖里解析 */
function resolvePanelScript() {
  const fromEnv = process.env.DSH_EH_PANEL_SCRIPT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = fileURLToPath(new URL('../../panel/server.mjs', import.meta.url));
  if (existsSync(local)) return local;
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('dsh-ehviewer-panel/server');
  } catch {
    return local; // 交给 existsSync 判断，报 missing-script 时路径可读
  }
}
const DEFAULT_SCRIPT = resolvePanelScript()

/** 宿主这次启动的时刻：比它更早启动的面板进程一律当上一轮的遗留（可能是旧代码） */
const HOST_STARTED_AT = Date.now();
/** 本次宿主运行的标识，写进面板进程的 env，用来判断端口上跑的是不是我们这轮的 */
const OWNER = randomUUID()

/** Cordis ctx 是 Proxy：没 inject 的服务一取就抛，所以统一走 ctx.get + try。 */
function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 找真正能跑脚本的 node 可执行文件；找不到返回 null。 */
function resolveNode() {
  const fromEnv = [process.env.DSH_EH_NODE, process.env.DSH_NODE, process.env.NODE_BINARY]
  for (const candidate of fromEnv) {
    if (candidate && existsSync(candidate)) return candidate
  }
  // 宿主自己就是 node（headless / CLI 场景）
  if (/^node(\.exe)?$/i.test(basename(process.execPath))) return process.execPath
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const dirs = String(process.env.PATH || process.env.Path || '').split(delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, exe)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* PATH 里有非法项，跳过 */
    }
  }
  const fallbacks = [
    'C:\\nvm4w\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ]
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** TCP 探活：连上就算在听。 */
function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 读面板自己的 /api/health：判断端口上那个进程是谁、什么时候起的。失败返回 null。 */
/** 老版本面板没有 /api/health：用 /api/summary 认亲 */
function looksLikePanelHttp(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/api/summary', timeout: timeoutMs }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (buf.length < 4096) buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          finish(!!(j && j.counts));
        } catch { finish(false); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(false); });
    req.on('error', () => finish(false));
  });
}

/** netstat 找监听端口的 pid（给没有 health 的老进程用） */
function listenerPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch { /* ignore */ }
  return null;
}

function fetchHealth(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (buf.length < 8192) buf += c; });
      res.on('end', () => {
        try { finish(JSON.parse(buf)); } catch { finish(null); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
    req.on('error', () => finish(null));
  });
}

export function apply(ctx, config = {}) {
  const url = typeof config.url === 'string' && config.url ? config.url : DEFAULT_URL
  const script = typeof config.script === 'string' && config.script.trim() ? config.script.trim() : DEFAULT_SCRIPT
  const logger = service(ctx, 'logger')

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    parsed = new URL(DEFAULT_URL)
  }
  const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))

  let child = null
  let lastResult = { ok: false, reason: 'not-probed', at: 0 }
  let starting = null

  const log = (level, message) => {
    try {
      logger?.[level]?.(`[dsh-eh] ${message}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  async function startOnce() {
    if (await probePort(host, port)) {
      const rawHealth = await fetchHealth(port);
      // 只有真带 ok+pid 的才算新面板；老版本这里会回 {"error":"未知接口"}
      const health = rawHealth && rawHealth.ok === true && Number(rawHealth.pid) > 0 ? rawHealth : null;
      const stale = !health
        || health.owner !== OWNER
        || Date.parse(health.startedAt || 0) < HOST_STARTED_AT - 3000;
      if (!stale) return { ok: true, listening: true, started: false, pid: health.pid ?? null };

      // 端口上是上一轮留下的（甚至可能是旧代码）：确认是面板脚本再收掉，别的进程不碰
      let victim = health?.pid ?? null;
      if (!health) {
        // 老版本没 health：靠 /api/summary 认亲 + netstat 找 pid
        if (!(await looksLikePanelHttp(port))) {
          log('warn', '端口被别的进程占着，而且不像面板，跳过本次拉起');
          return { ok: true, listening: true, started: false, reason: 'occupied-by-other' };
        }
        victim = listenerPid(port);
        if (!victim) {
          return { ok: false, listening: true, started: false, reason: 'stale-no-pid' };
        }
      }
      log('info', `收掉上一轮遗留的面板进程 pid=${victim}`);
      try {
        spawn('taskkill', ['/PID', String(victim), '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* 没杀掉就等下面探活，端口没空会报 stale-kill-failed */
      }
      for (let i = 0; i < 15; i += 1) {
        await sleep(200);
        if (!(await probePort(host, port, 300))) break;
      }
      if (await probePort(host, port, 300)) {
        return { ok: false, listening: true, started: false, reason: 'stale-kill-failed', pid: health?.pid ?? null };
      }
    }
    if (!existsSync(script)) {
      log('warn', `面板脚本不存在：${script}`)
      return { ok: false, listening: false, started: false, reason: 'missing-script', script }
    }
    if (child && child.exitCode === null) {
      return { ok: false, listening: false, started: false, reason: 'spawn-in-flight', pid: child.pid }
    }
    const node = resolveNode()
    if (!node) {
      log('warn', '找不到 node 可执行文件，无法拉起面板')
      return { ok: false, listening: false, started: false, reason: 'no-node' }
    }
    try {
      child = spawn(node, [script], {
        cwd: dirname(script),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, DSH_EH_HOST: host, DSH_EH_PORT: String(port), DSH_EH_OWNER: OWNER },
      })
      child.once('error', (err) => log('warn', `spawn 出错：${err?.message ?? err}`))
      child.once('exit', (code, signal) => log('info', `面板进程退出 code=${code} signal=${signal}`))
      child.unref()
      log('info', `已拉起面板：${script} (pid=${child.pid}, node=${node})`)
    } catch (err) {
      log('warn', `拉起面板失败：${err?.message ?? err}`)
      child = null
      return { ok: false, listening: false, started: false, reason: 'spawn-failed', message: String(err?.message ?? err) }
    }
    // 最多等 4 秒，出图比阻塞宿主启动重要得多
    for (let i = 0; i < 20; i += 1) {
      await sleep(200)
      if (await probePort(host, port, 400)) {
        log('info', `面板已在 ${url} 就绪`)
        return { ok: true, listening: true, started: true, pid: child?.pid ?? null }
      }
    }
    return { ok: false, listening: false, started: true, reason: 'not-listening', pid: child?.pid ?? null }
  }

  /** 并发去重：同一时刻只跑一次 ensure。 */
  function ensure() {
    if (!starting) {
      starting = startOnce()
        .catch((err) => ({ ok: false, reason: 'exception', message: String(err?.message ?? err) }))
        .then((result) => {
          lastResult = { ...result, at: Date.now() }
          starting = null
          return lastResult
        })
    }
    return starting
  }

  function stopChild() {
    if (!child) return
    try {
      if (child.exitCode === null) child.kill()
    } catch {
      /* 已经死了 */
    }
    child = null
  }

  // ① 启动就保证面板在跑（不 await，不拖慢宿主）
  ctx.effect(() => {
    void ensure()
    let stopped = false
    const timer = setInterval(() => {
      if (stopped) return
      void (async () => {
        if (await probePort(host, port, 500)) return
        log('info', '探活失败，面板不在监听，重新拉起')
        child = null
        await ensure()
      })().catch(() => {})
    }, 60_000)
    try { timer.unref?.() } catch { /* ignore */ }
    return () => { stopped = true; clearInterval(timer); stopChild() }
  }, 'dsh-eh: panel supervisor')

  const onExit = () => stopChild()
  try {
    process.once('exit', onExit)
  } catch {
    /* ignore */
  }

  // ② 同源路由：客户端点按钮前调 ensure，点完可以调 status 看结论
  const web = service(ctx, 'webServer')
  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }
  if (web && typeof web.register === 'function') {
    web.register({
      kind: 'exact',
      path: '/api/dsh-eh/ensure',
      handler: async (req, res) => {
        const result = await ensure()
        sendJson(res, 200, { ...result, url, script })
      },
    })
    web.register({
      kind: 'exact',
      path: '/api/dsh-eh/status',
      handler: async (req, res) => {
        const listening = await probePort(host, port)
        sendJson(res, 200, { listening, url, script, pid: child?.pid ?? null, last: lastResult })
      },
    })
  } else {
    log('warn', 'webServer 不可用：只保留启动时拉起与退出清理')
  }

  log('info', `就绪（目标 ${url}）`)
}
