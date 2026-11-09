// The API's contract: every response the server sends and the web app reads, as zod schemas.
// The server builds responses typed from these; the web app parses with them, so a change that
// breaks the UI fails to compile, and a response that drifts fails loudly instead of rendering wrong.
import { z } from 'zod';

/** ISO 8601 timestamp, always UTC on the wire. */
export const Timestamp = z.iso.datetime();

/**
 * A value Kamaji may not know yet. Unknown is never zero, never healthy, never "none":
 * the UI renders the reason instead of a number.
 */
export const known = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('known', [
    z.object({ known: z.literal(true), value }),
    z.object({ known: z.literal(false), reason: z.string() }),
  ]);
export type Known<T> = { known: true; value: T } | { known: false; reason: string };

// Resources

export const HostKind = z.enum(['craftish', 'kinsta', 'wpengine', 'other']);
export type HostKind = z.infer<typeof HostKind>;

/** Connected runs Craftish Care; monitoring only gets uptime and certificate checks. */
export const SiteMode = z.enum(['connected', 'monitoring']);
export type SiteMode = z.infer<typeof SiteMode>;

/** Where an unfinished Add site setup stopped, or done. */
export const SetupStep = z.enum(['identify', 'connect', 'configure', 'done']);
export type SetupStep = z.infer<typeof SetupStep>;

export const Site = z.object({
  id: z.string(),
  name: z.string(),
  url: z.url(),
  hostKind: HostKind,
  clientSlug: z.string().nullable(),
  mode: SiteMode,
  setup: SetupStep,
  /** Answers only on the tailnet: the Worker can't see it, so its alerts come from the mini. */
  tailnetOnly: z.boolean(),
  /** Text the home page must contain, or null when none is set. */
  expectedText: z.string().nullable(),
  pausedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Site = z.infer<typeof Site>;

/**
 * The home page check from the mini, as last seen. `failing` is a failed check that hasn't
 * repeated yet; `down` is two in a row, which opens an issue.
 */
export const Availability = z.object({
  state: z.enum(['up', 'failing', 'down']),
  checkedAt: Timestamp,
  /** Time to the response headers; null when there was no response. */
  responseMs: z.number().int().nullable(),
  /** Why the last check failed, in plain words; null when it passed. */
  problem: z.string().nullable(),
});
export type Availability = z.infer<typeof Availability>;

export const Certificate = z.object({
  validTo: Timestamp,
  daysLeft: z.number().int(),
  checkedAt: Timestamp,
});
export type Certificate = z.infer<typeof Certificate>;

/** The Worker's check of the same page, from Cloudflare's network. */
export const OutsideCheck = z.object({
  ok: z.boolean(),
  checkedAt: Timestamp,
  problem: z.string().nullable(),
});
export type OutsideCheck = z.infer<typeof OutsideCheck>;

export const SiteSummary = Site.extend({
  availability: known(Availability),
  outside: known(OutsideCheck),
  certificate: known(Certificate),
});
export type SiteSummary = z.infer<typeof SiteSummary>;

export const ServerKind = z.enum(['linux-ssh', 'local-mac']);
export type ServerKind = z.infer<typeof ServerKind>;

export const Server = z.object({
  id: z.string(),
  name: z.string(),
  kind: ServerKind,
  address: z.string(),
  createdAt: Timestamp,
});
export type Server = z.infer<typeof Server>;

/** What craftish's report last said. */
export const LinuxHealth = z.object({
  kind: z.literal('linux-ssh'),
  checkedAt: Timestamp,
  os: z.string(),
  /** End of the OS's standard support, as a date; null when Kamaji doesn't know it. */
  osSupportEnds: z.string().nullable(),
  uptimeSeconds: z.number().int().nullable(),
  securityUpdates: z.array(z.string()),
  otherUpdates: z.number().int(),
  rebootRequired: z.boolean(),
  /** Failed or stopped services. */
  stopped: z.array(z.string()),
  disks: z.array(
    z.object({ mount: z.string(), usedPercent: z.number().int(), availableBytes: z.number() }),
  ),
  memoryUsedPercent: z.number().int().nullable(),
  load: z.object({ one: z.number().nullable(), cpus: z.number().int().nullable() }),
  php: z.array(z.string()),
});
export type LinuxHealth = z.infer<typeof LinuxHealth>;

export const MacDisk = z.object({
  name: z.string(),
  mount: z.string(),
  mounted: z.boolean(),
  /** Null when it isn't mounted or couldn't be read. */
  usedPercent: z.number().int().nullable(),
  availableBytes: z.number().nullable(),
  /** diskutil's SMART status, as it says it ("Verified"); null when it gives none. */
  smart: z.string().nullable(),
  writable: z.boolean().nullable(),
});
export type MacDisk = z.infer<typeof MacDisk>;

/** One LaunchAgent: Calcifer's jobs and Kamaji itself. */
export const MacJob = z.object({
  name: z.string(),
  label: z.string(),
  state: z.enum(['running', 'idle', 'not-loaded']),
  keepAlive: z.boolean(),
  schedule: z.string().nullable(),
  /** Null until it has exited once. */
  lastExitCode: z.number().int().nullable(),
  runs: z.number().int().nullable(),
  /** When Kamaji last saw it start a run (to within a cycle); null until it has. */
  lastRunAt: Timestamp.nullable(),
  /** Its log tail and crash text may be shown: it never reads mail or untrusted text. */
  fullText: z.boolean(),
  /** What needs Tyler, in plain words, or null. */
  attention: z.string().nullable(),
});
export type MacJob = z.infer<typeof MacJob>;

export const CrashGroup = z.object({
  id: z.string(),
  job: z.string(),
  type: z.string(),
  where: z.string().nullable(),
  line: z.number().int().nullable(),
  /** The stack, innermost last: file, function and line only. */
  frames: z.array(
    z.object({ file: z.string(), function: z.string(), line: z.number().int().nullable() }),
  ),
  lastAt: Timestamp,
  /** Crashes in the last 7 days. */
  recent: z.number().int(),
});
export type CrashGroup = z.infer<typeof CrashGroup>;

/** What molcajete's local readers last said. Each part can be unknown on its own. */
export const MacHealth = z.object({
  kind: z.literal('local-mac'),
  checkedAt: Timestamp,
  bootedAt: known(Timestamp),
  disks: z.array(MacDisk),
  updates: known(
    z.object({
      checkedAt: Timestamp,
      items: z.array(z.object({ label: z.string(), title: z.string(), restart: z.boolean() })),
    }),
  ),
  docker: known(
    z.object({
      engine: z.string(),
      desktop: z.string().nullable(),
      containers: z.array(
        z.object({
          name: z.string(),
          image: z.string(),
          state: z.string(),
          status: z.string(),
          healthy: z.boolean(),
        }),
      ),
    }),
  ),
  tailscale: known(
    z.object({
      state: z.string(),
      online: z.boolean(),
      health: z.array(z.string()),
      version: z.string(),
    }),
  ),
  /** Calcifer's repo-pull: when its log last said anything, and since when it's been failing. */
  repoPull: known(z.object({ lastAt: Timestamp, failingSince: Timestamp.nullable() })),
  jobs: z.array(MacJob),
  crashes: z.array(CrashGroup),
});
export type MacHealth = z.infer<typeof MacHealth>;

export const ServerHealth = z.discriminatedUnion('kind', [LinuxHealth, MacHealth]);
export type ServerHealth = z.infer<typeof ServerHealth>;

/** One job's text for the Servers page, read on the mini when asked and never stored. */
export const JobDetailResponse = z.object({
  name: z.string(),
  log: known(z.string()),
  crash: known(
    z
      .object({
        at: Timestamp,
        type: z.string(),
        where: z.string().nullable(),
        line: z.number().int().nullable(),
        message: z.string().nullable(),
        traceback: z.string().nullable(),
      })
      .nullable(),
  ),
});
export type JobDetailResponse = z.infer<typeof JobDetailResponse>;

export const ServerSummary = Server.extend({
  /** From the last report that could be read. */
  health: known(ServerHealth),
  /** The last attempt, which may have failed after a good one. */
  lastAttempt: known(z.object({ ok: z.boolean(), at: Timestamp, problem: z.string().nullable() })),
});
export type ServerSummary = z.infer<typeof ServerSummary>;

export const Severity = z.enum(['urgent', 'normal']);
export type Severity = z.infer<typeof Severity>;

export const Issue = z.object({
  id: z.string(),
  resourceType: z.enum(['site', 'server', 'kamaji']),
  resourceId: z.string(),
  kind: z.string(),
  severity: Severity,
  summary: z.string(),
  firstSeenAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type Issue = z.infer<typeof Issue>;

export const ActivityEvent = z.object({
  id: z.number().int(),
  at: Timestamp,
  kind: z.string(),
  summary: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

// Responses

/** Kamaji's own health: its check cycle and the dead-man ping that tells healthchecks.io it's alive. */
export const StatusResponse = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  startedAt: Timestamp,
  now: Timestamp,
  cycle: z.object({
    intervalSeconds: z.number().int(),
    last: z
      .object({
        startedAt: Timestamp,
        finishedAt: Timestamp.nullable(),
        state: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
      })
      .nullable(),
  }),
  /** Kamaji's Discord webhook (#kamaji): whether it's set and how the last message went. */
  alerts: z.discriminatedUnion('configured', [
    z.object({ configured: z.literal(false) }),
    z.object({
      configured: z.literal(true),
      lastOk: z.boolean().nullable(),
      lastSuccessAt: Timestamp.nullable(),
    }),
  ]),
  heartbeat: z.discriminatedUnion('configured', [
    z.object({ configured: z.literal(false) }),
    z.object({
      configured: z.literal(true),
      lastAttemptAt: Timestamp.nullable(),
      lastOk: z.boolean().nullable(),
      lastSuccessAt: Timestamp.nullable(),
    }),
  ]),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

export const OverviewResponse = z.object({
  sites: z.object({
    total: z.number().int(),
    connected: z.number().int(),
    monitoring: z.number().int(),
    paused: z.number().int(),
    unfinished: z.number().int(),
    /** Of the sites being checked: down now, and not checked yet. */
    down: z.number().int(),
    unchecked: z.number().int(),
  }),
  servers: z.object({ total: z.number().int() }),
  /** Open issues. Only meaningful once something is being watched: `known: false` until then. */
  attention: known(z.array(Issue)),
  /** Pending updates. Unknown until a connected site has reported its inventory. */
  updatesWaiting: known(z.number().int()),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;

export const SitesResponse = z.object({ sites: z.array(SiteSummary) });
export type SitesResponse = z.infer<typeof SitesResponse>;

export const ServersResponse = z.object({ servers: z.array(ServerSummary) });
export type ServersResponse = z.infer<typeof ServersResponse>;

export const ActivityResponse = z.object({
  events: z.array(ActivityEvent),
  /** Pass as `before` for the next page; null when this is the oldest. */
  nextBefore: z.number().int().nullable(),
});
export type ActivityResponse = z.infer<typeof ActivityResponse>;

export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
