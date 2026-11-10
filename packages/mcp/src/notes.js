/**
 * 笔记：看完一本之后留下的感想。
 * 线上（没下载过）和离线（下载目录里有）都写同一份库，用 gid 对齐。
 * 文件：<dataDir>/notes.json，结构 {version, updatedAt, items:{[gid]:{...}}}
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { __setDataDir, getDataDir } from './store.js';

const F_NOTES = 'notes.json';
const VERSION = 1;

function nowISO() {
  return new Date().toISOString();
}

async function notesFile() {
  const dir = await getDataDir();
  return path.join(dir, F_NOTES);
}

async function readAll() {
  const file = await notesFile();
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const items = parsed && typeof parsed.items === 'object' && parsed.items ? parsed.items : {};
    return { version: Number(parsed?.version) || VERSION, updatedAt: parsed?.updatedAt || '', items };
  } catch {
    return { version: VERSION, updatedAt: '', items: {} };
  }
}

async function writeAll(db) {
  const file = await notesFile();
  const tmp = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const body = { version: VERSION, updatedAt: nowISO(), items: db.items };
  await fsp.writeFile(tmp, JSON.stringify(body, null, 0), 'utf8');
  await fsp.rename(tmp, file);
  return body;
}

function normGid(gid) {
  const n = Number(String(gid ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 写 / 覆盖一条笔记（同一本只留最新一条）。
 * @param {{gid:number|string, token?:string, title?:string, note:string, rating?:number, tags?:string[], source?:'online'|'local', url?:string}} input
 */
export async function saveNote(input = {}) {
  const gid = normGid(input.gid);
  if (!gid) throw new Error('gid 不合法');
  const text = String(input.note ?? '').trim();
  if (!text) throw new Error('note 不能为空（清空用 eh_note_remove）');
  const db = await readAll();
  const prev = db.items[gid] || {};
  const rec = {
    gid,
    token: input.token || prev.token || '',
    title: input.title || prev.title || '',
    note: text,
    rating: input.rating ?? prev.rating ?? null,
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 30) : prev.tags || [],
    source: input.source || prev.source || 'online',
    url: input.url || prev.url || '',
    at: prev.at || nowISO(),
    updatedAt: nowISO(),
  };
  db.items[gid] = rec;
  await writeAll(db);
  return rec;
}

export async function getNote(gid) {
  const id = normGid(gid);
  if (!id) return null;
  const db = await readAll();
  return db.items[id] || null;
}

export async function removeNote(gid) {
  const id = normGid(gid);
  if (!id) return false;
  const db = await readAll();
  if (!db.items[id]) return false;
  delete db.items[id];
  await writeAll(db);
  return true;
}

/**
 * 列笔记（新的在前）。
 * @param {{limit?:number, query?:string}} opts
 */
export async function listNotes({ limit = 20, query = '' } = {}) {
  const db = await readAll();
  let items = Object.values(db.items);
  if (query) {
    const q = String(query).toLowerCase();
    items = items.filter((it) => [it.title, it.note, it.token, it.gid, ...(it.tags || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { items: items.slice(0, limit), total: items.length };
}

export async function stats() {
  const db = await readAll();
  const items = Object.values(db.items);
  const bySource = {};
  for (const it of items) bySource[it.source || 'online'] = (bySource[it.source || 'online'] || 0) + 1;
  return { total: items.length, bySource, updatedAt: db.updatedAt };
}

export async function __selftest() {
  const os = await import('node:os');
  const tmp = path.join(os.tmpdir(), `eh-notes-test-${Date.now()}`);
  await fsp.mkdir(tmp, { recursive: true });
  __setDataDir(tmp);
  try {
    const a = await saveNote({ gid: 1, note: '很好用', rating: 5 });
    const b = await saveNote({ gid: 2, token: 'abc', note: '字太密', source: 'local' });
    if (a.gid !== 1 || b.gid !== 2) throw new Error('saveNote gid 错');
    await saveNote({ gid: 1, note: '改主意了' });
    const got = await getNote(1);
    if (got.note !== '改主意了' || got.rating !== 5) throw new Error('覆盖写丢了旧字段');
    const list = await listNotes({ limit: 10 });
    if (list.total !== 2) throw new Error(`listNotes total=${list.total}`);
    const q = await listNotes({ query: '字太密' });
    if (q.total !== 1) throw new Error('query 没命中');
    if (!(await removeNote(2))) throw new Error('removeNote 失败');
    if ((await listNotes()).total !== 1) throw new Error('删除后条数不对');
    const st = await stats();
    if (st.total !== 1) throw new Error('stats 不对');
    return { ok: true };
  } finally {
    __setDataDir(null);
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
