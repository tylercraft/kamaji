// A stand-in restic for the tests: snapshots in memory, each one's dump a given tar. Its forget
// applies the real KEEP arguments the way restic's docs describe them ("Removing snapshots
// according to a policy"): --keep-within counts back from the newest snapshot; --keep-weekly and
// --keep-monthly keep the newest snapshot of each of the last n weeks (ISO weeks) and months that
// have one. UTC here, where restic uses the machine's own time.
import { Readable } from 'node:stream';
import { KEEP, type Restic } from './restic.js';

const DAY = 24 * 60 * 60_000;

function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return `${year}-W${week}`;
}

/** The ids `keep` (restic's forget arguments) would keep of one site's snapshots. */
export function kept(snapshots: { id: string; at: number }[], keep: string[] = KEEP): Set<string> {
  const arg = (flag: string) => {
    const i = keep.indexOf(flag);
    return i === -1 ? null : keep[i + 1]!;
  };
  const newest = [...snapshots].sort((a, b) => b.at - a.at);
  const out = new Set<string>();
  const within = arg('--keep-within');
  if (within && newest[0]) {
    const days = Number(/^(\d+)d$/.exec(within)?.[1]);
    for (const s of newest) if (s.at > newest[0].at - days * DAY) out.add(s.id);
  }
  const buckets = (flag: string, bucket: (ms: number) => string) => {
    const n = Number(arg(flag) ?? 0);
    const seen = new Set<string>();
    for (const s of newest) {
      const b = bucket(s.at);
      if (seen.has(b)) continue;
      if (seen.size >= n) break;
      seen.add(b);
      out.add(s.id);
    }
  };
  buckets('--keep-weekly', isoWeek);
  buckets('--keep-monthly', (ms) => new Date(ms).toISOString().slice(0, 7));
  return out;
}

export function fakeRestic(
  pull: (site: string) => Buffer | { problem: string },
  clock: () => number = Date.now,
) {
  const snapshots = new Map<string, { site: string; tar: Buffer; at: number }>();
  const calls: string[] = [];
  const commands: { site: string; host: string; command: string[] }[] = [];
  let n = 0;
  const restic: Restic = {
    async backup(site, command, _signal, host = 'craftish') {
      calls.push(`backup ${site}`);
      commands.push({ site, host, command });
      const tar = pull(site);
      if (!Buffer.isBuffer(tar)) return { ok: false, problem: tar.problem };
      const id = (++n).toString(16).padStart(64, '0');
      snapshots.set(id, { site, tar, at: clock() });
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
      const own = [...snapshots].filter(([, s]) => s.site === site);
      const keep = kept(own.map(([id, s]) => ({ id, at: s.at })));
      for (const [id] of own) if (!keep.has(id)) snapshots.delete(id);
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
  return { restic, snapshots, calls, commands };
}
