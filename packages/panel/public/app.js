/* DSH-EH 本地面板前端 —— 无框架、无外部资源、fetch + pushState。 */

const app = document.getElementById('app');
const crumb = document.getElementById('crumb');
const qEl = document.getElementById('q');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');

const LABEL = { view: '看过', download: '下载', notes: '笔记', library: '本地库' };
const TYPE_LABEL = { view: '看过', download: '下载', search: '搜索' };

const state = { route: parseRoute(), q: '' };
let seq = 0;

/* ------------------------------------------------------------------ theme */

const THEME_KEYS = [
  '--eh-bg',
  '--eh-bg-elev',
  '--eh-bg-hover',
  '--eh-border',
  '--eh-text',
  '--eh-text-dim',
  '--eh-accent',
  '--eh-accent-dim',
];

const themeState = { fromParent: false };

function applyTheme(data) {
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'dsh-eh:theme') return;

  themeState.fromParent = true;
  const root = document.documentElement;

  if (data.mode === 'dark' || data.mode === 'light') root.dataset.mode = data.mode;

  // 每次都按“快照”处理：先清掉上一轮父窗口写的 8 个变量，再写这次给的。
  for (const key of THEME_KEYS) root.style.removeProperty(key);
  if (data.vars && typeof data.vars === 'object') {
    for (const [key, value] of Object.entries(data.vars)) {
      if (typeof key === 'string' && key.startsWith('--eh-') && typeof value === 'string' && value.trim()) {
        root.style.setProperty(key, value);
      }
    }
  }
}

function initTheme() {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  if (!root.dataset.mode) root.dataset.mode = mq.matches ? 'light' : 'dark';

  const onSchemeChange = (event) => {
    if (themeState.fromParent) return;
    root.dataset.mode = event.matches ? 'light' : 'dark';
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSchemeChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onSchemeChange);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent && event.source !== window) return;
    let data = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    applyTheme(data);
  });

  // 主动向父窗口要一次主题；父页面收到后会补发。
  try {
    window.parent.postMessage({ type: 'dsh-eh:ready' }, '*');
  } catch {
    /* 独立打开时 parent 就是自己，忽略即可 */
  }
}

/* ------------------------------------------------------------------ utils */

function parseRoute() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  if (p.startsWith('/read/')) {
    const parts = p.split('/');
    const token = parts[3] && parts[3] !== '-' ? parts[3] : '';
    return { name: 'read', gid: parts[2] || '', token };
  }
  if (p.startsWith('/g/')) return { name: 'gallery', gid: p.slice(3) };
  const name = p.slice(1);
  if (name === 'view' || name === 'download' || name === 'notes' || name === 'library') return { name };
  return { name: 'view' };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function hhmm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function fmtRel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  const diff = now.getTime() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `${Math.floor(diff / 3600000)} 小时前`;
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm(d)}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function imgUrl(file) { return `/img?path=${encodeURIComponent(file)}`; }

function thumbHtml(file, alt) {
  if (!file) return '<div class="ph">无封面</div>';
  return `<img src="${esc(imgUrl(file))}" alt="${esc(alt || '')}" loading="lazy">`;
}

async function api(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
    return;
  } catch { /* 走兜底 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  toast(ok ? '已复制' : '复制失败');
}

/* ----------------------------------------------------------------- router */

function navigate(href) {
  const url = new URL(href, location.origin);
  if (state.q && !url.pathname.startsWith('/g/') && !url.searchParams.has('q')) {
    url.searchParams.set('q', state.q);
  }
  history.pushState(null, '', url);
  render();
}

function commitSearch() {
  const q = qEl.value.trim();
  let pathname = location.pathname;
  if (parseRoute().name === 'gallery') pathname = '/view';
  const url = new URL(pathname, location.origin);
  if (q) url.searchParams.set('q', q);
  history.replaceState(null, '', url);
  render();
}

function setActiveNav(name) {
  document.querySelectorAll('nav a[data-nav]').forEach((a) => {
    a.classList.toggle('on', a.dataset.nav === name);
  });
}

/* --------------------------------------------------------------- fragments */

function aggregateByGid(items) {
  const map = new Map();
  for (const it of items) {
    const key = String(it.gid);
    const hit = map.get(key);
    if (hit) hit.viewCount += 1;
    else map.set(key, { ...it, viewCount: 1 });
  }
  return [...map.values()];
}

function timelineHtml(items, showType) {
  return items.map((it) => {
    const title = it.title || it.jtitle || `gid ${it.gid}`;
    const type = showType ? `<span>${esc(TYPE_LABEL[it.type] || it.type || '')}</span>` : '';
    const pages = it.pages ? `<span>${esc(String(it.pages))} 页</span>` : '';
    const site = it.site ? `<span class="dot-sep"></span><span>${esc(it.site)}</span>` : '';
    const commentBadge = it.commentCount
      ? `<span class="cmt-badge" title="${esc(String(it.commentCount))} 条评论缓存">评 ${esc(String(it.commentCount))}</span>`
      : '';
    const dup = it.viewCount > 1
      ? `<span class="dup" title="看过 ${esc(String(it.viewCount))} 次">×${esc(String(it.viewCount))}</span>`
      : '';
    return `<a class="tl-item" href="/g/${encodeURIComponent(String(it.gid))}" data-spa>
      <div class="tl-thumb">${thumbHtml(it.thumb, title)}</div>
      <div class="tl-main">
        <div class="tl-title"><span class="t">${esc(title)}</span>${it.hasNote ? '<span class="note-dot" title="有笔记"></span>' : ''}${commentBadge}</div>
        <div class="meta">${type}${type && (pages || site) ? '<span class="dot-sep"></span>' : ''}${pages}${site}<span class="dot-sep"></span><span>${esc(fmtRel(it.at))}</span></div>
      </div>
      ${dup}
    </a>`;
  }).join('');
}

function scoreNum(value) {
  const n = Number(String(value ?? '').replace(/[^\d+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function enhanceComments() {
  document.querySelectorAll('.comment .c-text').forEach((el) => {
    if (el.parentElement && el.parentElement.hidden) return;
    if (el.classList.contains('open')) return;
    if (el.scrollHeight <= el.clientHeight + 2) return;
    if (el.nextElementSibling && el.nextElementSibling.classList.contains('c-expand')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'c-expand';
    btn.textContent = '展开';
    btn.onclick = () => {
      el.classList.add('open');
      btn.remove();
    };
    el.insertAdjacentElement('afterend', btn);
  });
}

function starsHtml(rating) {
  const r = Math.max(0, Math.min(10, Number(rating) || 0));
  let out = '';
  for (let i = 1; i <= 10; i += 1) out += `<span class="${i <= r ? '' : 'off'}">★</span>`;
  return `<span class="stars" title="评分 ${r}/10">${out}</span>`;
}

function sourceTag(source) {
  if (source === 'local') return '<span class="tag local">下载</span>';
  if (source === 'online') return '<span class="tag online">线上</span>';
  return '';
}

function emptyState(title, desc, hint) {
  return `<div class="wrap"><div class="empty"><h2>${esc(title)}</h2><p>${desc}</p>${hint ? `<div class="hint">${hint}</div>` : ''}</div></div>`;
}

/* ---------------------------------------------------------------- status */

async function loadStatus() {
  try {
    const s = await api('/api/summary');
    statusEl.innerHTML = `看过 ${s.counts.view} · 下载 ${s.counts.download}<br>笔记 ${s.counts.notes} · 本地库 ${s.counts.library}`;
  } catch {
    statusEl.textContent = '数据读取失败';
  }
}

/* ----------------------------------------------------------------- views */

async function renderView(my) {
  const limit = 60;
  const q = encodeURIComponent(state.q);
  const data = await api(`/api/history?type=view&limit=${limit}&offset=0&q=${q}`);
  if (my !== seq) return;

  if (!data.total) {
    app.innerHTML = state.q
      ? emptyState('没有匹配的浏览记录', `没有标题 / gid / url 包含「${esc(state.q)}」的看过记录。`, '换个关键词，或清空搜索框。')
      : emptyState('还没有看过任何画廊', '让 agent 调一次 eh_gallery 就有了。', '看过详情页会自动记到 history.jsonl');
    return;
  }

  app.innerHTML = `<div class="wrap">
    <div class="view-head"><h1>看过</h1><span class="count">${data.total} 次</span></div>
    <div class="tl" id="tl"></div>
    <div class="more-wrap" id="more"></div>
  </div>`;

  const tl = document.getElementById('tl');
  let loaded = data.items.slice();
  const paint = () => {
    tl.innerHTML = timelineHtml(aggregateByGid(loaded));
  };
  paint();
  let offset = data.items.length;
  const moreWrap = document.getElementById('more');
  if (data.hasMore) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '加载更多';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '加载中…';
      try {
        const next = await api(`/api/history?type=view&limit=${limit}&offset=${offset}&q=${q}`);
        if (my !== seq) return;
        loaded = loaded.concat(next.items);
        paint();
        offset += next.items.length;
        if (!next.hasMore) moreWrap.remove();
        else { btn.disabled = false; btn.textContent = '加载更多'; }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '加载更多';
        toast('加载失败');
      }
    };
    moreWrap.appendChild(btn);
  }
}

async function renderDownload(my) {
  const data = await api(`/api/history?type=download&limit=300&q=${encodeURIComponent(state.q)}`);
  if (my !== seq) return;

  const seen = new Set();
  const items = [];
  for (const it of data.items) {
    const key = String(it.gid);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }

  if (!items.length) {
    app.innerHTML = state.q
      ? emptyState('没有匹配的下载', `没有标题 / gid 包含「${esc(state.q)}」的下载记录。`, '清空搜索框看重全部。')
      : emptyState('还没有下载记录', '让 agent 调 eh_download 存一本下来，封面和大小就有了。', '下载目录默认在 ~/.dsh/eh-downloads/<account>/<gid>-<token>/');
    return;
  }

  const cards = items.map((it) => {
    const title = it.title || it.jtitle || `gid ${it.gid}`;
    const size = fmtBytes(it.sizeBytes);
    const dir = it.dirResolved || it.localDir || it.dir || '';
    return `<div class="card" data-gid="${esc(String(it.gid))}">
      <div class="cover">
        ${thumbHtml(it.thumb, title)}
        <div class="overlay">
          <div class="ov-title">${esc(title)}</div>
          <div class="ov-meta">${esc(String(it.pages || it.fileCount || '?'))} 页${size ? ` · ${esc(size)}` : ''}</div>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${esc(title)}</div>
        <div class="meta"><span>${esc(String(it.fileCount || it.pages || 0))} 张</span>${size ? `<span class="dot-sep"></span><span>${esc(size)}</span>` : ''}<span class="dot-sep"></span><span>${esc(fmtRel(it.at))}</span></div>
      </div>
      <div class="card-detail">
        <div class="path-box">${esc(dir || '路径未知')}</div>
        <div class="detail-actions">
          ${dir ? `<button class="btn" data-copy-path="${esc(dir)}">打开文件夹（复制路径）</button>` : ''}
          <a class="chip" href="/g/${encodeURIComponent(String(it.gid))}" data-spa>查看画廊</a>
        </div>
        <div class="detail-note">按钮复制路径到剪贴板，不是 file:// 链接。</div>
      </div>
    </div>`;
  }).join('');

  app.innerHTML = `<div class="wrap">
    <div class="view-head"><h1>下载</h1><span class="count">${items.length} 本</span></div>
    <div class="cards" id="cards">${cards}</div>
  </div>`;

  document.getElementById('cards').addEventListener('click', (e) => {
    if (e.target.closest('[data-copy-path]')) return;
    if (e.target.closest('a[data-spa]')) return;
    const card = e.target.closest('.card');
    if (card) card.classList.toggle('open');
  });
}

async function renderNotes(my) {
  const data = await api(`/api/notes?limit=300&q=${encodeURIComponent(state.q)}`);
  if (my !== seq) return;

  if (!data.total) {
    app.innerHTML = state.q
      ? emptyState('没有匹配的笔记', `没有标题 / 正文 / gid 包含「${esc(state.q)}」的笔记。`, '清空搜索框看全部。')
      : emptyState('还没有笔记', '看画廊时让 agent 用 eh_note_save 写一条，评分和感想都会出现在这里。', '笔记存在 ~/.dsh-eh/notes.json');
    return;
  }

  const cards = data.items.map((n) => {
    const title = n.title || `gid ${n.gid}`;
    return `<div class="note-card">
      <div class="n-head">
        <div class="n-title">${esc(title)}</div>
        <div class="meta">${sourceTag(n.source)}<span class="dot-sep"></span>${starsHtml(n.rating)}</div>
      </div>
      <div class="n-body">${esc(n.note || '（没有正文）')}</div>
      <div class="n-foot">
        <div class="chip-row">
          <button class="chip" data-copy="${esc(String(n.gid))}">gid ${esc(String(n.gid))}</button>
          ${n.token ? `<button class="chip" data-copy="${esc(String(n.token))}">token ${esc(String(n.token))}</button>` : ''}
        </div>
        <div class="meta"><span>${esc(fmtRel(n.updatedAt || n.at))}</span></div>
      </div>
    </div>`;
  }).join('');

  app.innerHTML = `<div class="wrap">
    <div class="view-head"><h1>笔记</h1><span class="count">${data.total} 条</span></div>
    <div class="note-grid">${cards}</div>
  </div>`;
}

async function renderLibrary(my) {
  const data = await api(`/api/library?limit=1000&q=${encodeURIComponent(state.q)}`);
  if (my !== seq) return;

  if (data.warn && !data.total) {
    app.innerHTML = emptyState('还没有本地库索引', 'library.json 不存在，本地库视图先空着。', '先让 agent 调 eh_local_index action=rebuild。');
    return;
  }
  if (!data.total) {
    app.innerHTML = state.q
      ? emptyState('没有匹配的条目', `标题 / tag / gid 里没有「${esc(state.q)}」。`, '清空搜索框看全部。')
      : emptyState('本地库是空的', '下载目录里还没有索引到的画廊。', '让 agent 调 eh_local_index action=rebuild。');
    return;
  }

  const rows = data.items.map((e) => {
    const title = e.title || e.titleJpn || `gid ${e.gid}`;
    const tags = (e.tags || []).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    return `<tr data-href="/g/${encodeURIComponent(String(e.gid))}">
      <td class="gid">${esc(String(e.gid))}</td>
      <td><div class="clip">${esc(title)}</div>${e.titleJpn && e.titleJpn !== title ? `<span class="t2">${esc(e.titleJpn)}</span>` : ''}</td>
      <td>${esc(String(e.pages ?? '—'))}</td>
      <td><div class="tag-row">${tags || '<span class="t2">—</span>'}</div></td>
      <td><div class="clip" title="${esc(e.dir || '')}">${esc(e.dir || '—')}</div></td>
    </tr>`;
  }).join('');

  app.innerHTML = `<div class="wrap">
    <div class="view-head"><h1>本地库</h1><span class="count">${data.total} 本</span></div>
    <div class="table-wrap">
      <table>
        <colgroup><col style="width:92px"><col><col style="width:64px"><col style="width:30%"><col style="width:30%"></colgroup>
        <thead><tr><th>gid</th><th>标题</th><th>页数</th><th>tag</th><th>路径</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

async function renderGallery(my, gid) {
  const data = await api(`/api/gallery/${encodeURIComponent(gid)}`);
  if (my !== seq) return;

  const title = data.title || `gid ${gid}`;
  const hist = Array.isArray(data.history) ? data.history : [];
  const local = data.local;
  const note = data.note;
  const comments = data.comments;
  const site = hist.find((h) => h.site)?.site;
  const readBase = `/read/${encodeURIComponent(String(data.gid))}/${data.token ? encodeURIComponent(data.token) : '-'}`;
  const sourceUrl =
    (hist.find((h) => h.url) || {}).url ||
    (data.token ? `https://exhentai.org/g/${data.gid}/${data.token}/` : null);

  let onlinePreview = null;
  if (!local && data.token) {
    try {
      onlinePreview = await api(
        `/api/online/pages/${encodeURIComponent(String(data.gid))}/${encodeURIComponent(data.token)}?from=1&to=6`,
      );
    } catch {
      onlinePreview = null;
    }
    if (my !== seq) return;
  }

  const head = `<div class="detail-head">
    ${sourceUrl ? `<a class="src-link" href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">在源站打开 ↗</a>` : ''}
    <h1>${esc(title)}</h1>
    <div class="meta">
      ${site ? `<span>${esc(site)}</span><span class="dot-sep"></span>` : ''}
      ${local ? `<span>本地 ${esc(String(local.pages))} 页</span><span class="dot-sep"></span>` : ''}
      <span>${hist.length} 条记录</span>
    </div>
    <div class="chip-row">
      <button class="chip" data-copy="${esc(String(data.gid))}">gid ${esc(String(data.gid))}</button>
      ${data.token ? `<button class="chip" data-copy="${esc(String(data.token))}">token ${esc(String(data.token))}</button>` : ''}
      ${data.download ? `<button class="chip" data-copy="${esc(String(data.download))}">复制路径</button>` : ''}
      <button class="chip read-chip" data-readto="${esc(readBase)}?n=1">${local ? '阅读' : '在线阅读'}</button>
    </div>
  </div>`;

  const notePanel = note
    ? `<div class="section"><h2>笔记</h2><div class="panel section-body">
        <div class="meta" style="margin-bottom:9px">${sourceTag(note.source)}<span class="dot-sep"></span>${starsHtml(note.rating)}<span class="dot-sep"></span><span>${esc(fmtRel(note.updatedAt || note.at))}</span></div>
        <div class="note-block">${esc(note.note || '（没有正文）')}</div>
      </div></div>`
    : `<div class="section"><h2>笔记</h2><div class="panel section-body meta">这本还没有笔记。</div></div>`;

  const sortedComments = comments && Array.isArray(comments.items)
    ? comments.items.slice().sort((a, b) => scoreNum(b.score) - scoreNum(a.score))
    : [];
  const commentPanel = `<div class="section"><h2>评论${comments ? ` · ${esc(String(comments.count))}` : ''}</h2><div class="panel">
      ${sortedComments.length
        ? sortedComments.map((c, i) => `<div class="comment"${i >= 10 ? ' hidden' : ''}>
            <div class="c-head"><span class="c-score">${esc(c.score || '')}</span><span class="c-sep">·</span><span class="c-author">${esc(c.author || '匿名')}</span><span class="c-sep">·</span><span class="c-at">${esc(c.at || '')}</span></div>
            <div class="c-text">${esc(c.text || '')}</div>
          </div>`).join('')
        : '<div class="section-body meta">还没有评论缓存。让 agent 调一次 eh_comments 就有了。</div>'}
      ${sortedComments.length > 10 ? `<div class="comments-more"><button class="btn" id="cmt-more">展开全部 ${sortedComments.length} 条</button></div>` : ''}
    </div></div>`;

  const localPanel = local
    ? `<div class="section"><h2>本地文件</h2><div class="panel section-body">
        <div class="gallery">${local.files.map((f, i) => `<button class="page-tile" data-readto="${esc(readBase)}?n=${i + 1}" title="第 ${i + 1} 页"><img src="${esc(imgUrl(f))}" alt="第 ${i + 1} 页" loading="lazy"></button>`).join('')}</div>
      </div></div>`
    : `<div class="section"><h2>本地文件</h2><div class="panel section-body meta">本地没有这本的文件。</div></div>`;

  const onlinePanel = !local && data.token
    ? `<div class="section"><h2>在线阅读</h2><div class="panel section-body">
        ${onlinePreview && onlinePreview.items.length
          ? `<div class="gallery">${onlinePreview.items.map((it) => `<button class="page-tile" data-readto="${esc(readBase)}?n=${it.index}" title="第 ${it.index} 页"><img src="/api/online/img/${encodeURIComponent(String(data.gid))}/${encodeURIComponent(data.token)}/${it.index}" alt="第 ${it.index} 页" loading="lazy"></button>`).join('')}</div>`
          : '<div class="meta">在线页面暂时拿不到，点下面的按钮进阅读器再试。</div>'}
        <div class="detail-actions"><button class="btn" data-readto="${esc(readBase)}?n=1">在线阅读</button><span class="detail-note">图片经本地服务代理，不跳浏览器。</span></div>
      </div></div>`
    : '';

  const historyPanel = `<div class="section"><h2>历史记录</h2><div class="panel"><div class="tl" style="padding:4px 8px">${timelineHtml(hist, true) || '<div class="meta" style="padding:10px">没有记录。</div>'}</div></div></div>`;

  const pathPanel = `<div class="section"><h2>下载目录</h2><div class="panel section-body">
      <div class="path-box">${esc(data.download || '无')}</div>
      ${data.download ? `<div class="detail-actions"><button class="btn" data-copy-path="${esc(String(data.download))}">打开文件夹（复制路径）</button><span class="detail-note">复制路径到剪贴板，不是 file:// 链接。</span></div>` : ''}
    </div></div>`;

  app.innerHTML = `<div class="wrap">${head}${notePanel}${commentPanel}${localPanel}${onlinePanel}${historyPanel}${pathPanel}</div>`;
  enhanceComments();
}


/* ----------------------------------------------------------------- reader */

let activeReader = null;

function readerSrc(state, index) {
  if (state.source === 'local') {
    const file = state.localFiles[index - 1];
    return file ? imgUrl(file) : '';
  }
  return `/api/online/img/${encodeURIComponent(String(state.gid))}/${encodeURIComponent(state.token)}/${index}`;
}

function onlineWindowFrom(index) {
  return Math.floor((index - 1) / 20) * 20 + 1;
}

function loadOnlineWindow(state, from) {
  if (state.windows.has(from)) return state.windows.get(from);
  const request = api(
    `/api/online/pages/${encodeURIComponent(String(state.gid))}/${encodeURIComponent(state.token)}?from=${from}&to=${from + 19}`,
  ).then((data) => {
    for (const item of data.items || []) state.loaded.add(item.index);
    if (data.total) state.total = Number(data.total) || state.total;
    return data;
  }).catch((err) => {
    state.windows.delete(from);
    throw err;
  });
  state.windows.set(from, request);
  return request;
}

async function ensurePage(state, index) {
  if (state.source === 'local') return Boolean(state.localFiles[index - 1]);
  if (state.loaded.has(index)) return true;
  try {
    await loadOnlineWindow(state, onlineWindowFrom(index));
    return state.loaded.has(index);
  } catch {
    return false;
  }
}

function readerFail(message) {
  app.innerHTML = `<div class="wrap"><div class="error">${esc(message)}<br><button class="btn" id="retry-read">重试</button> <button class="btn" data-readto="/view">返回看过</button></div></div>`;
  const retry = document.getElementById('retry-read');
  if (retry) retry.onclick = () => render();
}

async function renderReader(my, gid, token) {
  const startN = Number.parseInt(new URLSearchParams(location.search).get('n') || '1', 10) || 1;
  app.innerHTML = '<div class="reader"><div class="reader-load">正在准备阅读器…</div></div>';

  let gallery = null;
  try {
    gallery = await api(`/api/gallery/${encodeURIComponent(gid)}`);
  } catch {
    gallery = null;
  }
  if (my !== seq) return;

  const localFiles =
    gallery && gallery.local && Array.isArray(gallery.local.files) ? gallery.local.files : [];
  const source = localFiles.length ? 'local' : 'online';

  if (source === 'online' && !token) {
    readerFail('缺少 token，没法在线读这本。');
    return;
  }

  let firstWindow = null;
  if (source === 'online') {
    try {
      firstWindow = await api(
        `/api/online/pages/${encodeURIComponent(gid)}/${encodeURIComponent(token)}?from=1&to=20`,
      );
    } catch (err) {
      if (my === seq) readerFail(err && err.message ? err.message : '在线页面列表加载失败');
      return;
    }
    if (my !== seq) return;
  }

  const total =
    source === 'local'
      ? localFiles.length
      : Number(firstWindow && firstWindow.total) ||
        (firstWindow && firstWindow.items.length
          ? firstWindow.items[firstWindow.items.length - 1].index
          : 1);

  const state = {
    my,
    gid: String(gid),
    token: token || '',
    source,
    title: (gallery && gallery.title) || (firstWindow && firstWindow.title) || `gid ${gid}`,
    total,
    index: Math.min(Math.max(1, startN), Math.max(1, total)),
    mode: 'single',
    zoom: 'fit',
    localFiles,
    loaded: new Set(
      source === 'local'
        ? localFiles.map((_, i) => i + 1)
        : (firstWindow && firstWindow.items ? firstWindow.items : []).map((it) => it.index),
    ),
    windows: new Map(),
    force: 0,
  };
  if (source === 'online' && firstWindow) state.windows.set(1, Promise.resolve(firstWindow));

  app.innerHTML = `<div class="reader" id="reader" tabindex="0">
    <div class="reader-top">
      <button class="r-back" data-readto="/g/${encodeURIComponent(state.gid)}">← 详情</button>
      <div class="r-title" title="${esc(state.title)}">${esc(state.title)}</div>
      <span class="r-src">${source === 'local' ? '本地' : '在线'}</span>
    </div>
    <div class="reader-stage" id="stage">
      <div class="spread" id="spread">
        <img id="r-img-a" class="r-img" alt="">
        <img id="r-img-b" class="r-img" alt="" hidden>
      </div>
      <div class="r-overlay" id="r-overlay" hidden>
        <div class="r-overlay-text" id="r-overlay-text"></div>
        <button class="btn" id="r-retry">重试</button>
      </div>
      <button class="r-zone left" data-turn="-1" aria-label="上一页"></button>
      <button class="r-zone right" data-turn="1" aria-label="下一页"></button>
    </div>
    <div class="reader-bar">
      <span class="r-count" id="r-count"></span>
      <div class="r-tools">
        <button class="r-btn" id="r-zoom">适应</button>
        <button class="r-btn" id="r-mode">双页</button>
        <span class="r-tip">← → 翻页 · Home/End · Esc 返回</span>
      </div>
    </div>
  </div>`;

  const stage = document.getElementById('stage');
  const spread = document.getElementById('spread');
  const imgA = document.getElementById('r-img-a');
  const imgB = document.getElementById('r-img-b');
  const countEl = document.getElementById('r-count');
  const overlay = document.getElementById('r-overlay');
  const overlayText = document.getElementById('r-overlay-text');
  const retryBtn = document.getElementById('r-retry');

  const showOverlay = (text, retry) => {
    overlay.hidden = false;
    overlayText.textContent = text;
    retryBtn.hidden = !retry;
  };
  const hideOverlay = () => {
    overlay.hidden = true;
  };

  const loadInto = (img, index) => {
    img.dataset.index = String(index);
    img.classList.remove('ready');
    if (!state.loaded.has(index)) showOverlay('加载中…', false);
    (async () => {
      const ok = await ensurePage(state, index);
      if (state.my !== seq || !img.isConnected || img.dataset.index !== String(index)) return;
      if (!ok) {
        showOverlay(`第 ${index} 页加载失败`, true);
        return;
      }
      const suffix = state.force ? `${state.source === 'online' ? '?' : '&'}r=${state.force}` : '';
      img.onload = () => {
        img.classList.add('ready');
        hideOverlay();
        state.force = 0;
      };
      img.onerror = () => showOverlay(`第 ${index} 页图片加载失败`, true);
      img.src = readerSrc(state, index) + suffix;
    })();
  };

  const setUrl = () => {
    const tok = state.token ? encodeURIComponent(state.token) : '-';
    history.replaceState(null, '', `/read/${encodeURIComponent(state.gid)}/${tok}?n=${state.index}`);
  };

  const paint = () => {
    if (state.my !== seq) return;
    state.index = Math.min(Math.max(1, state.index), Math.max(1, state.total));
    const second = state.mode === 'double' && state.index + 1 <= state.total ? state.index + 1 : null;
    countEl.textContent = second
      ? `${state.index}–${second} / ${state.total}`
      : `${state.index} / ${state.total}`;
    setUrl();
    loadInto(imgA, state.index);
    if (second) {
      imgB.hidden = false;
      loadInto(imgB, second);
    } else {
      imgB.hidden = true;
      imgB.removeAttribute('src');
      imgB.classList.remove('ready');
    }

    if (state.source === 'online') {
      const from = onlineWindowFrom(state.index);
      const nextFrom = from + 20;
      if (nextFrom <= state.total) loadOnlineWindow(state, nextFrom).catch(() => {});
      for (const i of [state.index + 1, state.index + 2]) {
        if (i <= state.total && state.loaded.has(i)) {
          const pre = new Image();
          pre.src = readerSrc(state, i);
        }
      }
    }
  };

  const turn = (dir) => {
    const step = state.mode === 'double' ? 2 : 1;
    const next = state.index + dir * step;
    if (next < 1 || next > state.total) return;
    state.index = next;
    paint();
  };

  document.querySelectorAll('[data-turn]').forEach((el) => {
    el.onclick = () => turn(Number(el.dataset.turn));
  });

  const zoomBtn = document.getElementById('r-zoom');
  const modeBtn = document.getElementById('r-mode');
  zoomBtn.onclick = () => {
    state.zoom = state.zoom === 'fit' ? 'actual' : 'fit';
    stage.classList.toggle('actual', state.zoom === 'actual');
    zoomBtn.textContent = state.zoom === 'actual' ? '原始' : '适应';
  };
  modeBtn.onclick = () => {
    if (state.mode === 'single' && window.innerWidth < 900) {
      toast('窗口太窄，双页放不下');
      return;
    }
    state.mode = state.mode === 'single' ? 'double' : 'single';
    spread.classList.toggle('double', state.mode === 'double');
    modeBtn.textContent = state.mode === 'single' ? '双页' : '单页';
    paint();
  };

  retryBtn.onclick = () => {
    state.force = Date.now();
    hideOverlay();
    paint();
  };

  activeReader = {
    prev: () => turn(-1),
    next: () => turn(1),
    first: () => {
      state.index = 1;
      paint();
    },
    last: () => {
      state.index = state.total;
      paint();
    },
    escape: () => navigate(`/g/${encodeURIComponent(state.gid)}`),
  };

  paint();
  const shell = document.getElementById('reader');
  if (shell) shell.focus();
}

/* ----------------------------------------------------------------- render */

async function render() {
  const my = ++seq;
  const route = parseRoute();
  state.route = route;
  state.q = new URLSearchParams(location.search).get('q') || '';
  qEl.value = state.q;

  activeReader = null;
  const isGallery = route.name === 'gallery';
  const isRead = route.name === 'read';
  setActiveNav(isGallery || isRead ? 'view' : route.name);
  crumb.textContent = isGallery ? `画廊 ${route.gid}` : isRead ? `阅读 ${route.gid}` : (LABEL[route.name] || '看过');
  document.title = isGallery
    ? `gid ${route.gid} · DSH-EH`
    : isRead
      ? `阅读 ${route.gid} · DSH-EH`
      : `${LABEL[route.name] || '看过'} · DSH-EH`;
  app.classList.toggle('reader-mode', isRead);

  app.innerHTML = '<div class="loading">加载中…</div>';
  app.scrollTop = 0;

  try {
    if (route.name === 'gallery') await renderGallery(my, route.gid);
    else if (route.name === 'read') await renderReader(my, route.gid, route.token);
    else if (route.name === 'download') await renderDownload(my);
    else if (route.name === 'notes') await renderNotes(my);
    else if (route.name === 'library') await renderLibrary(my);
    else await renderView(my);
  } catch (err) {
    if (my !== seq) return;
    app.innerHTML = `<div class="wrap"><div class="error">出错了：${esc(err && err.message ? err.message : err)}<br><button class="btn" id="retry">重试</button></div></div>`;
    const retry = document.getElementById('retry');
    if (retry) retry.onclick = () => render();
  }
}

/* --------------------------------------------------------------- bindings */

let qTimer = 0;
qEl.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(commitSearch, 300);
});
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(qTimer);
    commitSearch();
  } else if (e.key === 'Escape') {
    qEl.value = '';
    clearTimeout(qTimer);
    commitSearch();
  }
});

document.addEventListener('click', (e) => {
  const cmtMore = e.target.closest('#cmt-more');
  if (cmtMore) {
    e.preventDefault();
    document.querySelectorAll('.comment[hidden]').forEach((el) => {
      el.hidden = false;
    });
    const wrap = cmtMore.closest('.comments-more');
    if (wrap) wrap.remove();
    enhanceComments();
    return;
  }
  const readTo = e.target.closest('[data-readto]');
  if (readTo) {
    e.preventDefault();
    e.stopPropagation();
    navigate(readTo.getAttribute('data-readto'));
    return;
  }
  const copyEl = e.target.closest('[data-copy]');
  if (copyEl) {
    e.preventDefault();
    e.stopPropagation();
    copyText(copyEl.getAttribute('data-copy'));
    return;
  }
  const copyPath = e.target.closest('[data-copy-path]');
  if (copyPath) {
    e.preventDefault();
    e.stopPropagation();
    copyText(copyPath.getAttribute('data-copy-path'));
    return;
  }
  const spa = e.target.closest('a[data-spa]');
  if (spa && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    navigate(spa.getAttribute('href'));
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row) navigate(row.getAttribute('data-href'));
});

window.addEventListener('popstate', render);

window.addEventListener('keydown', (e) => {
  if (!activeReader || e.altKey || e.ctrlKey || e.metaKey) return;
  const key = e.key;
  if (key === 'ArrowLeft') {
    e.preventDefault();
    activeReader.prev();
  } else if (key === 'ArrowRight' || key === ' ') {
    e.preventDefault();
    activeReader.next();
  } else if (key === 'Home') {
    e.preventDefault();
    activeReader.first();
  } else if (key === 'End') {
    e.preventDefault();
    activeReader.last();
  } else if (key === 'Escape') {
    e.preventDefault();
    activeReader.escape();
  }
});

initTheme();
loadStatus();
render();
