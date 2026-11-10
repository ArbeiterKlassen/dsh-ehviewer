/* 账号与配置页（独立模块，由 /settings 路由接管主区域渲染）。
 * app.js 在 route.name === 'settings' 时会调用 window.DSHEHSettings.render(main)。
 *
 * 约定：
 *   - 只用 --eh-* 主题变量，深浅色跟着 DSH 走；
 *   - cookie 只显示键名，任何地方都不回显明文；
 *   - 保存只提交改过的字段（深合并），失败把 error 摆在表单顶部。
 */
(function () {
  'use strict'

  var CSS_HREF = '/settings.css'
  var FIELD_KEYS = ['site', 'proxy', 'downloadDir', 'accountScoped', 'concurrency', 'rateLimitMs', 'userAgent']

  var state = {
    cfg: null,
    status: null,
    draft: null,
    saving: false,
    busy: false,
    toastTimer: null,
    refs: {},
  }

  var SITES = [
    { id: 'auto', label: '自动' },
    { id: 'exhentai', label: 'exhentai' },
    { id: 'e-hentai', label: 'e-hentai' },
  ]

  function ensureCss() {
    if (document.querySelector('link[data-ehs-css]')) return
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = CSS_HREF
    link.setAttribute('data-ehs-css', '1')
    document.head.appendChild(link)
  }

  function el(refs, name) {
    return refs[name]
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  async function api(path, opts) {
    var init = Object.assign({ cache: 'no-store' }, opts || {})
    if (init.body && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body)
      init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {})
    }
    var res = await fetch(path, init)
    var text = await res.text()
    var data = null
    try { data = text ? JSON.parse(text) : null } catch (e) { data = null }
    if (!res.ok) {
      var msg = (data && (data.error || data.detail)) || ('HTTP ' + res.status)
      var err = new Error(msg)
      err.status = res.status
      throw err
    }
    return data || {}
  }

  // ────────────────────────────────────────────── 渲染骨架

  function skeleton() {
    return [
      '<div class="ehs-wrap">',
      '  <div class="ehs-banner" data-ref="banner" hidden></div>',
      '  <div class="ehs-statusbar">',
      '    <div class="ehs-status-main"><span class="ehs-dot" data-ref="dot"></span><span data-ref="loginText">读取中…</span></div>',
      '    <div class="ehs-meta" data-ref="siteText"></div>',
      '    <div class="ehs-meta" data-ref="cookieAge"></div>',
      '    <span class="ehs-spacer"></span>',
      '    <button class="ehs-btn small" data-ref="verifyBtn" type="button">测试连接</button>',
      '  </div>',

      '  <section class="ehs-card">',
      '    <div class="ehs-card-head"><span class="ehs-card-title">账号</span><span class="ehs-card-sub">登录状态与 cookie</span></div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-label">账号密码登录</label>',
      '      <div class="ehs-row">',
      '        <input class="ehs-input" data-ref="user" placeholder="用户名" autocomplete="username" style="flex:1 1 140px">',
      '        <input class="ehs-input" data-ref="pass" type="password" placeholder="密码" autocomplete="current-password" style="flex:1 1 140px">',
      '        <button class="ehs-btn" data-ref="loginBtn" type="button">登录</button>',
      '      </div>',
      '      <div class="ehs-hint">用 E-Hentai 论坛账号登录，成功后自动写入 cookie；igneous 大约一个月一换，到期要重来一次。</div>',
      '    </div>',
      '    <details class="ehs-fold">',
      '      <summary>或者粘贴 cookie 串</summary>',
      '      <div class="ehs-field">',
      '        <textarea class="ehs-textarea mono" data-ref="cookie" spellcheck="false" placeholder="ipb_member_id=…; ipb_pass_hash=…; igneous=…; sk=…"></textarea>',
      '        <div class="ehs-row" style="margin-top:8px">',
      '          <button class="ehs-btn" data-ref="cookieBtn" type="button">导入</button>',
      '          <span class="ehs-hint">只写进服务端配置，不回显明文。</span>',
      '        </div>',
      '      </div>',
      '    </details>',
      '    <div class="ehs-field" style="margin-top:12px">',
      '      <label class="ehs-label">当前 cookie</label>',
      '      <div class="ehs-chips" data-ref="chips"><span class="ehs-empty">还没读到</span></div>',
      '    </div>',
      '  </section>',

      '  <section class="ehs-card">',
      '    <div class="ehs-card-head"><span class="ehs-card-title">站点与网络</span></div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-label">站点</label>',
      '      <div class="ehs-seg" data-ref="seg"></div>',
      '      <div class="ehs-hint">自动 = 先探 exhentai，没权限就退回 e-hentai。</div>',
      '    </div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-label">代理</label>',
      '      <div class="ehs-row">',
      '        <input class="ehs-input mono" data-ref="proxy" placeholder="socks5://127.0.0.1:10808" style="flex:1 1 260px">',
      '        <button class="ehs-btn small" data-ref="directBtn" type="button">直连</button>',
      '      </div>',
      '      <div class="ehs-hint">空串 = 直连。改完点「测试连接」确认能出去。</div>',
      '    </div>',
      '    <details class="ehs-fold">',
      '      <summary>User-Agent（一般不用动）</summary>',
      '      <input class="ehs-input mono" data-ref="ua" spellcheck="false">',
      '    </details>',
      '  </section>',

      '  <section class="ehs-card">',
      '    <div class="ehs-card-head"><span class="ehs-card-title">下载</span></div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-label">下载根目录</label>',
      '      <div class="ehs-row">',
      '        <input class="ehs-input mono" data-ref="downloadDir" style="flex:1 1 300px">',
      '        <button class="ehs-btn small" data-ref="browseBtn" type="button">浏览…</button>',
      '      </div>',
      '    </div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-switch"><input type="checkbox" data-ref="accountScoped"><span class="track"></span><span>按账号分目录</span></label>',
      '      <div class="ehs-hint">开启后每个账号在根目录下单独一层 exH-&lt;memberId&gt;，多号不会混在一起。</div>',
      '    </div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-label">下载并发 <b data-ref="concurrencyOut">4</b></label>',
      '      <input type="range" min="1" max="16" step="1" data-ref="concurrency" style="width:100%; accent-color: var(--eh-accent)">',
      '    </div>',
      '    <div class="ehs-field">',
      '      <label class="ehs-label">请求间隔（毫秒）</label>',
      '      <input class="ehs-input narrow" type="number" min="0" max="60000" step="10" data-ref="rateLimitMs">',
      '      <div class="ehs-hint">每张图/每个请求之间的最小间隔，太小容易被限流。</div>',
      '    </div>',
      '  </section>',

      '  <div class="ehs-actions">',
      '    <span class="ehs-dirty" data-ref="dirty"></span>',
      '    <span class="ehs-spacer"></span>',
      '    <button class="ehs-btn ghost" data-ref="resetBtn" type="button" disabled>放弃修改</button>',
      '    <button class="ehs-btn primary" data-ref="saveBtn" type="button" disabled>保存</button>',
      '  </div>',
      '</div>',
    ].join('\n')
  }

  function collectRefs(root) {
    var refs = {}
    root.querySelectorAll('[data-ref]').forEach(function (node) {
      refs[node.getAttribute('data-ref')] = node
    })
    return refs
  }

  // ────────────────────────────────────────────── 数据 → 视图

  function pickFields(cfg) {
    var out = {}
    FIELD_KEYS.forEach(function (k) { out[k] = cfg[k] })
    return out
  }

  function fillForm() {
    var r = state.refs
    var d = state.draft
    r.user.value = ''
    r.pass.value = ''
    r.cookie.value = ''
    r.proxy.value = d.proxy || ''
    r.ua.value = d.userAgent || ''
    r.downloadDir.value = d.downloadDir || ''
    r.accountScoped.checked = d.accountScoped !== false
    r.concurrency.value = String(d.concurrency)
    r.concurrencyOut.textContent = String(d.concurrency)
    r.rateLimitMs.value = String(d.rateLimitMs)

    r.seg.innerHTML = SITES.map(function (s) {
      return '<button type="button" data-site="' + s.id + '" class="' + (d.site === s.id ? 'on' : '') + '">' + esc(s.label) + '</button>'
    }).join('')
  }

  function renderStatus() {
    var r = state.refs
    var st = state.status
    if (!st) {
      r.loginText.textContent = '状态读取失败'
      r.dot.className = 'ehs-dot off'
      r.siteText.textContent = ''
      r.cookieAge.textContent = ''
      return
    }
    r.dot.className = 'ehs-dot ' + (st.loggedIn ? 'on' : 'off')
    r.loginText.textContent = st.loggedIn ? ('已登录 · ' + (st.memberId || '未知 ID')) : '未登录'
    var bits = []
    if (st.site) bits.push('站点 <b>' + esc(st.site) + '</b>')
    if (st.gp != null) bits.push('GP <b>' + esc(st.gp) + '</b>')
    r.siteText.innerHTML = bits.join(' · ')

    var age = st.cookieAgeDays
    if (age == null) {
      r.cookieAge.textContent = 'cookie 导入时间未知'
      r.cookieAge.className = 'ehs-meta'
    } else if (age >= 25) {
      r.cookieAge.textContent = 'cookie 已 ' + age + ' 天 · 该重导了'
      r.cookieAge.className = 'ehs-warn'
    } else {
      r.cookieAge.textContent = 'cookie ' + age + ' 天'
      r.cookieAge.className = 'ehs-meta'
    }
  }

  function renderChips(present) {
    var r = state.refs
    var keys = Array.isArray(present) ? present : []
    var known = ['ipb_member_id', 'ipb_pass_hash', 'igneous', 'sk']
    var all = known.slice()
    keys.forEach(function (k) { if (all.indexOf(k) < 0) all.push(k) })
    if (!keys.length) {
      r.chips.innerHTML = '<span class="ehs-empty">还没导入</span>'
      return
    }
    r.chips.innerHTML = all.map(function (k) {
      var on = keys.indexOf(k) >= 0
      return '<span class="ehs-chip' + (on ? ' on' : '') + '">' + esc(k) + (on ? '' : ' · 缺') + '</span>'
    }).join('')
  }

  function dirtyKeys() {
    if (!state.cfg || !state.draft) return []
    var base = pickFields(state.cfg)
    return FIELD_KEYS.filter(function (k) { return JSON.stringify(base[k]) !== JSON.stringify(state.draft[k]) })
  }

  function refreshDirty() {
    var r = state.refs
    var keys = dirtyKeys()
    r.saveBtn.disabled = state.saving || keys.length === 0
    r.resetBtn.disabled = state.saving || keys.length === 0
    r.dirty.textContent = keys.length ? ('有 ' + keys.length + ' 处改动未保存') : ''
  }

  function showBanner(message, kind) {
    var r = state.refs
    if (!message) {
      r.banner.hidden = true
      r.banner.textContent = ''
      return
    }
    r.banner.hidden = false
    r.banner.className = 'ehs-banner' + (kind === 'ok' ? ' ok' : '')
    r.banner.textContent = message
  }

  function toast(message, kind) {
    var node = state.refs.toast
    if (!node) {
      node = document.createElement('div')
      node.className = 'ehs-toast'
      document.body.appendChild(node)
      state.refs.toast = node
    }
    node.className = 'ehs-toast' + (kind === 'err' ? ' err' : '')
    node.textContent = message
    void node.offsetWidth
    node.classList.add('show')
    clearTimeout(state.toastTimer)
    state.toastTimer = setTimeout(function () { node.classList.remove('show') }, 2600)
  }

  // ────────────────────────────────────────────── 动作

  async function loadAll() {
    showBanner('')
    try {
      var results = await Promise.all([
        api('/api/settings'),
        api('/api/settings/status').catch(function () { return null }),
      ])
      state.cfg = results[0]
      state.status = results[1]
      state.draft = pickFields(state.cfg)
      fillForm()
      renderStatus()
      renderChips(state.cfg.cookies && state.cfg.cookies.present)
      refreshDirty()
      if (state.cfg.warnings && state.cfg.warnings.length) showBanner(state.cfg.warnings.join('；'))
    } catch (err) {
      showBanner('读配置失败：' + err.message)
    }
  }

  async function save() {
    var keys = dirtyKeys()
    if (!keys.length || state.saving) return
    state.saving = true
    refreshDirty()
    state.refs.saveBtn.textContent = '保存中…'
    var patch = {}
    keys.forEach(function (k) { patch[k] = state.draft[k] })
    try {
      var next = await api('/api/settings', { method: 'POST', body: patch })
      state.cfg = next
      state.draft = pickFields(next)
      fillForm()
      refreshDirty()
      showBanner('')
      toast('已保存：' + keys.join('、'))
      if (next.restartHint) showBanner(next.restartHint, 'ok')
      setTimeout(function () { showBanner('') }, 4000)
    } catch (err) {
      showBanner('保存失败：' + err.message)
    } finally {
      state.saving = false
      state.refs.saveBtn.textContent = '保存'
      refreshDirty()
    }
  }

  function resetDraft() {
    state.draft = pickFields(state.cfg)
    fillForm()
    refreshDirty()
    showBanner('')
  }

  async function doLogin() {
    var r = state.refs
    var username = r.user.value.trim()
    var password = r.pass.value
    if (!username || !password) {
      showBanner('账号和密码都要填')
      return
    }
    r.loginBtn.disabled = true
    r.loginBtn.textContent = '登录中…'
    showBanner('')
    try {
      var out = await api('/api/settings/login', { method: 'POST', body: { username: username, password: password } })
      if (!out.ok) {
        showBanner('登录失败：' + (out.error || '未知原因'))
        return
      }
      r.pass.value = ''
      toast('登录成功' + (out.memberId ? ' · ' + out.memberId : ''))
      await loadAll()
    } catch (err) {
      showBanner('登录失败：' + err.message)
    } finally {
      r.loginBtn.disabled = false
      r.loginBtn.textContent = '登录'
    }
  }

  async function doImportCookies() {
    var r = state.refs
    var raw = r.cookie.value.trim()
    if (!raw) {
      showBanner('先把 cookie 串粘进文本框')
      return
    }
    r.cookieBtn.disabled = true
    r.cookieBtn.textContent = '导入中…'
    try {
      var out = await api('/api/settings/cookies', { method: 'POST', body: { cookieString: raw } })
      r.cookie.value = ''
      renderChips(out.present)
      toast('已导入 ' + (out.present ? out.present.length : 0) + ' 个 cookie')
      await loadAll()
    } catch (err) {
      showBanner('导入失败：' + err.message)
    } finally {
      r.cookieBtn.disabled = false
      r.cookieBtn.textContent = '导入'
    }
  }

  async function doVerify() {
    var r = state.refs
    r.verifyBtn.disabled = true
    var old = r.verifyBtn.textContent
    r.verifyBtn.textContent = '测试中…'
    try {
      var out = await api('/api/settings/verify', { method: 'POST' })
      if (out.ok) {
        toast('连接正常 · ' + (out.site || '') + ' · ' + out.ms + 'ms')
        showBanner('')
      } else {
        showBanner('测试连接失败：' + (out.error || '未知原因'))
      }
      if (state.status) renderStatus()
    } catch (err) {
      showBanner('测试连接失败：' + err.message)
    } finally {
      r.verifyBtn.disabled = false
      r.verifyBtn.textContent = old
    }
  }

  // ── 目录选择 ──

  function openBrowser(startPath) {
    var modal = document.createElement('div')
    modal.className = 'ehs-modal'
    modal.innerHTML = [
      '<div class="ehs-modal-box">',
      '  <div class="ehs-modal-head"><span class="ehs-modal-path" data-ref="mpath">…</span></div>',
      '  <div class="ehs-modal-list" data-ref="mlist"></div>',
      '  <div class="ehs-modal-foot">',
      '    <button class="ehs-btn small" data-ref="mup" type="button">上一级</button>',
      '    <span class="ehs-spacer" style="flex:1"></span>',
      '    <button class="ehs-btn ghost small" data-ref="mcancel" type="button">取消</button>',
      '    <button class="ehs-btn primary small" data-ref="mok" type="button">用这个目录</button>',
      '  </div>',
      '</div>',
    ].join('')
    document.body.appendChild(modal)

    var mpath = modal.querySelector('[data-ref="mpath"]')
    var mlist = modal.querySelector('[data-ref="mlist"]')
    var mup = modal.querySelector('[data-ref="mup"]')
    var current = startPath || ''

    function close() {
      modal.remove()
    }
    async function go(target) {
      mlist.innerHTML = '<div class="ehs-empty">读取中…</div>'
      try {
        var q = target ? '?path=' + encodeURIComponent(target) : ''
        var out = await api('/api/settings/folders' + q)
        current = out.path
        mpath.textContent = out.path
        mup.disabled = !out.parent
        mlist.innerHTML = out.dirs.length
          ? out.dirs.map(function (d) {
            return '<div class="ehs-modal-item" data-path="' + esc(d.path) + '">📁 ' + esc(d.name) + '</div>'
          }).join('')
          : '<div class="ehs-empty">这里没有子目录</div>'
        mlist.querySelectorAll('.ehs-modal-item').forEach(function (node) {
          node.addEventListener('click', function () { go(node.getAttribute('data-path')) })
        })
      } catch (err) {
        mlist.innerHTML = '<div class="ehs-empty">读不了：' + esc(err.message) + '</div>'
      }
    }

    mup.addEventListener('click', function () {
      var parent = current.replace(/[\\/][^\\/]+$/, '')
      if (parent && parent !== current) go(parent)
    })
    modal.querySelector('[data-ref="mcancel"]').addEventListener('click', close)
    modal.querySelector('[data-ref="mok"]').addEventListener('click', function () {
      state.refs.downloadDir.value = current
      state.draft.downloadDir = current
      refreshDirty()
      close()
    })
    modal.addEventListener('click', function (ev) { if (ev.target === modal) close() })
    go(startPath)
  }

  // ────────────────────────────────────────────── 绑定

  function bind() {
    var r = state.refs
    var root = r.root

    r.seg.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-site]')
      if (!btn) return
      state.draft.site = btn.getAttribute('data-site')
      fillForm()
      refreshDirty()
    })

    r.proxy.addEventListener('input', function () { state.draft.proxy = r.proxy.value; refreshDirty() })
    r.directBtn.addEventListener('click', function () {
      state.draft.proxy = ''
      r.proxy.value = ''
      refreshDirty()
    })
    r.ua.addEventListener('input', function () { state.draft.userAgent = r.ua.value; refreshDirty() })
    r.downloadDir.addEventListener('input', function () { state.draft.downloadDir = r.downloadDir.value; refreshDirty() })
    r.browseBtn.addEventListener('click', function () { openBrowser(r.downloadDir.value || '') })
    r.accountScoped.addEventListener('change', function () {
      state.draft.accountScoped = r.accountScoped.checked
      refreshDirty()
    })
    r.concurrency.addEventListener('input', function () {
      state.draft.concurrency = Number(r.concurrency.value)
      r.concurrencyOut.textContent = r.concurrency.value
      refreshDirty()
    })
    r.rateLimitMs.addEventListener('input', function () {
      var n = Number(r.rateLimitMs.value)
      state.draft.rateLimitMs = Number.isFinite(n) ? n : 0
      refreshDirty()
    })

    r.loginBtn.addEventListener('click', doLogin)
    r.pass.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doLogin() })
    r.cookieBtn.addEventListener('click', doImportCookies)
    r.verifyBtn.addEventListener('click', doVerify)
    r.saveBtn.addEventListener('click', save)
    r.resetBtn.addEventListener('click', resetDraft)
    void root
  }

  // ────────────────────────────────────────────── 入口

  async function render(main) {
    // app.js 现在把「请求序号」当第二个参数传进来（my），不是容器本身；
    // 这里按 Element 判断，拿不到就退回主区域 #app，免得整页报错。
    var host = main && main.nodeType === 1 ? main : document.getElementById('app')
    if (!host) return
    try {
      ensureCss()
      host.innerHTML = skeleton()
      try { host.scrollTop = 0 } catch (e) {}
      var wrap = host.querySelector('.ehs-wrap')
      wrap.setAttribute('data-ehs-version', '3')
      state.refs = collectRefs(wrap)
      state.refs.root = wrap
      bind()
      renderChips([])
      await loadAll()
    } catch (err) {
      host.innerHTML = '<div class="ehs-wrap"><div class="ehs-banner">设置页渲染失败：'
        + esc((err && err.message) || err) + '<br><small>' + esc((err && err.stack) || '') + '</small></div></div>'
    }
  }

  /* 直接打开 /settings 时会踩到 app.js 的一个时序问题：它的模块顶层就跑了 render()，
   * 那时 settings.js 还没执行，window.DSHEHSettings 还不存在，于是走到
   * `my.innerHTML = …`（my 是请求序号，不是元素）→ 整页显示「出错了」。
   * app.js 不在本模块的改动范围里，所以这里做一次自愈：路由是 /settings 且看到
   * 那个错误页的「重试」按钮时，替用户点一下（重试时 DSHEHSettings 已经就绪）。 */
  function selfHeal() {
    try {
      if (!/^\/settings/.test(location.pathname)) return
      var retry = document.getElementById('retry')
      if (retry && typeof retry.click === 'function') retry.click()
    } catch (e) {}
  }

  window.DSHEHSettings = window.DSHEHSettings || {}
  window.DSHEHSettings.render = render

  // 首屏自愈：0ms / 60ms / 240ms / 700ms 各试一次（app.js 的 catch 是异步落 DOM 的）
  ;[0, 60, 240, 700].forEach(function (ms) { setTimeout(selfHeal, ms) })
})()
