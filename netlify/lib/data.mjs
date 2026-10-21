// Storage helpers shared by the API and the nightly backup.
import { getStore } from '@netlify/blobs';

export const COLLECTIONS = ['bases', 'initiatives', 'updates', 'feedback', 'barriers'];

export const store = () => getStore({ name: 'bigboard', consistency: 'strong' });
export const backupStore = () => getStore({ name: 'bigboard-backups', consistency: 'strong' });

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

export async function readPrefix(st, prefix) {
  const { blobs } = await st.list({ prefix });
  const docs = await mapLimit(blobs, 32, async (b) => {
    const data = await st.get(b.key, { type: 'json' });
    return data == null ? null : { id: b.key.slice(b.key.lastIndexOf('/') + 1), data, etag: b.etag };
  });
  return docs.filter(Boolean);
}

// Current data and etag of one blob. Single reads don't always carry an etag, listings do.
export async function readWithEtag(st, key) {
  const r = await st.getWithMetadata(key, { type: 'json' });
  if (!r || r.data == null) return null;
  if (r.etag) return r;
  const { blobs } = await st.list({ prefix: key });
  const hit = blobs.find((b) => b.key === key);
  return { data: r.data, etag: hit && hit.etag };
}

export const collectionPrefix = (collection, month) =>
  collection === 'updates' ? (month ? `updates/${month}/` : 'updates/') : `${collection}/`;

// Every document, keyed the same way as the original artifact export.
export async function exportAll(st) {
  const out = {};
  for (const c of COLLECTIONS) {
    out[c] = {};
    for (const d of await readPrefix(st, collectionPrefix(c))) out[c][d.id] = d.data;
  }
  return out;
}
