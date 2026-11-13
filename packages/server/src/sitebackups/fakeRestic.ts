// A stand-in restic for the tests: snapshots in memory, each one's dump a given tar.
import { Readable } from 'node:stream';
import type { Restic } from './restic.js';

export function fakeRestic(pull: (site: string) => Buffer | { problem: string }) {
  const snapshots = new Map<string, { site: string; tar: Buffer }>();
  const calls: string[] = [];
  let n = 0;
  const restic: Restic = {
    async backup(site) {
      calls.push(`backup ${site}`);
      const tar = pull(site);
      if (!Buffer.isBuffer(tar)) return { ok: false, problem: tar.problem };
      const id = (++n).toString(16).padStart(64, '0');
      snapshots.set(id, { site, tar });
      return { ok: true, snapshotId: id, bytes: tar.length, added: 10 };
    },
    async dump(id, _site, read) {
      const snapshot = snapshots.get(id);
      if (!snapshot) return { ok: false, problem: 'no such snapshot' };
      return { ok: true, value: await read(Readable.from([snapshot.tar])) };
    },
    async forget(ids) {
      calls.push(`forget ${ids.length}`);
      for (const id of ids) snapshots.delete(id);
      return { ok: true };
    },
    async keep(site) {
      calls.push(`keep ${site}`);
      return { ok: true };
    },
    async snapshots(site) {
      return { ok: true, ids: [...snapshots].filter(([, s]) => s.site === site).map(([id]) => id) };
    },
    async prune() {
      calls.push('prune');
      return { ok: true };
    },
    async check() {
      calls.push('check');
      return { ok: true };
    },
    async size() {
      return { ok: true, bytes: 4096 };
    },
    async restore(id, target) {
      calls.push(`restore ${id.slice(-2)} ${target}`);
      return { ok: true };
    },
  };
  return { restic, snapshots, calls };
}
