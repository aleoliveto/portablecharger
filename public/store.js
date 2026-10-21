// Supplies window.claude.use("db") / use("user") for the BIG BOARD page, backed by /api/*.
// The page is unchanged: this file implements the small Firestore-like surface it calls
// (collection, doc, where('field','==',v), onSnapshot, set, delete) and shows a sign-in
// screen until the viewer has a session.
(() => {
  'use strict';
  const POLL_MS = 10000;

  async function api(path, opts = {}) {
    const res = await fetch('/api/' + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts));
    let body = null; try { body = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401 && path !== 'login') showLogin();
      const err = new Error((body && body.error) || ('HTTP ' + res.status));
      err.code = body && body.code; err.status = res.status; throw err;
    }
    return body;
  }

  /* ---------- live subscriptions via revision polling ---------- */
  const subs = new Set();
  const revs = {};
  const scopeFor = (col, month) => (col === 'updates' && month ? 'updates:' + month : col);

  async function load(sub) {
    const q = sub.col === 'updates' && sub.month ? '?month=' + encodeURIComponent(sub.month) : '';
    const { docs } = await api('col/' + sub.col + q);
    let list = docs;
    if (sub.filter) list = list.filter((d) => d.data && d.data[sub.filter.field] === sub.filter.value);
    if (!subs.has(sub)) return;
    sub.cb({ docs: list.map((d) => ({ id: d.id, data: () => d.data })) });
  }
  async function refresh(scopes) {
    await Promise.all([...subs].filter((s) => !scopes || scopes.some((x) => s.scope === x || (x.startsWith('updates') && s.col === 'updates' && !s.month)))
      .map((s) => load(s).catch((e) => s.err && s.err(e))));
  }
  async function poll() {
    if (!subs.size || document.hidden) return;
    const scopes = [...new Set([...subs].map((s) => s.scope))];
    try {
      const r = await api('rev?scopes=' + encodeURIComponent(scopes.join(',')));
      const changed = scopes.filter((s) => revs[s] !== r[s]);
      scopes.forEach((s) => { revs[s] = r[s]; });
      if (changed.length) await refresh(changed);
    } catch (e) { /* offline or signed out; try again next tick */ }
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  function subscribe(col, filter, cb, err) {
    const month = col === 'updates' && filter && filter.field === 'month' ? filter.value : null;
    const sub = { col, month, filter, cb, err, scope: scopeFor(col, month) };
    subs.add(sub);
    load(sub).catch((e) => err && err(e));
    return () => subs.delete(sub);
  }

  /* ---------- db ---------- */
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  function docRef(col, id) {
    const path = 'doc/' + encodeURIComponent(col) + '/' + encodeURIComponent(id);
    const after = () => refresh([col === 'updates' ? 'updates:' + id.slice(-7) : col]);
    return {
      id,
      async set(obj) { await api(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); after(); },
      async delete() { await api(path, { method: 'DELETE' }); after(); },
    };
  }
  function collectionRef(col) {
    return {
      doc: (id) => docRef(col, id || newId()),
      where(field, op, value) {
        if (op !== '==') throw new Error('Only == queries are supported');
        return { onSnapshot: (cb, err) => subscribe(col, { field, value }, cb, err) };
      },
      onSnapshot: (cb, err) => subscribe(col, null, cb, err),
    };
  }
  const db = {
    collection: collectionRef,
    doc(path) { const [col, ...rest] = path.split('/'); return docRef(col, rest.join('/')); },
  };

  /* ---------- sign-in ---------- */
  let me = null;
  const user = {
    id: async () => me.id,
    can: async (perm) => (perm === 'data.write' ? !!me.canWrite : null),
    profiles: (ids) => api('profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) }),
  };

  let loginShown = false;
  function showLogin(msg) {
    if (loginShown) return; loginShown = true;
    const el = document.createElement('div');
    el.id = 'bbLogin';
    el.innerHTML = `<style>
      #bbLogin{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;background:var(--bg);font-family:Nunito,system-ui,sans-serif}
      #bbLogin form{width:100%;max-width:360px;background:var(--surface);color:var(--fg);border-radius:14px;padding:28px 24px;box-shadow:0 8px 30px rgba(0,0,0,.12)}
      #bbLogin h1{margin:0 0 4px;font:600 26px Oswald,system-ui,sans-serif;color:#FF6600;letter-spacing:.02em}
      #bbLogin p{margin:0 0 18px;color:var(--muted);font-size:14px}
      #bbLogin label{display:block;font-weight:700;font-size:13px;margin:12px 0 6px}
      #bbLogin input{box-sizing:border-box;width:100%;padding:10px 12px;font:inherit;font-size:15px;border:1px solid var(--line-strong);border-radius:8px;background:transparent;color:inherit}
      #bbLogin button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#FF6600;color:#fff;font:600 16px Oswald,system-ui,sans-serif;letter-spacing:.04em;cursor:pointer}
      #bbLogin .err{color:#FF4600;font-weight:700;font-size:13px;min-height:18px;margin-top:10px}
    </style>
    <form autocomplete="on">
      <h1>BIG BOARD FY27</h1><p>Focus Initiatives tracker. Sign in to continue.</p>
      <label for="bbName">Your name</label><input id="bbName" name="name" autocomplete="name" required maxlength="60">
      <label for="bbPw">Password</label><input id="bbPw" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button><div class="err" id="bbErr"></div>
    </form>`;
    document.body.appendChild(el);
    try { el.querySelector('#bbName').value = localStorage.getItem('bbName') || ''; } catch (e) {}
    el.querySelector('#bbErr').textContent = msg || '';
    (el.querySelector('#bbName').value ? el.querySelector('#bbPw') : el.querySelector('#bbName')).focus();
    el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = el.querySelector('#bbName').value.trim(); const password = el.querySelector('#bbPw').value;
      try {
        await api('login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
        try { localStorage.setItem('bbName', name); } catch (e2) {}
        location.reload();
      } catch (err) { el.querySelector('#bbErr').textContent = err.message; }
    });
  }

  function accountBar() {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:50;display:flex;gap:6px;font:12px Nunito,system-ui,sans-serif';
    const btn = 'padding:6px 10px;border-radius:999px;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);font:inherit;cursor:pointer;text-decoration:none;box-shadow:var(--shadow)';
    bar.innerHTML = `<span style="${btn};cursor:default">${me.name.replace(/[&<>"']/g, '')}${me.canWrite ? '' : ' · view only'}</span>
      <a href="/api/export" style="${btn}" title="Download every document as JSON">Export</a>
      ${me.canWrite ? `<a href="/admin.html" style="${btn}">Import</a>` : ''}
      <button type="button" style="${btn}" id="bbOut">Sign out</button>`;
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '56px'; // keep the bar clear of the last card's buttons
    bar.querySelector('#bbOut').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.reload(); });
  }

  const ready = api('me').then((m) => { me = m; accountBar(); return true; }).catch((e) => {
    if (e.status !== 401) showLogin('Couldn\'t reach the board: ' + e.message);
    return new Promise(() => {}); // stays pending until sign-in reloads the page
  });

  window.claude = {
    use: (name) => ready.then(() => (name === 'db' ? db : name === 'user' ? user : null)),
  };
})();
