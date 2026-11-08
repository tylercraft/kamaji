// craftish (and any Linux server): Kamaji runs `ssh` with a key whose only power is the forced
// command /usr/local/bin/kamaji-report (server-report/), parses the JSON it prints, keeps it as an
// observation and raises issues from it. Kamaji recommends; patching and restarts stay Tyler's.
//
// Issues (all for the morning digest, except a nearly full disk):
// - security updates still waiting after a day (unattended-upgrades usually installs them sooner)
// - a restart needed; failed services; a disk at 85% (urgent at 95%); the OS within 180 days of
//   its end of standard support; the report unreadable three times running.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { latestObservations, recordObservation } from '../observations.js';

export const ServerReport = z.object({
  format: z.literal(1),
  host: z.string(),
  generatedAt: z.string(),
  os: z.object({ id: z.string(), version: z.string(), codename: z.string(), name: z.string() }),
  kernel: z.string(),
  uptimeSeconds: z.number().nullable(),
  packages: z.object({
    security: z.array(z.string()),
    other: z.array(z.string()),
    esm: z.array(z.string()),
  }),
  rebootRequired: z.boolean(),
  rebootPackages: z.array(z.string()),
  failedUnits: z.array(z.string()),
  services: z.record(z.string(), z.string()),
  disks: z.array(
    z.object({
      mount: z.string(),
      sizeBytes: z.number(),
      usedBytes: z.number(),
      availableBytes: z.number(),
    }),
  ),
  memory: z.object({
    totalBytes: z.number().nullable(),
    availableBytes: z.number().nullable(),
    swapTotalBytes: z.number().nullable(),
    swapFreeBytes: z.number().nullable(),
  }),
  load: z.object({
    one: z.number().nullable(),
    five: z.number().nullable(),
    fifteen: z.number().nullable(),
    cpus: z.number().nullable(),
  }),
  php: z.array(z.string()),
});
export type ServerReport = z.infer<typeof ServerReport>;

export type ReportReading = { ok: true; report: ServerReport } | { ok: false; problem: string };

/** End of standard support, by Ubuntu codename. Add a line when a server moves release. */
export const UBUNTU_EOL: Record<string, string> = {
  jammy: '2027-06-01',
  noble: '2029-05-31',
  resolute: '2031-05-31',
};

export const DISK_WARN = 0.85;
export const DISK_URGENT = 0.95;
const DAY = 86_400_000;

export interface SshTarget {
  /** user@host, as stored in servers.address. */
  address: string;
  keyPath: string;
  knownHostsPath: string;
}

/** Runs the report over SSH. Never throws: a failure is a reading with a plain-words problem. */
export function readReport(target: SshTarget, signal: AbortSignal): Promise<ReportReading> {
  if (!existsSync(target.keyPath)) {
    return Promise.resolve({ ok: false, problem: 'No SSH key on the mini yet' });
  }
  const args = [
    '-i',
    target.keyPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${target.knownHostsPath}`,
    '-o',
    'ConnectTimeout=15',
    '-T',
    target.address,
  ];
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/ssh',
      args,
      { timeout: 45_000, maxBuffer: 1024 * 1024, signal, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, problem: describeSshFailure(String(stderr), error) });
          return;
        }
        resolve(parseReport(stdout));
      },
    );
  });
}

export function parseReport(stdout: string): ReportReading {
  try {
    const parsed = ServerReport.safeParse(JSON.parse(stdout));
    return parsed.success
      ? { ok: true, report: parsed.data }
      : { ok: false, problem: 'The report’s format wasn’t understood' };
  } catch {
    return { ok: false, problem: 'The report wasn’t JSON' };
  }
}

function describeSshFailure(stderr: string, error: Error & { killed?: boolean }): string {
  if (error.killed || error.name === 'AbortError') return 'The report took too long';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return 'The server’s host key doesn’t match the one Kamaji knows';
  }
  if (/Permission denied/i.test(stderr)) return 'The server refused Kamaji’s key';
  if (/timed out|No route|Could not resolve|Connection refused/i.test(stderr)) {
    return 'Couldn’t reach the server';
  }
  return 'The report failed';
}

const usedShare = (d: ServerReport['disks'][number]) =>
  d.sizeBytes > 0 ? d.usedBytes / d.sizeBytes : 0;

/** The issues one server's reading implies, from it and the readings before. */
export function judgeServer(
  db: Db,
  at: number,
  server: { id: string; name: string },
  reading: ReportReading,
): void {
  const key = (kind: string) => ({ resourceType: 'server', resourceId: server.id, kind }) as const;
  const history = latestObservations<ReportReading>(db, 'server', server.id, 'report', 'ssh', 600);

  if (!reading.ok) {
    const before = history.slice(0, 2);
    if (before.length === 2 && before.every((o) => !o.ok)) {
      raiseIssue(db, at, {
        ...key('unreadable'),
        severity: 'normal',
        summary: `Kamaji can’t read ${server.name}’s report: ${reading.problem}`,
      });
    }
    return; // Nothing else is known, so nothing else changes.
  }
  clearIssue(db, at, key('unreadable'), `Kamaji can read ${server.name}’s report again`);
  const r = reading.report;

  // Security updates: since when has every report shown some waiting?
  const security = r.packages.security.length;
  let since = at;
  for (const o of history) {
    if (!o.ok) continue;
    const v = o.value as Extract<ReportReading, { ok: true }>;
    if (v.report.packages.security.length === 0) break;
    since = o.at;
  }
  if (security > 0 && at - since >= DAY) {
    raiseIssue(db, at, {
      ...key('security-updates'),
      severity: 'normal',
      summary: `${server.name}: ${security} security ${security === 1 ? 'update' : 'updates'} waiting for over a day`,
    });
  } else if (security === 0) {
    clearIssue(db, at, key('security-updates'), `${server.name}’s security updates are installed`);
  }

  if (r.rebootRequired) {
    raiseIssue(db, at, {
      ...key('reboot'),
      severity: 'normal',
      summary: `${server.name} needs a restart to finish updates`,
    });
  } else {
    clearIssue(db, at, key('reboot'), `${server.name} has restarted`);
  }

  const down = [
    ...r.failedUnits,
    ...Object.entries(r.services)
      .filter(([, state]) => state === 'failed' || state === 'inactive')
      .map(([unit]) => unit),
  ];
  const failed = [...new Set(down.map((u) => u.replace(/\.service$/, '')))].sort();
  if (failed.length > 0) {
    raiseIssue(db, at, {
      ...key('services'),
      severity: 'normal',
      summary: `${server.name}: ${failed.length === 1 ? 'a service has' : `${failed.length} services have`} stopped (${failed.join(', ')})`,
    });
  } else {
    clearIssue(db, at, key('services'), `${server.name}’s services are running`);
  }

  const fullest = [...r.disks].sort((a, b) => usedShare(b) - usedShare(a))[0];
  if (fullest && usedShare(fullest) >= DISK_WARN) {
    raiseIssue(db, at, {
      ...key('disk'),
      severity: usedShare(fullest) >= DISK_URGENT ? 'urgent' : 'normal',
      summary: `${server.name}: ${fullest.mount} is ${Math.round(usedShare(fullest) * 100)}% full`,
    });
  } else {
    clearIssue(db, at, key('disk'), `${server.name} has disk space again`);
  }

  const eol = r.os.id === 'ubuntu' ? UBUNTU_EOL[r.os.codename] : undefined;
  if (eol && Date.parse(eol) - at <= 180 * DAY) {
    raiseIssue(db, at, {
      ...key('os-eol'),
      severity: 'normal',
      summary: `${server.name}: ${r.os.name} leaves standard support on ${eol}`,
    });
  } else {
    clearIssue(db, at, key('os-eol'), `${server.name}’s OS is supported`);
  }
}

export interface LinuxServer {
  id: string;
  name: string;
  address: string;
}

export function linuxServers(db: Db): LinuxServer[] {
  return db
    .prepare(
      `SELECT id, name, address FROM servers WHERE removed_at IS NULL AND kind = 'linux-ssh'
       ORDER BY name`,
    )
    .all()
    .map((r) => ({ id: String(r.id), name: String(r.name), address: String(r.address) }));
}

/** Reads every Linux server's report once. Returns how many it read. */
export async function checkServers(
  db: Db,
  options: {
    now: () => number;
    signal: AbortSignal;
    keyPath: string;
    knownHostsPath: string;
    read?: (target: SshTarget, signal: AbortSignal) => Promise<ReportReading>;
  },
): Promise<number> {
  const read = options.read ?? readReport;
  const servers = linuxServers(db);
  for (const server of servers) {
    const reading = await read(
      { address: server.address, keyPath: options.keyPath, knownHostsPath: options.knownHostsPath },
      options.signal,
    );
    if (options.signal.aborted) throw options.signal.reason;
    const at = options.now();
    transaction(db, () => {
      judgeServer(db, at, server, reading);
      recordObservation(db, {
        resourceType: 'server',
        resourceId: server.id,
        check: 'report',
        source: 'ssh',
        at,
        ok: reading.ok,
        value: reading,
      });
    });
  }
  return servers.length;
}
