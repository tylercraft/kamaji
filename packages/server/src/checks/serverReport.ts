// craftish (and any Linux server): Kamaji runs `ssh` with a key whose only power is the forced
// command /usr/local/bin/kamaji-report (server-report/), parses the JSON it prints, keeps it as an
// observation and raises issues from it. Kamaji recommends; patching and restarts stay Tyler's.
//
// Issues (for the morning digest unless said otherwise):
// - package updates, rated in serverUpdates.ts: a security update to an internet-facing package
//   or a restart pending over 7 days is urgent; other security updates after a day, a restart,
//   and 20+ ordinary updates with the oldest over 30 days are for the digest
// - failed services; a disk at 85% (urgent at 95%); the OS within 180 days of its end of
//   standard support; the report unreadable three times running.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db.js';
import { transaction } from '../db.js';
import { clearIssue, raiseIssue } from '../issues.js';
import { latestObservations, recordObservation } from '../observations.js';
import { readState, writeState } from '../state.js';
import { rateUpdates, syncUpdates, type Finding, type Upgradable } from './serverUpdates.js';

const UpgradableEntry = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
  suites: z.array(z.string()),
  security: z.boolean(),
  esm: z.boolean(),
});

/** Format 2 adds the upgradable list and rebootRequiredSince; format 1 is still read. */
export const ServerReport = z.object({
  format: z.union([z.literal(1), z.literal(2)]),
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
  upgradable: z.array(UpgradableEntry).optional(),
  upgradableTotal: z.number().int().optional(),
  truncated: z.boolean().optional(),
  rebootRequired: z.boolean(),
  rebootPackages: z.array(z.string()),
  rebootRequiredSince: z.string().nullable().optional(),
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

/** A report's upgradable packages; format 1 has only their names, without versions. */
export function upgradableOf(r: ServerReport): Upgradable[] {
  if (r.upgradable) return r.upgradable;
  const esm = new Set(r.packages.esm);
  const entry = (name: string, security: boolean): Upgradable => ({
    name,
    from: '',
    to: '',
    suites: [],
    security: security && !esm.has(name),
    esm: esm.has(name),
  });
  return [
    ...r.packages.security.map((n) => entry(n, true)),
    ...r.packages.other.map((n) => entry(n, false)),
  ];
}

const REBOOT_STATE = (serverId: string) => `server.reboot-since.${serverId}`;

/**
 * Since when a restart has been pending: the report's own time for it (format 2), else when
 * Kamaji first saw it pending. Null when no restart is needed.
 */
export function rebootSince(db: Db, serverId: string, r: ServerReport): number | null {
  if (!r.rebootRequired) return null;
  const reported = r.rebootRequiredSince ? Date.parse(r.rebootRequiredSince) : NaN;
  if (!Number.isNaN(reported)) return reported;
  return readState<{ at: number }>(db, REBOOT_STATE(serverId))?.at ?? null;
}

/** The report as kept in observations: the upgradable list lives in server_updates instead. */
export function slim(reading: ReportReading): ReportReading {
  if (!reading.ok || !reading.report.upgradable) return reading;
  const report: ServerReport = { ...reading.report };
  delete report.upgradable;
  return { ok: true, report };
}

/** The issues one server's reading implies, from it and the readings before. */
export function judgeServer(
  db: Db,
  at: number,
  server: { id: string; name: string },
  reading: ReportReading,
): void {
  const key = (kind: string) => ({ resourceType: 'server', resourceId: server.id, kind }) as const;
  const history = latestObservations<ReportReading>(db, 'server', server.id, 'report', 'ssh', 2);

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

  // Package updates and a pending restart, rated in serverUpdates.ts.
  if (r.rebootRequired) {
    if (!readState(db, REBOOT_STATE(server.id)))
      writeState(db, REBOOT_STATE(server.id), { at }, at);
  } else {
    writeState(db, REBOOT_STATE(server.id), null, at);
  }
  const rows = syncUpdates(db, server.id, at, upgradableOf(r), r.truncated ?? false);
  const rating = rateUpdates({
    server: server.name,
    now: at,
    rows,
    services: r.services,
    reboot: {
      required: r.rebootRequired,
      since: rebootSince(db, server.id, r),
      packages: r.rebootPackages,
    },
  });
  const apply = (kind: string, finding: Finding) => {
    if (finding.action === 'raise') {
      raiseIssue(db, at, { ...key(kind), severity: finding.severity, summary: finding.summary });
    } else if (finding.action === 'clear') {
      clearIssue(db, at, key(kind), finding.summary);
    }
  };
  apply('security-updates', rating.security);
  apply('reboot', rating.reboot);
  apply('stale-updates', rating.stale);

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
        value: slim(reading),
      });
    });
  }
  return servers.length;
}
