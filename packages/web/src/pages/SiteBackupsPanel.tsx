// A site's Backups: its backup choice, the latest evidence and the history, as Kamaji recorded
// them (backups/evidence.ts on the server). On a craftish site, "Back up now" runs the export a
// run makes first, in the background; the panel asks again until it's done. "Download latest
// export" brings that export from craftish through Kamaji, and whole-site backups follow.
import { SiteBackupsResponse, type BackupEntry } from '@kamaji/shared';
import { useState } from 'react';
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
} from '../components/ui';
import { useResource } from '../useResource';
import { BACKUPS } from './SiteSetup';
import { WholeSiteBackups } from './WholeSiteBackups';

const WORDS: Record<string, string> = {
  not_craftish: 'Kamaji exports only on craftish, and this site isn’t hosted there',
  not_set_up: 'This Kamaji has no export set up: see “craftish’s database export” in ops/README.md',
  already_exporting: 'An export is already going',
  no_export: 'There’s no export to download yet: Back up now makes one',
  export_unavailable: 'craftish didn’t send it',
  updating: 'The updater is running this site; its run makes its own export first',
};

const STATE: Record<BackupEntry['state'], [string, 'green' | 'red' | 'neutral']> = {
  exported: ['Exported', 'green'],
  failed: ['Failed', 'red'],
  recorded: ['Recorded', 'neutral'],
};

function Run({ entry }: { entry: BackupEntry }) {
  if (entry.runApprovedAt === null) return <>Back up now</>;
  return (
    <>
      The run approved <Time iso={entry.runApprovedAt} />
    </>
  );
}

function Latest({ entry }: { entry: BackupEntry | null }) {
  if (!entry) return <Muted>No backup evidence recorded yet.</Muted>;
  return (
    <dl css={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
      <dt>Recorded</dt>
      <dd css={{ margin: 0 }}>
        <Time iso={entry.recordedAt} />
      </dd>
      {entry.exportedAt && (
        <>
          <dt>Exported</dt>
          <dd css={{ margin: 0 }}>
            <Time iso={entry.exportedAt} />
          </dd>
        </>
      )}
      {entry.bytes !== null && (
        <>
          <dt>Size</dt>
          <dd css={{ margin: 0 }}>{size(entry.bytes)}</dd>
        </>
      )}
      {entry.sha256 && (
        <>
          <dt>SHA-256</dt>
          <dd css={{ margin: 0, overflowWrap: 'anywhere' }}>
            <code>{entry.sha256}</code>
          </dd>
        </>
      )}
      <dt>For</dt>
      <dd css={{ margin: 0 }}>
        <Run entry={entry} />
      </dd>
      {entry.state === 'recorded' && (
        <>
          <dt>Words</dt>
          <dd css={{ margin: 0 }}>{entry.words}</dd>
        </>
      )}
    </dl>
  );
}

export function SiteBackupsPanel({ siteId }: { siteId: string }) {
  const path = `/api/sites/${encodeURIComponent(siteId)}/backups`;
  const backups = useResource(path, SiteBackupsResponse, { pollMs: 15_000 });
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
    <Panel aria-labelledby="backups">
      <PanelTitle id="backups">Backups</PanelTitle>
      <ResourceView resource={backups} label="this site’s backups">
        {(d) => (
          <>
            <p css={{ margin: 0 }}>
              {d.backupExpectation
                ? BACKUPS[d.backupExpectation]
                : 'Not set yet: choose it under Configure'}
            </p>
            <Latest entry={d.latest} />
            {d.canExport && (
              <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="button" disabled={busy || d.exporting !== null} onClick={backUpNow}>
                  {d.exporting || busy ? 'Exporting…' : 'Back up now'}
                </Button>
                <Muted role="status">
                  {d.exporting ? (
                    <>
                      Started <Time iso={d.exporting} />; it can take a few minutes.
                    </>
                  ) : (
                    'The same database export on craftish a run makes first.'
                  )}
                </Muted>
              </div>
            )}
            {d.download && (
              <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="button" disabled={downloading} onClick={() => void download()}>
                  {downloading ? 'Downloading…' : 'Download latest export'}
                </Button>
                <Muted>
                  Exported <Time iso={d.download.exportedAt} />. It comes from craftish, which keeps
                  exports 14 days; nothing is kept on the mini.
                </Muted>
              </div>
            )}
            {problem && <FormError>{problem}</FormError>}
            {d.history.length > 0 && (
              <details>
                <summary>History ({d.history.length})</summary>
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
                      {d.history.map((e, i) => (
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
                          <td>
                            {e.sha256 ? (
                              <code title={e.sha256}>{e.sha256.slice(0, 12)}…</code>
                            ) : (
                              '–'
                            )}
                          </td>
                          <td>
                            <Run entry={e} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </details>
            )}
            {d.wholeSite && <WholeSiteBackups path={path} data={d.wholeSite} reload={reload} />}
          </>
        )}
      </ResourceView>
    </Panel>
  );
}
