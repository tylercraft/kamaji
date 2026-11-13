// A craftish site's whole-site backups, inside its Backups panel's subsection: the schedule and consent, the
// snapshots and restore checks the backups process recorded, the repository's size, and asking
// for a backup or a restore check now. The app never runs restic; it asks the backups process.
import type { SiteSnapshot, WholeSiteBackups as Data } from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { size } from '../bytes';
import { FormError } from '../components/forms';
import { failed, reason, saved } from '../components/toast';
import { Button, Dot, Muted, Pill, Table, Time } from '../components/ui';
import { SCHEDULES } from './SiteSetup';

const WORDS: Record<string, string> = {
  not_active: 'whole-site backups are off for this site: turn them on under Configure',
  already_requested: 'it’s already asked for',
};

/** The night the next backup runs: the first 03:15 on or after it's due. */
function nextNight(iso: string): string {
  const due = new Date(iso);
  const night = new Date(due);
  night.setHours(3, 15, 0, 0);
  if (night < due) night.setDate(night.getDate() + 1);
  return night.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function Status({ data, now }: { data: Data; now: number }) {
  if (data.schedule === 'off') {
    return null;
  }
  return (
    <p css={{ margin: 0 }}>
      {SCHEDULES[data.schedule]}.{' '}
      {data.lastGoodAt ? (
        <>
          Last good backup <Time iso={data.lastGoodAt} />
          {data.nextDueAt &&
            (Date.parse(data.nextDueAt) < now ? (
              <>; it was due on {nextNight(data.nextDueAt)}, and each night at 03:15 tries again</>
            ) : (
              <>; the next one on {nextNight(data.nextDueAt)}, at 03:15</>
            ))}
          .
        </>
      ) : (
        'None yet: the first one is tonight at 03:15, or ask for one now.'
      )}{' '}
      {data.own ? (
        'Tyler’s own site.'
      ) : data.consentAt ? (
        <>
          The client agreed (ticked by {data.consentBy} <Time iso={data.consentAt} />
          ).
        </>
      ) : null}
    </p>
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

  return (
    <>
      <Status data={data} now={now} />
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
      {(data.snapshots.length > 0 || data.repository) && (
        <details>
          <summary>Snapshots and storage ({data.snapshots.length})</summary>
          <div css={{ display: 'grid', gap: 8, marginTop: 6 }}>
            {data.snapshots.length > 0 && <Snapshots snapshots={data.snapshots} />}
            {data.repository && (
              <Muted>
                All sites’ backups take {size(data.repository.bytes)} on molcajete (measured{' '}
                <Time iso={data.repository.at} />
                ).
              </Muted>
            )}
          </div>
        </details>
      )}
    </>
  );
}
