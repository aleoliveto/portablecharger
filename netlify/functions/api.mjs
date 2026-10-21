// BIG BOARD API: password login + document store on Netlify Blobs.
//
// Every document is its own blob, keyed "<collection>/<id>"; updates are keyed
// "updates/<YYYY-MM>/<id>" so a month is one prefix listing however large the
// history grows. Each write also bumps a revision token ("_rev/<scope>") so the
// page polls one cheap endpoint and only re-reads what actually changed.
import crypto from 'node:crypto';
import { COLLECTIONS as COLLECTION_LIST, store, backupStore, mapLimit, readPrefix, readWithEtag, collectionPrefix, exportAll } from '../lib/data.mjs';

const COLLECTIONS = new Set(COLLECTION_LIST);
const ID_RE = /^[A-Za-z0-9_\-]{1,120}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_DOC_BYTES = 200_000;
const SESSION_DAYS = 30;
// Saves by the same person within this window replace each other in history instead of
// stacking up, so autosaved notes don't leave one version per pause in typing.
const HISTORY_MERGE_MS = 10 * 60_000;
const COOKIE = 'bb_session';


/* ---------- helpers ---------- */
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status, message, code) => json({ error: message, code }, status);

function secret() {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  // Falls back to a key derived from the passwords, so changing a password signs everyone out.
  return crypto.createHash('sha256').update('bigboard:' + (process.env.BOARD_PASSWORD || '') + ':' + (process.env.BOARD_VIEW_PASSWORD || '')).digest('hex');
}
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function readSession(req) {
  const raw = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [data, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!data || !sig || !safeEq(sign(data), sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!s.exp || s.exp < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}
function sessionCookie(session) {
  const data = b64(JSON.stringify(session));
  return `${COOKIE}=${data}.${sign(data)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

const userId = (name) => 'u-' + crypto.createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);

function blobKey(collection, id) {
  if (collection === 'updates') {
    const m = id.match(/_(\d{4}-\d{2})$/);
    if (!m) return null;
    return `updates/${m[1]}/${id}`;
  }
  return `${collection}/${id}`;
}
const scopeOf = (collection, id) => (collection === 'updates' ? 'updates:' + id.slice(-7) : collection);
const bump = (st, scope) => st.setJSON('_rev/' + scope, { t: Date.now().toString(36) + crypto.randomBytes(4).toString('hex') });

// 409 with the version that won, and the saver's name so the page can say who.
async function conflict(st, current) {
  const by = current && typeof current.updatedBy === 'string' && ID_RE.test(current.updatedBy) ? await st.get('_users/' + current.updatedBy, { type: 'json' }) : null;
  return json({ error: 'Someone else saved this while you were editing', code: 'conflict', current, currentByName: by && by.name }, 409);
}

const histPrefix = (collection, id) => `_hist/${collection}/${id}/`;

// Keep the version being replaced, unless the same person saved it moments ago.
async function keepHistory(st, collection, id, prev, next, session, action) {
  if (!prev) return;
  const sameEditor = action === 'edit' && prev.updatedBy && prev.updatedBy === (next && next.updatedBy);
  const recent = prev.updatedAt && Date.now() - Date.parse(prev.updatedAt) < HISTORY_MERGE_MS;
  if (sameEditor && recent) return;
  const at = new Date().toISOString();
  await st.setJSON(histPrefix(collection, id) + at.replace(/[:.]/g, '-'), { data: prev, replacedAt: at, replacedBy: session.n, action });
}

/* ---------- login throttling ---------- */
async function throttle(st, req, ok) {
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  const key = '_auth/' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
  const now = Date.now();
  const rec = (await st.get(key, { type: 'json' })) || { n: 0, since: now };
  if (now - rec.since > 15 * 60_000) { rec.n = 0; rec.since = now; }
  if (ok === undefined) return rec.n >= 10;
  if (ok) await st.delete(key);
  else { rec.n++; await st.setJSON(key, rec); }
}

/* ---------- handler ---------- */
export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error(e);
    return fail(500, 'Server error, try again');
  }
};

async function handle(req) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const route = parts[0] || '';
  const method = req.method;
  const st = store();

  if (method !== 'GET' && method !== 'HEAD') {
    // Same-origin check on every write, on top of the SameSite cookie.
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return fail(403, 'Cross-origin request refused');
  }

  if (route === 'login' && method === 'POST') {
    if (!process.env.BOARD_PASSWORD) return fail(500, 'BOARD_PASSWORD is not set on this site');
    if (await throttle(st, req)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
    let body;
    try { body = await req.json(); } catch { return fail(400, 'Bad request'); }
    const name = String(body.name || '').trim().slice(0, 60);
    const pw = String(body.password || '');
    if (!name) return fail(400, 'Enter your name');
    let write = null;
    if (safeEq(pw, process.env.BOARD_PASSWORD)) write = true;
    else if (process.env.BOARD_VIEW_PASSWORD && safeEq(pw, process.env.BOARD_VIEW_PASSWORD)) write = false;
    await throttle(st, req, write !== null);
    if (write === null) return fail(401, 'Wrong password');
    const id = userId(name);
    await st.setJSON('_users/' + id, { name });
    return json({ id, name, canWrite: write }, 200, {
      'set-cookie': sessionCookie({ id, n: name, w: write, exp: Date.now() + SESSION_DAYS * 86400_000 }),
    });
  }
  if (route === 'logout') return json({ ok: true }, 200, { 'set-cookie': clearCookie });

  const session = readSession(req);
  if (!session) return fail(401, 'Sign in required', 'unauthenticated');
  const needWrite = () => (session.w ? null : fail(403, 'Your access is view only', 'invalid_argument'));

  if (route === 'me') return json({ id: session.id, name: session.n, canWrite: !!session.w });

  if (route === 'profiles' && method === 'POST') {
    const { ids = [] } = await req.json().catch(() => ({}));
    const out = {};
    await mapLimit(ids.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 200), 16, async (id) => {
      const p = await st.get('_users/' + id, { type: 'json' });
      if (p) out[id] = { name: p.name };
    });
    return json(out);
  }

  if (route === 'rev' && method === 'GET') {
    const scopes = (url.searchParams.get('scopes') || '').split(',').filter((s) => /^[a-z]+(:\d{4}-\d{2})?$/.test(s)).slice(0, 20);
    const out = {};
    await Promise.all(scopes.map(async (s) => { const r = await st.get('_rev/' + s, { type: 'json' }); out[s] = r ? r.t : '0'; }));
    return json(out);
  }

  if (route === 'col' && method === 'GET') {
    const collection = parts[1];
    if (!COLLECTIONS.has(collection)) return fail(404, 'Unknown collection');
    const month = url.searchParams.get('month');
    if (month && !MONTH_RE.test(month)) return fail(400, 'Bad month');
    return json({ docs: await readPrefix(st, collectionPrefix(collection, month)) });
  }

  if (route === 'doc') {
    const [, collection, id] = parts;
    if (!COLLECTIONS.has(collection) || !id || !ID_RE.test(id)) return fail(400, 'Bad document path');
    const key = blobKey(collection, id);
    if (!key) return fail(400, 'Update ids must end in _YYYY-MM');
    if (method === 'GET') {
      const data = await st.get(key, { type: 'json' });
      return data == null ? fail(404, 'Not found') : json({ id, data });
    }
    const denied = needWrite(); if (denied) return denied;
    if (method === 'PUT') {
      const text = await req.text();
      if (text.length > MAX_DOC_BYTES) return fail(413, 'Document too large');
      let data;
      try { data = JSON.parse(text); } catch { return fail(400, 'Body must be JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'Body must be a JSON object');
      // x-if-match carries the version the editor started from ("new" if it didn't exist yet);
      // a mismatch means someone saved in between, so hand back their version instead.
      const expect = req.headers.get('x-if-match');
      const cur = await readWithEtag(st, key);
      const curData = cur && cur.data != null ? cur.data : null;
      if (expect && (expect === 'new' ? curData !== null : !cur || cur.etag !== expect)) return conflict(st, curData);
      await keepHistory(st, collection, id, curData, data, session, 'edit');
      const res = curData === null ? await st.setJSON(key, data, { onlyIfNew: true }) : await st.setJSON(key, data, { onlyIfMatch: cur.etag });
      if (res && res.modified === false) return conflict(st, await st.get(key, { type: 'json' }));
      await bump(st, scopeOf(collection, id));
      return json({ ok: true, etag: res && res.etag });
    }
    if (method === 'DELETE') {
      const prev = await st.get(key, { type: 'json' });
      await keepHistory(st, collection, id, prev, null, session, 'delete');
      await st.delete(key);
      await bump(st, scopeOf(collection, id));
      return json({ ok: true });
    }
    return fail(405, 'Method not allowed');
  }

  if (route === 'history' && method === 'GET') {
    const [, collection, id] = parts;
    if (!COLLECTIONS.has(collection) || !id || !ID_RE.test(id)) return fail(400, 'Bad document path');
    const { blobs } = await st.list({ prefix: histPrefix(collection, id) });
    const recent = blobs.map((b) => b.key).sort().reverse().slice(0, 50);
    const versions = (await mapLimit(recent, 16, (k) => st.get(k, { type: 'json' }))).filter(Boolean);
    return json({ versions });
  }

  // One initiative's update for each requested month, for the KPI trend.
  if (route === 'series' && method === 'GET') {
    const id = parts[1];
    if (!id || !ID_RE.test(id)) return fail(400, 'Bad initiative');
    const months = (url.searchParams.get('months') || '').split(',').filter((m) => MONTH_RE.test(m)).slice(0, 36);
    const out = {};
    await mapLimit(months, 12, async (m) => { out[m] = await st.get(`updates/${m}/${id}_${m}`, { type: 'json' }); });
    return json({ months: out });
  }

  if (route === 'backups' && method === 'GET') {
    const bk = backupStore();
    const name = parts[1];
    if (!name) {
      const { blobs } = await bk.list();
      return json({ backups: blobs.map((b) => b.key).sort().reverse() });
    }
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) return fail(400, 'Bad backup name');
    const data = await bk.get(name, { type: 'json' });
    if (data == null) return fail(404, 'No such backup');
    return json(data, 200, { 'content-disposition': `attachment; filename="big-board-backup-${name}"` });
  }

  if (route === 'export' && method === 'GET') {
    const out = await exportAll(st);
    const day = new Date().toISOString().slice(0, 10);
    return json(out, 200, { 'content-disposition': `attachment; filename="big-board-data-export-${day}.json"` });
  }

  if (route === 'import' && method === 'POST') {
    const denied = needWrite(); if (denied) return denied;
    let body;
    try { body = await req.json(); } catch { return fail(400, 'Body must be JSON'); }
    const writes = [];
    for (const c of COLLECTIONS) {
      for (const [id, data] of Object.entries(body[c] || {})) {
        const key = ID_RE.test(id) && data && typeof data === 'object' ? blobKey(c, id) : null;
        if (key) writes.push({ key, data, scope: scopeOf(c, id) });
      }
    }
    await mapLimit(writes, 16, (w) => st.setJSON(w.key, w.data));
    await Promise.all([...new Set(writes.map((w) => w.scope))].map((s) => bump(st, s)));
    return json({ ok: true, written: writes.length });
  }

  return fail(404, 'Not found');
}

export const config = { path: '/api/*' };
