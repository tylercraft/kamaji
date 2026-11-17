// "Ready to update", at the top of Overview from the update time until the next (server ready.ts,
// liveReady): worked out on each load, each site's backup as it stands and the updates still
// waiting, majors marked, with a failed backup first and the advice to fix it before updating. A
// site with nothing left drops off; one updated since says when.
import type { ReadyBackup, ReadySite, ReadyToUpdate as Data } from '@kamaji/shared';
import { Dot, Muted, Panel, PanelHead, Pill, Time } from '../components/ui';
import { WithIcon } from '../components/SiteIcon';
import { useLink } from '../router';

export function backupLine(b: ReadyBackup): { tone: 'green' | 'red' | 'neutral'; words: string } {
  switch (b.state) {
    case 'fresh':
      return { tone: 'green', words: b.restoredAt ? 'Backed up and restore-checked' : 'Backed up' };
    case 'failed':
      return {
        tone: 'red',
        words:
          b.step === 'restore'
            ? `Backed up, but the restore check failed ${b.problem}. Fix it before updating.`
            : `Backup failed: ${b.problem}. Fix it before updating.`,
      };
    case 'host':
      return { tone: 'neutral', words: `${b.host}’s backups` };
    case 'export':
      return { tone: 'neutral', words: 'Pre-update export only' };
    case 'client':
      return { tone: 'neutral', words: 'The client’s backups' };
    case 'tyler':
      return { tone: 'neutral', words: 'Your own backup, confirmed when you approve' };
    case 'unknown':
      return { tone: 'neutral', words: 'Backups not decided: set them under Configure' };
  }
}

function SiteRow({ site }: { site: ReadySite }) {
  const link = useLink(`/sites/${site.siteId}`);
  const backup = backupLine(site.backup);
  return (
    <li css={{ display: 'grid', gap: 4, padding: '8px 0', borderTop: '1px solid var(--line)' }}>
      <div css={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <WithIcon id={site.siteId}>
          <a {...link} css={{ color: 'inherit', fontWeight: 600 }}>
            {site.siteName}
          </a>
        </WithIcon>
        <Pill tone={backup.tone}>
          <Dot /> {backup.words}
          {site.backup.state === 'fresh' && (
            <>
              {' '}
              <Time iso={site.backup.at} />
            </>
          )}
        </Pill>
        {site.updatedAt && (
          <Pill tone="green">
            <Dot /> Updated <Time iso={site.updatedAt} />
          </Pill>
        )}
      </div>
      {site.note && <Muted>{site.note}</Muted>}
      {site.updates.length === 0 ? (
        <Muted>{site.updatedAt ? 'Nothing left waiting.' : 'Nothing waiting.'}</Muted>
      ) : (
        <ul css={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {site.updates.map((u) => (
            <li key={`${u.name}-${u.to}`}>
              {u.name} {u.from} → {u.to}
              {u.major && (
                <>
                  {' '}
                  <Pill tone="amber">Major</Pill>
                </>
              )}
              {u.security && (
                <>
                  {' '}
                  <Pill tone="red">Security</Pill>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ReadyToUpdate({ ready }: { ready: Data }) {
  const updates = useLink('/updates');
  const failedSites = ready.sites.filter((s) => s.backup.state === 'failed');
  const failed = failedSites.length;
  const restores = failedSites.filter(
    (s) => s.backup.state === 'failed' && s.backup.step === 'restore',
  ).length;
  const what =
    restores === failed
      ? failed === 1
        ? 'A restore check'
        : `${failed} restore checks`
      : restores === 0
        ? failed === 1
          ? 'A whole-site backup'
          : `${failed} whole-site backups`
        : `${failed} backups or restore checks`;
  const waiting = ready.sites.reduce((n, s) => n + s.updates.length, 0);
  return (
    <Panel aria-labelledby="ready" css={failed > 0 ? { borderColor: 'var(--red)' } : undefined}>
      <PanelHead id="ready" title="Ready to update">
        <a {...updates}>Go to Updates</a>
      </PanelHead>
      <p css={{ margin: '4px 0 6px' }}>
        {failed > 0 ? (
          <strong>
            {what} failed: fix {failed === 1 ? 'it' : 'them'} before updating.{' '}
          </strong>
        ) : null}
        {waiting} update{waiting === 1 ? '' : 's'} waiting, rechecked <Time iso={ready.sentAt} />.
        Nothing is approved until you approve it.
      </p>
      <ul css={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {ready.sites.map((s) => (
          <SiteRow key={s.siteId} site={s} />
        ))}
      </ul>
    </Panel>
  );
}
