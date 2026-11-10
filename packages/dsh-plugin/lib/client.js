/* dsh-eh-panel — browser half (hand-written __ModuleLoader__ bundle, no build step).
 *
 * 侧边栏一行 DSH-EH（sidebar.panellist，order 33）→ 原生 layout.selectPanel('dsh-eh')
 * → 主区域换成同名 main 面板，iframe 内嵌 http://127.0.0.1:7712/。
 *
 * v3：主题桥。把 DSH 的 CSS 变量读出来、按 8 个 --eh-* 键下发进 iframe，
 *     深/浅色跟随 body[data-ds-dark-theme]、MutationObserver + prefers-color-scheme。
 */
/* 每次加载清掉 v1 可能残留的捕获期 click 拦截（HMR 换模块时旧监听器不会自己消失）。 */
try { console.info('[dsh-eh] client v3 loaded') } catch (e) {}
try {
  if (typeof window.__dshEhPanelClickHook__ === 'function') {
    document.removeEventListener('click', window.__dshEhPanelClickHook__, true)
    delete window.__dshEhPanelClickHook__
  }
} catch (e) {}

window.__ModuleLoader__.load({
  id: 'dsh-eh-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    var PANEL_ID = 'dsh-eh'
    var LABEL = 'DSH-EH'
    var URL_ = 'http://127.0.0.1:7712/'
    var ENSURE = 'api/dsh-eh/ensure'
    var STATUS = 'api/dsh-eh/status'
    var LOG = '[dsh-eh]'

    function getJson(path) {
      try {
        return fetch(path, { cache: 'no-store' }).then(function (r) { return r.json() }).catch(function () { return null })
      } catch (e) {
        return Promise.resolve(null)
      }
    }

    function openExternal() {
      try { window.open(URL_, '_blank') } catch (e) {}
    }

    /** 直接探面板本体：no-cors 拿不到内容，但连得上就 resolve、被拒就 reject。
     *  不依赖宿主路由（宿主 HTTP 路由现在要鉴权，裸 fetch 会 401，不能拿它当唯一判据）。 */
    function probePanel() {
      try {
        return fetch(URL_, { mode: 'no-cors', cache: 'no-store' }).then(function () { return true }).catch(function () { return false })
      } catch (e) {
        return Promise.resolve(false)
      }
    }

    // ───────────────────────── 主题桥 ─────────────────────────
    // 8 个键 ↔ DSH 实际 token（都带候选，取第一个有值的；全空就留空，面板自己有兜底）。
    // token 名来自 @deepseek-ai/dsh-client-ui-theme 的样式表，不是猜的。
    var THEME_MAP = [
      ['--eh-bg', ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-static-neutral-00']],
      ['--eh-bg-elev', ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-base']],
      ['--eh-bg-hover', ['--dsw-alias-interactive-bg-hover', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1']],
      ['--eh-border', ['--dsw-alias-border-l2', '--dsw-alias-border-l1', '--dsw-alias-border-l3']],
      ['--eh-text', ['--dsw-alias-label-primary']],
      ['--eh-text-dim', ['--dsw-alias-label-secondary', '--dsw-alias-label-tertiary']],
      ['--eh-accent', ['--dsw-alias-brand-primary', '--dsw-alias-state-business-primary', '--dsw-alias-button-primary-fill']],
      ['--eh-accent-dim', ['--dsw-alias-button-primary-dimmed', '--dsw-alias-state-business-primary', '--dsw-alias-brand-primary']],
    ]

    /** 从 body 的计算样式取 token（body 继承 :root，也覆盖挂在 body 上的深色规则）。 */
    function readToken(names) {
      try {
        var bs = getComputedStyle(document.body)
        var rs = getComputedStyle(document.documentElement)
        for (var i = 0; i < names.length; i += 1) {
          var v = (bs.getPropertyValue(names[i]) || '').trim()
          if (!v) v = (rs.getPropertyValue(names[i]) || '').trim()
          if (v) return v
        }
      } catch (e) {}
      return ''
    }

    /** 当前主题快照：{ type, mode, vars } */
    function themeSnapshot() {
      var vars = {}
      for (var i = 0; i < THEME_MAP.length; i += 1) {
        vars[THEME_MAP[i][0]] = readToken(THEME_MAP[i][1])
      }
      var dark = false
      try { dark = !!(document.body && document.body.hasAttribute('data-ds-dark-theme')) } catch (e) {}
      return { type: 'dsh-eh:theme', mode: dark ? 'dark' : 'light', vars: vars }
    }

    /** 下发给 iframe。窗口没就绪时静默跳过。 */
    function postTheme(win) {
      try {
        if (!win) return
        win.postMessage(themeSnapshot(), '*')
      } catch (e) {}
    }

    // ── 侧边栏图标（18px，跟随 currentColor） ──
    function Glyph(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, [
        h('rect', { key: 'a', x: 3, y: 4.5, width: 18, height: 15, rx: 3 }),
        h('path', { key: 'b', d: 'M7.4 9.2h3.1' }),
        h('path', { key: 'c', d: 'M7.4 13h3.1' }),
        h('path', { key: 'd', d: 'M14.2 8.4v8.2' }),
        h('path', { key: 'e', d: 'M17.6 8.4v8.2' }),
        h('path', { key: 'f', d: 'M14.2 12.5h3.4' }),
      ])
    }

    /** 壳子样式全部吃主题变量；取不到时退回原来的深色常量。 */
    function makeStyles(vars) {
      var bg = vars['--eh-bg'] || '#101014'
      var elev = vars['--eh-bg-elev'] || '#15151a'
      var text = vars['--eh-text'] || '#e6e6ea'
      var dim = vars['--eh-text-dim'] || 'rgba(200,205,215,.62)'
      var border = vars['--eh-border'] || 'rgba(127,127,127,.22)'
      return {
        root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: bg, color: text },
        bar: {
          display: 'flex', alignItems: 'center', gap: 8, flex: 'none',
          height: 36, padding: '0 10px 0 12px', boxSizing: 'border-box',
          borderBottom: '1px solid ' + border, background: elev,
        },
        title: { fontSize: 13, fontWeight: 600, letterSpacing: '.04em', color: text },
        dot: function (on) {
          return { width: 6, height: 6, borderRadius: '50%', background: on ? '#37c26a' : dim, flex: 'none' }
        },
        host: { fontSize: 11, color: dim, lineHeight: '16px' },
        spacer: { flex: 1 },
        iconBtn: {
          font: 'inherit', fontSize: 12, lineHeight: '20px', padding: '0 8px', height: 24, cursor: 'pointer',
          color: text, background: 'transparent', border: '1px solid ' + border, borderRadius: 6,
        },
        link: {
          font: 'inherit', fontSize: 11, lineHeight: '20px', padding: '0 6px', cursor: 'pointer',
          color: dim, background: 'transparent', border: 0, textDecoration: 'underline', textUnderlineOffset: 2,
        },
        frameWrap: { flex: 1, minHeight: 0, position: 'relative', background: bg },
        frame: { width: '100%', height: '100%', border: 0, display: 'block', background: bg, colorScheme: 'normal' },
        empty: { margin: 'auto', textAlign: 'center', padding: 24, maxWidth: 460 },
        emptyTitle: { fontSize: 14, fontWeight: 600, marginBottom: 6, color: text },
        emptyText: { fontSize: 12, lineHeight: 1.7, color: dim },
        primary: {
          font: 'inherit', fontSize: 12, lineHeight: '20px', padding: '4px 14px', marginTop: 14, cursor: 'pointer',
          color: bg, background: text, border: 0, borderRadius: 6, fontWeight: 600,
        },
      }
    }

    function Toolbar(props) {
      var S = props.S
      return h('div', { style: S.bar }, [
        h('span', { key: 'd', style: S.dot(props.live), title: props.live ? '面板在线' : '面板离线' }),
        h('span', { key: 't', style: S.title }, LABEL),
        h('span', { key: 'h', style: S.host }, URL_),
        h('span', { key: 's', style: S.spacer }),
        h('button', { key: 'r', type: 'button', style: S.iconBtn, onClick: props.onRefresh, title: '重新加载 iframe' }, '刷新'),
        h('button', { key: 'o', type: 'button', style: S.link, onClick: openExternal, title: '在系统浏览器打开' }, '在浏览器打开'),
      ])
    }

    // ── 主区域面板 ──
    function Panel() {
      var st = useState({ phase: 'checking', why: '' })
      var state = st[0]
      var setState = st[1]
      var nc = useState(0)
      var nonce = nc[0]
      var setNonce = nc[1]
      var th = useState(function () { return themeSnapshot() })
      var theme = th[0]
      var setTheme = th[1]
      var frameRef = useRef(null)
      var S = makeStyles(theme.vars)

      // 主题跟随：body 属性变化 + 系统深色偏好变化
      useEffect(function () {
        var push = function () { setTheme(themeSnapshot()) }
        var mo = null
        try {
          if (window.MutationObserver && document.body) {
            mo = new MutationObserver(push)
            mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-ds-theme-source', 'style', 'class'] })
          }
        } catch (e) {}
        var mq = null
        var onMq = function () { push() }
        try {
          mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
          if (mq) {
            if (mq.addEventListener) mq.addEventListener('change', onMq)
            else if (mq.addListener) mq.addListener(onMq)
          }
        } catch (e) {}
        push()
        return function () {
          try { if (mo) mo.disconnect() } catch (e) {}
          try {
            if (mq) {
              if (mq.removeEventListener) mq.removeEventListener('change', onMq)
              else if (mq.removeListener) mq.removeListener(onMq)
            }
          } catch (e) {}
        }
      }, [])

      // 主题一变就补发一次（iframe 没加载完也没关系，load/ready 还会再发）
      useEffect(function () {
        try {
          var line = []
          for (var i = 0; i < THEME_MAP.length; i += 1) {
            var k = THEME_MAP[i][0]
            line.push(k + '=' + (theme.vars[k] || '(empty)'))
          }
          var src = ''
          try { src = (document.body.getAttribute('data-ds-theme-source') || '') } catch (e) {}
          console.info('[dsh-eh] theme ' + theme.mode + ' src=' + (src || '?') + ' | ' + line.join(' '))
        } catch (e) {}
        postTheme(frameRef.current && frameRef.current.contentWindow)
      }, [theme, nonce])

      // 面板启动后会 postMessage({type:'dsh-eh:ready'})，收到就补发，防时序错过
      useEffect(function () {
        var onMsg = function (ev) {
          var d = ev && ev.data
          if (!d || d.type !== 'dsh-eh:ready') return
          postTheme(frameRef.current && frameRef.current.contentWindow)
        }
        window.addEventListener('message', onMsg)
        return function () { window.removeEventListener('message', onMsg) }
      }, [])

      useEffect(function () {
        var alive = true
        setState({ phase: 'checking', why: '' })
        probePanel().then(function (up) {
          if (!alive) return
          if (up) { setState({ phase: 'ready', why: '' }); return }
          getJson(STATUS).then(function (j) {
            if (!alive) return
            var why = (j && j.last && j.last.reason) || 'not-listening'
            setState({ phase: 'down', why: why })
          })
        })
        return function () { alive = false }
      }, [nonce])

      function startServer() {
        setState({ phase: 'starting', why: '' })
        getJson(ENSURE).then(function (j) {
          probePanel().then(function (up) {
            if (up) setState({ phase: 'ready', why: '' })
            else setState({ phase: 'down', why: (j && (j.reason || j.message)) || 'ensure-failed' })
          })
        })
      }

      function onFrameLoad() {
        postTheme(frameRef.current && frameRef.current.contentWindow)
      }

      var body
      if (state.phase === 'ready') {
        body = h('div', { key: 'f', style: S.frameWrap },
          h('iframe', {
            key: 'frame-' + nonce,
            ref: frameRef,
            src: URL_,
            style: S.frame,
            title: LABEL,
            allow: 'clipboard-read; clipboard-write',
            referrerPolicy: 'no-referrer',
            onLoad: onFrameLoad,
          }))
      } else if (state.phase === 'checking' || state.phase === 'starting') {
        body = h('div', { key: 'c', style: S.empty }, [
          h('div', { key: 'a', style: S.emptyTitle }, state.phase === 'starting' ? '正在启动面板服务…' : '正在检查面板服务…'),
          h('div', { key: 'b', style: S.emptyText }, URL_),
        ])
      } else {
        body = h('div', { key: 'd', style: S.empty }, [
          h('div', { key: 'a', style: S.emptyTitle }, '面板服务没启动'),
          h('div', { key: 'b', style: S.emptyText },
            '127.0.0.1:7712 现在没在监听（' + String(state.why) + '）。点下面的按钮让宿主把它拉起来；也可以先在终端手动起，再点刷新。'),
          h('button', { key: 'c', type: 'button', style: S.primary, onClick: startServer }, '启动'),
        ])
      }

      return h('div', { style: S.root, 'data-dsh-eh-mode': theme.mode }, [
        h(Toolbar, { key: 'bar', S: S, live: state.phase === 'ready', onRefresh: function () { setNonce(nonce + 1) } }),
        body,
      ])
    }

    function apply(ctx) {
      var safe = function (label, fn) {
        try { return fn() } catch (e) {
          try { console.warn(LOG, label + ' degraded: ' + String((e && e.message) || e)) } catch (x) {}
        }
      }
      var slots = ctx && ctx.slots
      if (!slots) {
        try { console.warn(LOG, 'slots unavailable') } catch (e) {}
        return
      }
      safe('sidebar row', function () {
        slots.inject('sidebar.panellist', function () {
          return slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 33, label: LABEL },
            Glyph)
        })
      })
      safe('main panel', function () {
        slots.inject('main', function () {
          return slots.register({ name: 'main', key: PANEL_ID, label: LABEL }, Panel)
        })
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
