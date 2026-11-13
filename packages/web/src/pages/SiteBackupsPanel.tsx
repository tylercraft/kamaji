// A site's Backups card, as Kamaji recorded them (backups/evidence.ts on the server), in two
// parts that are never mistaken for each other:
//   - before-update backups: the database export Kamaji makes on craftish ("Export database
//     now", and before each run), or the host's, client's or Tyler's backup, which Kamaji records
//     but never sees;
//   - scheduled whole-site backups (files and database, restic on molcajete) and their restore
//     checks.
// Each part's state sits beside its heading; checksums and history are one click down.
import { SiteBackupsResponse, type BackupEntry } from '@kamaji/shared';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { getJson, postJson } from '../api';
import { size } from '../bytes';
import { FormError } from '../components/forms';
import { failed, reason, saved } from '../components/toast';
import {
  Button,
  Dot,
  Muted,
  Panel,
  PanelTitle,
  Pill,
  ResourceView,
  Table,
  Time,
  type Tone,
} from '../components/ui';
import { backups as backupLines, type StatusLine } from '../siteStatus';
import type { Resource } from '../useResource';
import { WholeSiteBackups } from './WholeSiteBackups';

const WORDS: Record<string, string> = {
  not_craftish: 'Kamaji exports only on craftish, and this site isn’t hosted there',
  not_set_up: 'This Kamaji has no export set up: see “craftish’s database export” in ops/README.md',
  already_exporting: 'An export is already going',
  no_export: 'There’s no export to download yet: Back up now makes one',
  export_unavailable: 'craftish didn’t send it',
  updating: 'The updater is running this site; its run makes its own export first',
};

const STATE: Record<BackupEntry['state'], [string, Tone]> = {
  exported: ['Exported by Kamaji', 'green'],
  failed: ['Export failed', 'red'],
  recorded: ['Confirmed, not checked', 'neutral'],
};

function Run({ entry }: { entry: BackupEntry }) {
  if (entry.runApprovedAt === null) return <>Back up now</>;
  return (
    <>
      The run approved <Time iso={entry.runApprovedAt} />
    </>
  );
}

/** A part of the card: its heading with its state flag beside it, the state's words, then the rest. */
function Part({
  id,
  title,
  lines,
  children,
}: {
  id: string;
  title: string;
  lines: StatusLine[];
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      css={{
        display: 'grid',
        gap: 8,
        borderTop: '1px solid var(--line)',
        paddingTop: 12,
        '&:first-of-type': { borderTop: 0, paddingTop: 0 },
      }}
    >
      <h3 id={id} css={{ margin: 0, fontSize: 13 }}>
        {title}
      </h3>
      {lines.map((l) => (
        <div key={l.label} css={{ display: 'grid', gap: 2, justifyItems: 'start' }}>
          <span css={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {lines.length > 1 && <span css={{ fontSize: 12 }}>{l.label}</span>}
            <Pill tone={l.tone}>
              <Dot /> {l.state}
            </Pill>
            {l.at && (
              <Muted css={{ display: 'inline' }}>
                <Time iso={l.at} />
                {l.outOfDate && <span css={{ color: 'var(--amber)' }}> · out of date</span>}
              </Muted>
            )}
          </span>
          <Muted>{l.detail}</Muted>
        </div>
      ))}
      {children}
    </section>
  );
}

/** Opens Configure, further down the page, and moves there. */
export function ConfigureLink({ children }: { children: ReactNode }) {
  return (
    <a
      href="#configure"
      onClick={(event) => {
        const target = document.getElementById('configure');
        if (!(target instanceof HTMLDetailsElement)) return;
        event.preventDefault();
        target.open = true;
        target.scrollIntoView({ block: 'start' });
        target.querySelector('summary')?.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}

const factsCss = {
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'max-content minmax(0, 1fr)',
  gap: '4px 16px',
  fontSize: 12,
  dt: { color: 'var(--muted)' },
  dd: { margin: 0 },
} as const;

/** The newest good export: when, how big, what for, and its checksum. */
function LatestExport({ entry }: { entry: BackupEntry | undefined }) {
  if (!entry) return <Muted>No export yet.</Muted>;
  return (
    <>
      <dl css={factsCss}>
        <dt>Exported</dt>
        <dd>
          <Time iso={entry.exportedAt ?? entry.recordedAt} />
        </dd>
        {entry.bytes !== null && (
          <>
            <dt>Size</dt>
            <dd>{size(entry.bytes)}</dd>
          </>
        )}
        <dt>For</dt>
        <dd>
          <Run entry={entry} />
        </dd>
      </dl>
      {entry.sha256 && (
        <dl css={factsCss}>
          <dt>SHA-256</dt>
          <dd css={{ overflowWrap: 'anywhere' }}>
            <code>{entry.sha256}</code>
          </dd>
          <dt>Recorded</dt>
          <dd>
            <Time iso={entry.recordedAt} />
          </dd>
        </dl>
      )}
    </>
  );
}

function History({ history }: { history: BackupEntry[] }) {
  return (
    <details>
      <summary>Backup history ({history.length})</summary>
      <div css={{ overflowX: 'auto' }}>
        <Table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Size</th>
              <th scope="col">SHA-256</th>
              <th scope="col">For</th>
            </tr>
          </thead>
          <tbody>
            {history.map((e, i) => (
              <tr key={`${e.recordedAt}-${i}`}>
                <td>
                  <Time iso={e.recordedAt} />
                </td>
                <td>
                  <Pill tone={STATE[e.state][1]}>
                    <Dot /> {STATE[e.state][0]}
                  </Pill>
                  {e.state !== 'exported' && <Muted>{e.words}</Muted>}
                </td>
                <td>{e.bytes === null ? '–' : size(e.bytes)}</td>
                <td>{e.sha256 ? <code title={e.sha256}>{e.sha256.slice(0, 12)}…</code> : '–'}</td>
                <td>
                  <Run entry={e} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </details>
  );
}

export function SiteBackupsPanel({
  siteId,
  backups,
}: {
  siteId: string;
  backups: Resource<SiteBackupsResponse>;
}) {
  const path = `/api/sites/${encodeURIComponent(siteId)}/backups`;
  const [downloading, setDownloading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = () => {
    if (backups.state === 'ready') backups.reload();
  };

  /** Starts the export, then asks every few seconds until it's done, and says how it went. */
  async function backUpNow() {
    setBusy(true);
    setProblem(null);
    const result = await postJson(path, {}, z.object({ started: z.literal(true) }));
    if (!result.ok) {
      setBusy(false);
      const why = WORDS[result.error] ?? reason(result.error);
      setProblem(`Not started: ${why}.`);
      failed(`Not started: ${why}.`);
      return;
    }
    reload();
    let now: SiteBackupsResponse | null;
    do {
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      now = await getJson(path, SiteBackupsResponse).catch(() => null);
      if (now?.exporting !== null) reload();
    } while (!now || now.exporting !== null);
    setBusy(false);
    reload();
    const newest = now.history.find((e) => e.batchId === null);
    if (newest?.state === 'exported') {
      saved(`Backed up: ${newest.bytes === null ? 'exported' : size(newest.bytes)} on craftish`);
    } else {
      const why = newest?.words ?? 'the export didn’t record a result';
      setProblem(`The backup failed: ${why}.`);
      failed(`The backup failed: ${why}.`);
    }
  }

  /**
   * Fetched rather than linked, so craftish's refusal (a pruned export, say) shows here instead of
   * saving as a file. Exports are a site's gzipped database: small enough to hold in memory.
   */
  async function download() {
    setDownloading(true);
    setProblem(null);
    const response = await fetch(`${path}/download`).catch(() => null);
    if (!response?.ok) {
      setDownloading(false);
      const body: unknown = await response?.json().catch(() => null);
      const { error, problem: why } = (body ?? {}) as { error?: string; problem?: string };
      const words = response
        ? `${WORDS[error ?? ''] ?? reason(error ?? `http_${response.status}`)}${why ? `: ${why}` : ''}`
        : 'Kamaji couldn’t be reached';
      setProblem(`Not downloaded: ${words}.`);
      failed(`Not downloaded: ${words}.`);
      return;
    }
    const blob = await response.blob();
    const name =
      /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
      `${siteId}.sql.gz`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setDownloading(false);
    saved(`Downloaded ${name} (${size(blob.size)})`);
  }

  return (
    <Panel aria-labelledby="backups-title" id="backups">
      <PanelTitle id="backups-title">Backups</PanelTitle>
      <ResourceView resource={backups} label="this site’s backups">
        {(d) => {
          const exports = d.history.filter((e) => e.state !== 'recorded');
          const lines = backupLines(d, backups.state === 'ready' ? backups.loadedAt : 0);
          const pick = (...labels: string[]) => lines.filter((l) => labels.includes(l.label));
          const kamaji = d.canExport || exports.length > 0;
          const latest = exports.find((e) => e.state === 'exported');
          return (
            <>
              {problem && <FormError>{problem}</FormError>}
              <Part
                id="before-update"
                title={
                  d.backupExpectation === 'kamaji'
                    ? 'Before-update database exports'
                    : 'Before-update backups'
                }
                lines={pick('Backups', 'Database export')}
              >
                {d.backupExpectation === null && (
                  <Muted>
                    <ConfigureLink>Choose how this site is backed up</ConfigureLink>
                  </Muted>
                )}
                {kamaji && (
                  <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {d.canExport && (
                      <Button
                        type="button"
                        disabled={busy || d.exporting !== null}
                        onClick={backUpNow}
                      >
                        {d.exporting || busy ? 'Exporting…' : 'Export database now'}
                      </Button>
                    )}
                    {d.download && (
                      <Button type="button" disabled={downloading} onClick={() => void download()}>
                        {downloading ? 'Downloading…' : 'Download latest database export'}
                      </Button>
                    )}
                    {d.exporting && (
                      <Muted role="status">
                        Started <Time iso={d.exporting} />; it can take a few minutes.
                      </Muted>
                    )}
                  </div>
                )}
                {d.history.length > 0 && (
                  <details>
                    <summary>
                      Backup history ({d.history.length}){latest?.sha256 ? ' and checksum' : ''}
                    </summary>
                    <div css={{ display: 'grid', gap: 10, marginTop: 8 }}>
                      {kamaji && <LatestExport entry={latest} />}
                      <History history={d.history} />
                    </div>
                  </details>
                )}
              </Part>
              {d.wholeSite && (
                <Part
                  id="whole-site"
                  title="Scheduled whole-site backups"
                  lines={pick('Whole-site backup', 'Restore check')}
                >
                  <Muted>
                    <ConfigureLink>
                      {d.wholeSite.schedule === 'off' ? 'Turn them on' : 'Configure backups'}
                    </ConfigureLink>
                  </Muted>
                  <WholeSiteBackups
                    path={path}
                    data={d.wholeSite}
                    now={backups.state === 'ready' ? backups.loadedAt : 0}
                    reload={reload}
                  />
                </Part>
              )}
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}
