// A craftish site's whole-site backups, inside its Backups card: the latest attempt, the last
// good backup, the latest restore check and the next run, then asking for either now. Schedule,
// consent, retention, storage and the snapshot list are one click down. The app never runs
// restic; it asks the backups process.
import type { SiteSnapshot, WholeSiteBackups as Data } from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { size } from '../bytes';
import { FormError } from '../components/forms';
import { failed, reason, saved } from '../components/toast';
import { Button, Dot, Muted, Pill, Table, Time } from '../components/ui';
import { Rows } from '../components/rows';
import { CURRENT_FOR, isOutOfDate, OVERDUE_GRACE, SCHEDULE_DAYS, STEP_WORDS } from '../siteStatus';
import { SCHEDULES } from './SiteSetup';

const WORDS: Record<string, string> = {
  not_active: 'whole-site backups are off for this site: turn them on under Configure',
  already_requested: 'it’s already asked for',
};

/** The night a backup due at this time runs: the first 03:15 on or after it. */
function nextNight(iso: string): string {
  const due = new Date(iso);
  const night = new Date(due);
  night.setHours(3, 15, 0, 0);
  if (night < due) night.setDate(night.getDate() + 1);
  return night.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

/** When the next nightly run takes this site, or since when it's been overdue. */
function NextRun({ data, now }: { data: Data; now: number }) {
  if (data.schedule === 'off') return null;
  if (!data.lastGoodAt || !data.nextDueAt) return <>Tonight at 03:15</>;
  const due = Date.parse(data.nextDueAt);
  if (due >= now) return <>{nextNight(data.nextDueAt)}, 03:15</>;
  const overdueAt =
    Date.parse(data.lastGoodAt) + SCHEDULE_DAYS[data.schedule] * 86_400_000 + OVERDUE_GRACE;
  return now > overdueAt ? (
    <>
      <Pill tone="amber">
        <Dot /> Overdue
      </Pill>
      since {day(overdueAt)}; each night at 03:15 tries again
    </>
  ) : (
    <>Due since {nextNight(data.nextDueAt)}; each night at 03:15 tries again</>
  );
}

function Snapshots({ snapshots }: { snapshots: SiteSnapshot[] }) {
  return (
    <div css={{ overflowX: 'auto' }}>
      <Table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Result</th>
            <th scope="col">Size</th>
            <th scope="col">New</th>
            <th scope="col">Database</th>
            <th scope="col">WordPress</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s, i) => (
            <tr key={`${s.startedAt}-${i}`}>
              <td>
                <Time iso={s.startedAt} />
              </td>
              <td>
                {s.ok ? (
                  <Pill tone={s.forgotten ? 'neutral' : 'green'}>
                    <Dot /> {s.forgotten ? 'Let go' : 'Kept'}
                  </Pill>
                ) : (
                  <>
                    <Pill tone="red">
                      <Dot /> Failed
                    </Pill>
                    <Muted>{s.problem}</Muted>
                  </>
                )}
              </td>
              <td>{s.bytes === null ? '–' : size(s.bytes)}</td>
              <td>{s.addedBytes === null ? '–' : size(s.addedBytes)}</td>
              <td>{s.databaseBytes === null ? '–' : size(s.databaseBytes)}</td>
              <td>{s.wordpress ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

export function WholeSiteBackups({
  path,
  data,
  now,
  reload,
}: {
  path: string;
  data: Data;
  /** When the data loaded: a due date before it is past. */
  now: number;
  reload: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<'backup' | 'restore' | null>(null);
  const hasSnapshot = data.snapshots.some((s) => s.ok && !s.forgotten);

  async function ask(kind: 'backup' | 'restore') {
    setAsking(kind);
    setProblem(null);
    const result = await postJson(
      `${path}/whole-site`,
      { kind },
      z.object({ queued: z.literal(true) }),
    );
    setAsking(null);
    if (!result.ok) {
      const why = WORDS[result.error] ?? reason(result.error);
      setProblem(`Not asked: ${why}.`);
      failed(`Not asked: ${why}.`);
      return;
    }
    saved(
      kind === 'backup'
        ? 'Backup asked for: it can take a while, and shows here when done'
        : 'Restore check asked for: it can take a few minutes',
    );
    reload();
  }

  const latest = data.snapshots[0];
  const check = data.restoreChecks[0];
  const checkOld = check ? isOutOfDate(check.startedAt, CURRENT_FOR.restoreCheck, now) : false;
  const lastGood = data.snapshots.find((x) => x.ok);
  return (
    <>
      <Rows>
        {latest && !latest.ok ? (
          <>
            <dt>Latest attempt</dt>
            <dd>
              <Pill tone="red">
                <Dot /> Failed
              </Pill>
              <Time iso={latest.startedAt} />
              {latest.problem && <span className="why">{latest.problem}</span>}
            </dd>
            <dt>Last successful</dt>
            <dd>{data.lastGoodAt ? <Time iso={data.lastGoodAt} /> : 'None yet'}</dd>
          </>
        ) : (
          <>
            <dt>Last backup</dt>
            <dd>
              {data.lastGoodAt ? (
                <>
                  <Pill tone="green">
                    <Dot /> Backed up
                  </Pill>
                  <Time iso={data.lastGoodAt} />
                  {lastGood?.bytes != null && <span>{size(lastGood.bytes)}</span>}
                </>
              ) : (
                'None yet'
              )}
            </dd>
          </>
        )}
        <dt>Restore check</dt>
        <dd>
          {!check ? (
            'Not run yet'
          ) : check.ok ? (
            <>
              <Pill tone={checkOld ? 'neutral' : 'green'}>
                <Dot /> {checkOld ? 'Passed, out of date' : 'Passed'}
              </Pill>
              <Time iso={check.startedAt} />
              <span>{check.seconds} s</span>
            </>
          ) : (
            <>
              <Pill tone="red">
                <Dot /> Failed
              </Pill>
              <Time iso={check.startedAt} />
              <span className="why">
                While{' '}
                {STEP_WORDS[check.failedStep ?? ''] ?? check.failedStep ?? 'at an unknown step'}:{' '}
                {check.problem}
              </span>
            </>
          )}
        </dd>
        <dt>Next run</dt>
        <dd>
          <NextRun data={data} now={now} />
        </dd>
      </Rows>
      {data.active && (
        <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            type="button"
            disabled={asking !== null || data.pending.backup !== null}
            onClick={() => void ask('backup')}
          >
            {data.pending.backup ? 'Backing up…' : 'Back up site now'}
          </Button>
          <Button
            type="button"
            disabled={asking !== null || data.pending.restore !== null || !hasSnapshot}
            onClick={() => void ask('restore')}
          >
            {data.pending.restore ? 'Checking…' : 'Check restore now'}
          </Button>
          <Muted role="status">
            {data.pending.backup || data.pending.restore ? (
              <>
                Asked <Time iso={(data.pending.backup ?? data.pending.restore)!} />; the backups
                process works on it now.
              </>
            ) : null}
          </Muted>
        </div>
      )}
      {problem && <FormError>{problem}</FormError>}
      <details>
        <summary>Snapshots, storage and consent ({data.snapshots.length})</summary>
        <div css={{ display: 'grid', gap: 10, marginTop: 8 }}>
          <Rows>
            <dt>Schedule</dt>
            <dd>{SCHEDULES[data.schedule]}, nightly at 03:15 when due</dd>
            <dt>Agreement</dt>
            <dd>
              {data.own ? (
                'Tyler’s own site: no client to ask'
              ) : data.consentAt ? (
                <>
                  The client agreed: ticked by {data.consentBy} <Time iso={data.consentAt} />
                </>
              ) : (
                'Not recorded'
              )}
            </dd>
            <dt>Kept</dt>
            <dd>4 weekly and 6 monthly snapshots</dd>
            <dt>Where</dt>
            <dd>
              Encrypted with restic on molcajete. Arq copies that repository off-site; Kamaji
              doesn’t check Arq.
            </dd>
            {data.repository && (
              <>
                <dt>Repository</dt>
                <dd>
                  {size(data.repository.bytes)} for all sites, measured{' '}
                  <Time iso={data.repository.at} />
                </dd>
              </>
            )}
          </Rows>
          {data.snapshots.length > 0 && <Snapshots snapshots={data.snapshots} />}
        </div>
      </details>
    </>
  );
}
