// The API's contract: every response the server sends and the web app reads, as zod schemas.
// The server builds responses typed from these; the web app parses with them, so a change that
// breaks the UI fails to compile, and a response that drifts fails loudly instead of rendering wrong.
import { z } from 'zod';

export * from './version.js';

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
  /** Read, but not good: "Certificate not trusted", "Certificate expired". Null when it's fine. */
  problem: z.string().nullable(),
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
  /** Components WordPress offers an update for, from the last good report. */
  updates: known(z.number().int()),
  /**
   * Those offers split by where they stand: still to approve (what the Updates queue lists), or
   * already in a run that's held or still going. Every offered component is in one of the three
   * unless a run has an item WordPress no longer offers.
   */
  updateWork: z.object({
    toApprove: z.number().int(),
    held: z.number().int(),
    running: z.number().int(),
    /** Offered without a download (often a licence missing): can't be approved. */
    noDownload: z.number().int(),
  }),
  /**
   * Open issues other than reachability and the certificate, which have their own columns: a
   * site can be up and still need attention (vulnerabilities, end of life, backups, a held run).
   */
  findings: z.array(
    z.object({ kind: z.string(), severity: z.enum(['urgent', 'normal']), summary: z.string() }),
  ),
});
export type SiteSummary = z.infer<typeof SiteSummary>;

/** Why the plugin couldn't update a site (docs/protocol.md, "Capabilities"). */
export const UpdateBlocker = z.enum([
  'below_floor',
  'file_mods_disallowed',
  'filesystem_not_direct',
  'plugins_not_writable',
  'themes_not_writable',
  'core_not_writable',
]);
export type UpdateBlocker = z.infer<typeof UpdateBlocker>;

/** craftish-care's answer to hello: who it is and what the site lets it do. */
export const CareHello = z.object({
  plugin: z.string(),
  protocol: z.number().int(),
  wordpress: z.string(),
  php: z.string(),
  multisite: z.boolean(),
  capabilities: z.object({
    can_report: z.boolean(),
    can_update: z.boolean(),
    // An unknown code still reads as a blocker, never as "can update".
    update_blockers: z.array(z.string()),
    auto_updates: z.object({
      all_disabled: z.boolean(),
      plugins: z.boolean(),
      themes: z.boolean(),
    }),
    maintenance: z.object({ present: z.boolean(), age_seconds: z.number().int().nullable() }),
    wp_cron_disabled: z.boolean(),
    loopback: z.object({ ok: z.boolean() }),
  }),
});
export type CareHello = z.infer<typeof CareHello>;

const CareOffer = z.object({ version: z.string(), package: z.boolean() }).nullable();

/** craftish-care's answer to report (docs/protocol.md, "The report"). */
export const CareReport = z.object({
  refreshed: z.boolean(),
  core: z.object({
    version: z.string(),
    locale: z.string(),
    offers: z.array(
      z.object({
        version: z.string(),
        locale: z.string(),
        response: z.string(),
        package: z.boolean(),
      }),
    ),
  }),
  plugins: z.array(
    z.object({
      file: z.string(),
      slug: z.string(),
      name: z.string(),
      version: z.string(),
      active: z.boolean(),
      auto_update: z.boolean(),
      offer: CareOffer,
    }),
  ),
  themes: z.array(
    z.object({
      stylesheet: z.string(),
      name: z.string(),
      version: z.string(),
      active: z.boolean(),
      parent: z.string().nullable(),
      auto_update: z.boolean(),
      offer: CareOffer,
    }),
  ),
  /** From Craftish Care 0.2.0: wp-content/mu-plugins' top-level files, as WordPress loads them. */
  mu_plugins: z
    .array(z.object({ file: z.string(), name: z.string(), version: z.string() }))
    .optional(),
  php: z.string(),
  database: z.object({ server: z.string(), version: z.string() }),
  checked_at: z.object({
    core: z.number().int().nullable(),
    plugins: z.number().int().nullable(),
    themes: z.number().int().nullable(),
  }),
  site_health: z.array(z.object({ test: z.string(), label: z.string() })),
});
export type CareReport = z.infer<typeof CareReport>;

export const Offer = z.object({
  version: z.string(),
  /** False for a paid plugin without a licence: WordPress offers a version it can't download. */
  hasPackage: z.boolean(),
});
export type Offer = z.infer<typeof Offer>;

/** wordpress.org's answer for one plugin slug. */
export const DirectoryStatus = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('listed'),
    latestVersion: z.string().nullable(),
    lastUpdated: Timestamp.nullable(),
    tested: z.string().nullable(),
    checkedAt: Timestamp,
  }),
  z.object({
    status: z.literal('closed'),
    closedDate: z.string().nullable(),
    reason: z.string().nullable(),
    checkedAt: Timestamp,
  }),
  z.object({ status: z.literal('not-listed'), checkedAt: Timestamp }),
]);
export type DirectoryStatus = z.infer<typeof DirectoryStatus>;

/** A known vulnerability affecting what's installed (Wordfence Intelligence). */
export const VulnerabilityMatch = z.object({
  id: z.string(),
  title: z.string(),
  /** Wordfence's general notes ("all known versions"): shown, never an issue. */
  informational: z.boolean(),
  cvssScore: z.number().nullable(),
  cvssRating: z.string().nullable(),
  cve: z.string().nullable(),
  /** The lowest patched version above what's installed; null when there's no fix yet. */
  fixedIn: z.string().nullable(),
  remediation: z.string().nullable(),
  reference: z.string().nullable(),
  published: z.string().nullable(),
});
export type VulnerabilityMatch = z.infer<typeof VulnerabilityMatch>;

export const InventoryPlugin = z.object({
  file: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  active: z.boolean(),
  autoUpdate: z.boolean(),
  offer: Offer.nullable(),
  /** Null until wordpress.org has been asked. */
  directory: DirectoryStatus.nullable(),
  vulnerabilities: z.array(VulnerabilityMatch),
});
export type InventoryPlugin = z.infer<typeof InventoryPlugin>;

export const InventoryTheme = z.object({
  stylesheet: z.string(),
  name: z.string(),
  version: z.string(),
  active: z.boolean(),
  parent: z.string().nullable(),
  autoUpdate: z.boolean(),
  offer: Offer.nullable(),
  vulnerabilities: z.array(VulnerabilityMatch),
});
export type InventoryTheme = z.infer<typeof InventoryTheme>;

/** A must-use plugin: listed only. WordPress never updates one, and Kamaji doesn't check it. */
export const InventoryMuPlugin = z.object({
  file: z.string(),
  name: z.string(),
  version: z.string(),
});
export type InventoryMuPlugin = z.infer<typeof InventoryMuPlugin>;

/** Where a PHP or database release line stands, from Kamaji's end-of-life list. */
export const EndOfLife = z.object({
  product: z.enum(['PHP', 'MySQL', 'MariaDB']),
  /** The release line, like "8.2"; null when the version couldn't be read. */
  line: z.string().nullable(),
  /** Security support ends on this day (UTC); null when the line isn't on the list. */
  endsOn: z.string().nullable(),
  state: z.enum(['supported', 'ending', 'ended', 'unknown']),
});
export type EndOfLife = z.infer<typeof EndOfLife>;

/** A connected site's inventory, from its last good report. */
export const Inventory = z.object({
  reportedAt: Timestamp,
  /** When WordPress itself last checked for updates, per kind. */
  wordpressCheckedAt: z.object({
    core: Timestamp.nullable(),
    plugins: Timestamp.nullable(),
    themes: Timestamp.nullable(),
  }),
  core: z.object({
    version: z.string(),
    locale: z.string(),
    offer: Offer.nullable(),
    vulnerabilities: z.array(VulnerabilityMatch),
  }),
  /**
   * Whether the vulnerability lists mean anything: unknown until a Wordfence download has
   * worked, and stale after two days. An empty list is "none known" only when this is known.
   */
  vulnerabilityData: known(
    z.object({ fetchedAt: Timestamp, stale: z.boolean(), problem: z.string().nullable() }),
  ),
  php: z.string(),
  database: z.string(),
  endOfLife: z.object({ php: EndOfLife, database: EndOfLife }),
  plugins: z.array(InventoryPlugin),
  /** Unknown when the site's Craftish Care is older than 0.2.0. */
  muPlugins: known(z.array(InventoryMuPlugin)),
  themes: z.array(InventoryTheme),
  siteHealth: z.array(z.object({ test: z.string(), label: z.string() })),
  /** The latest report failed: what's shown is from reportedAt and must say so. */
  lastFailure: z.object({ at: Timestamp, problem: z.string() }).nullable(),
});
export type Inventory = z.infer<typeof Inventory>;

/** The handshake as Kamaji saw it: the plugin's answer, or why there wasn't one. */
export const Handshake = z.object({
  at: Timestamp,
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), hello: CareHello }),
    z.object({ ok: z.literal(false), problem: z.string() }),
  ]),
});
export type Handshake = z.infer<typeof Handshake>;

/** Add site, step 1. */
export const NewSiteRequest = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.url({ protocol: /^https?$/ }),
  hostKind: HostKind,
  clientSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,60}$/)
    .nullable(),
});
export type NewSiteRequest = z.infer<typeof NewSiteRequest>;

export const BackupExpectation = z.enum(['kamaji', 'host', 'client', 'tyler']);
export type BackupExpectation = z.infer<typeof BackupExpectation>;

/** Whole-site backups (TY-166): restic snapshots of a craftish site, off by default. */
export const SiteBackupSchedule = z.enum(['off', 'weekly', 'fortnightly']);
export type SiteBackupSchedule = z.infer<typeof SiteBackupSchedule>;

/** Add site, step 3. The whole-site backup fields are left as they were when absent. */
export const ConfigureSiteRequest = z.object({
  /** The display name; left as it was when absent. The id, domain, keys and history never change. */
  name: z.string().trim().min(1).max(80).optional(),
  expectedText: z.string().trim().max(200).nullable(),
  backupExpectation: BackupExpectation.nullable(),
  notifications: z.enum(['normal', 'digest']),
  /** Tyler's own site: whole-site backups ask no client. */
  own: z.boolean().optional(),
  siteBackups: SiteBackupSchedule.optional(),
  /** Ticked: the client agreed to whole-site backups. Needed to turn them on for a client's site. */
  clientAgreed: z.boolean().optional(),
});
export type ConfigureSiteRequest = z.infer<typeof ConfigureSiteRequest>;

/** Remove: the name typed back, as the confirmation. */
export const RemoveSiteRequest = z.object({ confirm: z.string() });
export type RemoveSiteRequest = z.infer<typeof RemoveSiteRequest>;

/** One site, for the setup and manage views. */
export const SiteDetailResponse = z.object({
  site: SiteSummary,
  handshake: Handshake.nullable(),
  inventory: known(Inventory),
  backupExpectation: BackupExpectation.nullable(),
  notifications: z.enum(['normal', 'digest']),
  /** Whether this Kamaji has craftish-care keys, so connecting is possible at all. */
  canConnect: z.boolean(),
  own: z.boolean(),
  siteBackups: z.object({
    schedule: SiteBackupSchedule,
    /** When the client's agreement was ticked, and by whom; null on Tyler's own sites or off. */
    consentAt: Timestamp.nullable(),
    consentBy: z.string().nullable(),
  }),
});
export type SiteDetailResponse = z.infer<typeof SiteDetailResponse>;

/** What Remove did: the plugin forgot its keys, or the cleanup Tyler still has to do. */
export const RemoveSiteResponse = z.object({
  removed: z.literal(true),
  disconnect: z.enum(['done', 'not-connected', 'failed', 'no-update-key']),
  problem: z.string().nullable(),
});
export type RemoveSiteResponse = z.infer<typeof RemoveSiteResponse>;

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

/** One package waiting on a server, as the Servers page lists it. */
export const ServerPackage = z.object({
  name: z.string(),
  /** Empty when an older report (format 1) didn't say. */
  from: z.string(),
  to: z.string(),
  /** When Kamaji first saw this version waiting. */
  waitingSince: Timestamp,
  /** What it's part of, when that's internet-facing: "OpenSSL", "the kernel". */
  internetFacing: z.string().nullable(),
  /** Why it deserves a careful pass ("restarts the database"), or null. */
  care: z.string().nullable(),
});
export type ServerPackage = z.infer<typeof ServerPackage>;

/** A server's package updates, rated (TY-167; checks/serverUpdates.ts on the server). */
export const ServerUpdates = z.object({
  level: z.enum(['urgent', 'digest', 'ok']),
  /** The rating in words, most pressing first. */
  words: z.array(z.string()),
  security: z.array(ServerPackage),
  /** Not security, but deserve a careful pass: MariaDB, the web server, PHP, the kernel. */
  care: z.array(ServerPackage),
  routine: z.array(ServerPackage),
  /** Ubuntu Pro's ESM updates: information only. */
  esm: z.array(z.string()),
  total: z.number().int(),
  /** The report's list was cut at its cap; total is the full count. */
  truncated: z.boolean(),
  reboot: z.object({ since: Timestamp.nullable(), packages: z.array(z.string()) }).nullable(),
});
export type ServerUpdates = z.infer<typeof ServerUpdates>;

/** What craftish's report last said. */
export const LinuxHealth = z.object({
  kind: z.literal('linux-ssh'),
  checkedAt: Timestamp,
  os: z.string(),
  /** End of the OS's standard support, as a date; null when Kamaji doesn't know it. */
  osSupportEnds: z.string().nullable(),
  uptimeSeconds: z.number().int().nullable(),
  updates: ServerUpdates,
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

// Updates (M4): the queue, approved batches and their outcomes (calcifer explore/kamaji.md,
// "Selecting and approving a batch").

export const ComponentType = z.enum(['core', 'plugin', 'theme']);
export type ComponentType = z.infer<typeof ComponentType>;

export const BackupKind = z.enum(['kamaji', 'host', 'client', 'tyler']);
export type BackupKind = z.infer<typeof BackupKind>;

/** One update WordPress offers on one site, ready to tick. */
export const QueueItem = z.object({
  siteId: z.string(),
  siteName: z.string(),
  type: ComponentType,
  /** "core", the plugin file, or the theme stylesheet. */
  item: z.string(),
  name: z.string(),
  from: z.string(),
  to: z.string(),
  /** A known vulnerability that this version fixes. */
  security: z.boolean(),
  /** Of the component's known vulnerabilities (not informational ones), how many this version fixes. */
  fixes: z.number().int(),
  findings: z.number().int(),
  /** A major version: never in "all routine". */
  major: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueSite = z.object({
  siteId: z.string(),
  siteName: z.string(),
  backupKind: BackupKind,
  /** Why this site's offers can't be queued, or null when they can. */
  blocked: z.string().nullable(),
});
export type QueueSite = z.infer<typeof QueueSite>;

export const Outcome = z.enum(['passed', 'checks_failed', 'update_failed', 'incomplete']);
export type Outcome = z.infer<typeof Outcome>;

export const BatchItemView = z.object({
  id: z.string(),
  type: ComponentType,
  item: z.string(),
  name: z.string(),
  from: z.string(),
  to: z.string(),
  state: z.enum(['waiting', 'sent', 'running', 'checking', 'done', 'held']),
  outcome: Outcome.nullable(),
  /** What happened, in plain words. */
  detail: z.string().nullable(),
});
export type BatchItemView = z.infer<typeof BatchItemView>;

export const BatchSiteView = z.object({
  siteId: z.string(),
  siteName: z.string(),
  state: z.enum(['waiting', 'running', 'done', 'held']),
  /** When the updater started and finished this site; null until it has. */
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  heldReason: z.string().nullable(),
  backupKind: BackupKind,
  /** The backup evidence as recorded for this run. */
  backup: z.string().nullable(),
  items: z.array(BatchItemView),
});
export type BatchSiteView = z.infer<typeof BatchSiteView>;

export const BatchView = z.object({
  id: z.string(),
  approvedAt: Timestamp,
  approvedBy: z.string(),
  /** When the whole run finished; null while it's going or held. */
  finishedAt: Timestamp.nullable(),
  state: z.enum(['approved', 'running', 'finished']),
  oneSiteFirst: z.boolean(),
  sites: z.array(BatchSiteView),
});
export type BatchView = z.infer<typeof BatchView>;

export const UpdatesResponse = z.object({
  items: z.array(QueueItem),
  sites: z.array(QueueSite),
  /** Connected sites whose offers aren't known yet. */
  unknown: z.number().int(),
  batches: z.array(BatchView),
});
export type UpdatesResponse = z.infer<typeof UpdatesResponse>;

export const ApproveRequest = z.object({
  items: z
    .array(
      z.object({
        siteId: z.string(),
        type: ComponentType,
        item: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    )
    .min(1)
    .max(200),
  /** Sites whose backup is Tyler's word, confirmed for this run. */
  confirmedBackups: z.array(z.string()),
  oneSiteFirst: z.boolean(),
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const ApproveResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), batchId: z.string() }),
  z.object({
    ok: z.literal(false),
    /** Items whose versions changed since they were shown, or sites needing a confirmed backup. */
    changed: z.array(z.string()),
    needsBackup: z.array(z.string()),
  }),
]);
export type ApproveResponse = z.infer<typeof ApproveResponse>;

/**
 * One piece of a site's backup evidence: an export Kamaji asked for (before a run, or "Back up
 * now"), with what the export answered; or, for a run before Kamaji kept exports apart, the
 * words the run recorded.
 */
export const BackupEntry = z.object({
  recordedAt: Timestamp,
  state: z.enum(['exported', 'failed', 'recorded']),
  /** The run it was for, and when that run was approved; null for "Back up now". */
  batchId: z.string().nullable(),
  runApprovedAt: Timestamp.nullable(),
  /** The export's own time, size and SHA-256, as it answered. */
  exportedAt: Timestamp.nullable(),
  bytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  words: z.string(),
});
export type BackupEntry = z.infer<typeof BackupEntry>;

/** One whole-site backup attempt (sitebackups/ on the server). */
export const SiteSnapshot = z.object({
  startedAt: Timestamp,
  finishedAt: Timestamp,
  ok: z.boolean(),
  /** The tar's size, and what restic had to store that it didn't have already. */
  bytes: z.number().int().nullable(),
  addedBytes: z.number().int().nullable(),
  databaseBytes: z.number().int().nullable(),
  wordpress: z.string().nullable(),
  problem: z.string().nullable(),
  /** Let go by retention (4 weekly, 6 monthly): no longer restorable. */
  forgotten: z.boolean(),
});
export type SiteSnapshot = z.infer<typeof SiteSnapshot>;

export const RestoreCheck = z.object({
  startedAt: Timestamp,
  seconds: z.number().int(),
  ok: z.boolean(),
  failedStep: z.string().nullable(),
  problem: z.string().nullable(),
});
export type RestoreCheck = z.infer<typeof RestoreCheck>;

export const WholeSiteBackups = z.object({
  schedule: SiteBackupSchedule,
  own: z.boolean(),
  consentAt: Timestamp.nullable(),
  consentBy: z.string().nullable(),
  /** Switched on, with the agreement it needs: what the process will back up. */
  active: z.boolean(),
  lastGoodAt: Timestamp.nullable(),
  /** When the nightly run next takes it; null while switched off. */
  nextDueAt: Timestamp.nullable(),
  /** Newest first. */
  snapshots: z.array(SiteSnapshot),
  /** Newest first. */
  restoreChecks: z.array(RestoreCheck),
  /** A request from this panel not yet answered: when it was asked. */
  pending: z.object({ backup: Timestamp.nullable(), restore: Timestamp.nullable() }),
  /** The whole repository's size on disk, all sites, as the process last measured it. */
  repository: z.object({ bytes: z.number().int(), at: Timestamp }).nullable(),
});
export type WholeSiteBackups = z.infer<typeof WholeSiteBackups>;

export const WholeSiteRequest = z.object({ kind: z.enum(['backup', 'restore']) });
export type WholeSiteRequest = z.infer<typeof WholeSiteRequest>;

export const SiteBackupsResponse = z.object({
  backupExpectation: BackupExpectation.nullable(),
  /** The newest export's time, for "Download latest export"; null when there's none. */
  download: z.object({ exportedAt: Timestamp }).nullable(),
  /** Only for sites on craftish. */
  wholeSite: WholeSiteBackups.nullable(),
  /** Whether "Back up now" applies: a site hosted on craftish. */
  canExport: z.boolean(),
  /** When this Kamaji started a "Back up now" still going, or null. */
  exporting: Timestamp.nullable(),
  /** The newest export, else the newest words a run recorded. */
  latest: BackupEntry.nullable(),
  /** Newest first. */
  history: z.array(BackupEntry),
});
export type SiteBackupsResponse = z.infer<typeof SiteBackupsResponse>;
