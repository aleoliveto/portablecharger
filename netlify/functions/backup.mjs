// Nightly snapshot of the whole board into the "bigboard-backups" store, kept for 90 days.
import { store, backupStore, exportAll } from '../lib/data.mjs';

const KEEP_DAYS = 90;

export default async () => {
  const data = await exportAll(store());
  const bk = backupStore();
  const day = new Date().toISOString().slice(0, 10);
  await bk.setJSON(`${day}.json`, data);
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  const { blobs } = await bk.list();
  await Promise.all(blobs.filter((b) => b.key.slice(0, 10) < cutoff).map((b) => bk.delete(b.key)));
  console.log(`Backup ${day}: ${Object.values(data).reduce((n, c) => n + Object.keys(c).length, 0)} documents`);
};

export const config = { schedule: '@daily' };
