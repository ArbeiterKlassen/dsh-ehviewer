/**
 * /api/settings/* —— 账号与配置的读写（GET 读、POST 写）。
 * 由 server.mjs 动态 import 后调用 handle(req,res,url,pathname)。
 *
 * 约定：
 *   - 全是 JSON；cookie 只回键名与长度，**任何日志/响应都不带明文**。
 *   - 写入一律走 dsh-ehviewer 的 config.saveConfig / auth.setCookies / auth.login，
 *     不自己写文件，保证和 MCP 侧读到的是同一份 ~/.dsh-eh/config.json。
 *   - 校验失败给 400 + 人话 error，内部异常才 500。
 */
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

/** workspaces 软链有时只挂在 dsh-ehviewer 那边，这里给一条绝对兜底。 */
const MCP_SRC_FALLBACK = 'D:\\DSHQQ\\dsh-ehviewer\\packages\\mcp\\src'

let modsPromise = null
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const load = async (name) => {
        try {
          return await import('dsh-ehviewer/' + name)
        } catch (err) {
          if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') throw err
          return await import(pathToFileURL(path.join(MCP_SRC_FALLBACK, name + '.js')).href)
        }
      }
      const [config, auth, http] = await Promise.all([load('config'), load('auth'), load('http')])
      return { config, auth, http }
    })().catch((err) => {
      modsPromise = null
      throw err
    })
  }
  return modsPromise
}

const SITES = ['auto', 'e-hentai', 'exhentai']
const RESTART_HINT = '设置已写盘；MCP 侧下次调用会自动读到（每次调用都重新 loadConfig），无需重启。'

// ────────────────────────────────────────────────────────────── 工具

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体太大'), { status: 413 }))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('body 必须是 JSON 对象'), { status: 400 })
    }
    return parsed
  } catch (err) {
    if (err.status) throw err
    throw Object.assign(new Error('body 不是合法 JSON'), { status: 400 })
  }
}

const bad = (message) => Object.assign(new Error(message), { status: 400 })

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function intIn(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.round(n) !== n) {
    throw bad(`${name} 必须是整数`)
  }
  if (n < min || n > max) throw bad(`${name} 要在 ${min}~${max} 之间（收到 ${n}）`)
  return n
}

/** 配置脱敏：cookie 只留键名 + 长度。 */
function maskConfig(cfg) {
  const cookies = cfg && cfg.cookies && typeof cfg.cookies === 'object' ? cfg.cookies : {}
  const present = Object.keys(cookies)
  const igneous = typeof cookies.igneous === 'string' ? cookies.igneous : ''
  return {
    site: cfg.site,
    proxy: cfg.proxy ?? '',
    downloadDir: cfg.downloadDir,
    accountScoped: cfg.accountScoped !== false,
    concurrency: cfg.concurrency,
    rateLimitMs: cfg.rateLimitMs,
    userAgent: cfg.userAgent || '',
    dataDir: cfg.dataDir || '',
    cookies: {
      present,
      memberId: cookies.ipb_member_id ? String(cookies.ipb_member_id) : null,
      igneousLen: igneous.length,
    },
    warnings: Array.isArray(cfg.warnings) ? cfg.warnings : [],
  }
}

/** POST /api/settings 的字段白名单 + 校验。未知字段直接忽略。 */
function pickPatch(body) {
  const patch = {}
  if (body.site !== undefined) {
    const site = str(body.site).toLowerCase()
    if (!SITES.includes(site)) {
      throw bad(`site 只能是 auto / e-hentai / exhentai，收到 ${JSON.stringify(body.site)}`)
    }
    patch.site = site
  }
  if (body.proxy !== undefined) {
    if (typeof body.proxy !== 'string') throw bad('proxy 必须是字符串（空串 = 直连）')
    patch.proxy = body.proxy.trim()
  }
  if (body.downloadDir !== undefined) {
    const dir = str(body.downloadDir)
    if (!dir) throw bad('downloadDir 不能为空')
    patch.downloadDir = dir
  }
  if (body.dataDir !== undefined) {
    const dir = str(body.dataDir)
    if (!dir) throw bad('dataDir 不能为空')
    patch.dataDir = dir
  }
  if (body.userAgent !== undefined) {
    const ua = str(body.userAgent)
    if (!ua) throw bad('userAgent 不能为空')
    patch.userAgent = ua
  }
  if (body.accountScoped !== undefined) {
    if (typeof body.accountScoped !== 'boolean') throw bad('accountScoped 必须是 true / false')
    patch.accountScoped = body.accountScoped
  }
  if (body.concurrency !== undefined) patch.concurrency = intIn(body.concurrency, 'concurrency', 1, 16)
  if (body.rateLimitMs !== undefined) patch.rateLimitMs = intIn(body.rateLimitMs, 'rateLimitMs', 0, 60000)
  return patch
}

// ────────────────────────────────────────────────────────────── 处理

export async function handle(req, res, url, pathname) {
  try {
    const m = req.method === 'HEAD' ? 'GET' : req.method

    if (pathname === '/api/settings' && m === 'GET') return await getSettings(res)
    if (pathname === '/api/settings' && m === 'POST') return await postSettings(req, res)
    if (pathname === '/api/settings/cookies' && m === 'POST') return await postCookies(req, res)
    if (pathname === '/api/settings/login' && m === 'POST') return await postLogin(req, res)
    if (pathname === '/api/settings/status' && m === 'GET') return await getStatus(res)
    if (pathname === '/api/settings/verify' && m === 'POST') return await postVerify(res)
    if (pathname === '/api/settings/folders' && m === 'GET') return await getFolders(res, url)

    return sendJson(res, 404, { error: `未知的设置接口：${m} ${pathname}` })
  } catch (err) {
    const status = err && err.status ? err.status : 500
    if (status >= 500) {
      // 只打摘要，防止把 cookie 之类的东西带进日志
      console.error('[settings-api]', err && err.message ? err.message : err)
    }
    return sendJson(res, status, {
      error: status >= 500 ? '设置接口内部错误' : String((err && err.message) || err),
      ...(status >= 500 ? { detail: String((err && err.message) || err) } : {}),
    })
  }
}

async function getSettings(res) {
  const { config } = await mods()
  const cfg = await config.loadConfig()
  sendJson(res, 200, maskConfig(cfg))
}

async function postSettings(req, res) {
  const { config } = await mods()
  const body = await readJson(req)
  const patch = pickPatch(body)
  if (!Object.keys(patch).length) {
    throw bad('没有要改的字段（site / proxy / downloadDir / accountScoped / concurrency / rateLimitMs / userAgent / dataDir）')
  }
  const next = await config.saveConfig(patch)
  const cfg = await config.loadConfig()
  sendJson(res, 200, { ...maskConfig({ ...cfg, warnings: cfg.warnings }), saved: Object.keys(patch), restartHint: RESTART_HINT })
}

async function postCookies(req, res) {
  const { auth, config } = await mods()
  const body = await readJson(req)
  const cookieString = typeof body.cookieString === 'string' ? body.cookieString : ''
  const cookies = body.cookies && typeof body.cookies === 'object' && !Array.isArray(body.cookies) ? body.cookies : null
  if (!cookieString.trim() && !cookies) throw bad('要么给 cookieString（"k=v; k2=v2"），要么给 cookies 对象')
  const cfg = await config.loadConfig()
  const out = await auth.setCookies({ cfg, cookieString, cookies })
  const present = Array.isArray(out.keys) ? out.keys : []
  if (!present.length) throw bad('没解析出任何 cookie，检查一下粘贴内容')
  sendJson(res, 200, {
    ok: true,
    present,
    memberId: out.cfg?.cookies?.ipb_member_id ? String(out.cfg.cookies.ipb_member_id) : null,
    restartHint: RESTART_HINT,
  })
}

async function postLogin(req, res) {
  const { auth, config, http } = await mods()
  const body = await readJson(req)
  const username = str(body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!username || !password) throw bad('账号和密码都要给')

  const cfg = await config.loadConfig()
  const out = await auth.login({ cfg, username, password })
  if (!out || !out.ok) {
    // 登录失败是业务结果，不是服务器错误：200 + ok:false
    return sendJson(res, 200, { ok: false, error: (out && out.message) || '登录失败' })
  }

  // 登录成功后再拿一次状态（顺带把 memberId / site / gp 带回去）
  let status = null
  try {
    const cfg2 = await config.loadConfig()
    status = await auth.status({ cfg: cfg2 })
  } catch {
    status = null
  }
  sendJson(res, 200, {
    ok: true,
    memberId: status?.memberId || out.username || null,
    site: status?.site || (cfg.site === 'auto' ? 'exhentai' : cfg.site),
    ...(status?.gp != null ? { gp: status.gp } : {}),
    restartHint: RESTART_HINT,
  })
  void http
}

async function getStatus(res) {
  const { auth, config } = await mods()
  const cfg = await config.loadConfig()
  const st = await auth.status({ cfg })
  sendJson(res, 200, {
    loggedIn: Boolean(st && st.loggedIn),
    memberId: st?.memberId || null,
    site: st?.site || null,
    cookieAgeDays: st?.cookieAgeDays ?? null,
    ...(st?.gp != null ? { gp: st.gp } : {}),
    ...(st?.hathPerks != null ? { hathPerks: st.hathPerks } : {}),
    ...(st?.hint ? { warnings: [st.hint] } : {}),
    ...(st?.needsRelogin ? { needsRelogin: true } : {}),
  })
}

async function postVerify(res) {
  const { auth, http, config } = await mods()
  const cfg = await config.loadConfig()
  const started = Date.now()
  let client = null
  try {
    let site = cfg.site && cfg.site !== 'auto' ? cfg.site : null
    client = await http.createClient(cfg)
    if (!site) {
      try {
        site = await auth.mode({ cfg, client })
      } catch {
        site = 'e-hentai'
      }
    }
    const base = auth.baseUrl(cfg, site)
    const r = await client.get(`${base}/`, { redirect: true })
    const ms = Date.now() - started
    if (!r || r.status === 0) {
      return sendJson(res, 200, { ok: false, site, ms, error: `连不上 ${base}（${(r && r.error) || '网络错误'}）；检查代理是否在跑` })
    }
    const blocked = r.needsRelogin || (r.status !== 200 && r.status !== 302)
    sendJson(res, 200, {
      ok: !blocked,
      status: r.status,
      site,
      ms,
      ...(blocked ? { error: r.needsRelogin ? '站点不认这份 cookie（需要重新登录 / 重导 cookie）' : `站点返回 ${r.status}` } : {}),
    })
  } catch (err) {
    sendJson(res, 200, { ok: false, ms: Date.now() - started, error: String((err && err.message) || err) })
  } finally {
    try { client?.close?.() } catch { /* ignore */ }
  }
}

/** 目录浏览：只允许在 downloadDir 与用户主目录里转，防止被当成任意文件系统读取器。 */
async function getFolders(res, url) {
  const fs = await import('node:fs/promises')
  const { config } = await mods()
  const cfg = await config.loadConfig()
  const home = os.homedir()
  const roots = [path.resolve(cfg.downloadDir || home), path.resolve(home)]

  const asked = str(url.searchParams.get('path'))
  const target = path.resolve(asked || roots[0])

  const inside = (p, root) => {
    const rel = path.relative(root, p)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  if (!roots.some((root) => inside(target, root))) {
    throw bad('只能浏览下载目录或用户主目录下的路径')
  }

  let entries = []
  try {
    entries = await fs.readdir(target, { withFileTypes: true })
  } catch {
    throw bad(`目录读不了：${target}`)
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  const parent = path.dirname(target)
  sendJson(res, 200, {
    path: target,
    dirs,
    parent: roots.some((root) => inside(parent, root)) && parent !== target ? parent : null,
  })
}
