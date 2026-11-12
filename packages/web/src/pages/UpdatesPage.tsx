// Updates: the queue, the review that is the approval, and the batches' results (calcifer
// explore/kamaji.md, "Selecting and approving a batch"). Ticking decides nothing; the button
// names the exact scope, and the approval is bound to it.
import {
  ApproveResponse,
  UpdatesResponse,
  type BackupKind,
  type BatchSiteView,
  type BatchView,
  type Outcome,
  type QueueItem,
} from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { FormError, PrimaryButton } from '../components/forms';
import {
  Button,
  Dot,
  Empty,
  Muted,
  PageHeading,
  Panel,
  PanelTitle,
  Pill,
  ResourceView,
  Table,
  Time,
  type Tone,
} from '../components/ui';
import { useResource } from '../useResource';
import { bySite, byUpdate, itemKey as key, needsBackup, type Grouping } from '../updatesView';

const BACKUP_WORDS: Record<BackupKind, string> = {
  kamaji: 'Kamaji exports the database on craftish first',
  host: 'The host’s own backups',
  client: 'The client handles backups',
  tyler: 'Your word that there’s a backup',
};

const OUTCOMES: Record<Outcome, [string, Tone]> = {
  passed: ['Updated, checks passed', 'green'],
  checks_failed: ['Updated, checks failed', 'red'],
  update_failed: ['Update failed', 'red'],
  incomplete: ['Couldn’t verify', 'amber'],
};

const STATE_WORDS = {
  waiting: 'Waiting',
  sent: 'Sending',
  running: 'Running',
  checking: 'Checking',
  done: 'Done',
  held: 'Held',
} as const;

function Flags({ item }: { item: QueueItem }) {
  return (
    <>
      {item.security && (
        <Pill tone="red">
          <Dot /> Security fix
        </Pill>
      )}{' '}
      {item.major && (
        <Pill tone="amber">
          <Dot /> Major
        </Pill>
      )}
    </>
  );
}

/** One row per site, with a box to tick all of that site's updates at once. */
function SiteRows({
  items,
  ticked,
  toggle,
  tickAll,
}: {
  items: QueueItem[];
  ticked: Set<string>;
  toggle: (k: string) => void;
  tickAll: (items: QueueItem[], on: boolean) => void;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <th scope="col">Site</th>
          <th scope="col">Updates</th>
        </tr>
      </thead>
      <tbody>
        {bySite(items).map((g) => {
          const first = g[0]!;
          const all = g.every((i) => ticked.has(key(i)));
          return (
            <tr key={first.siteId}>
              <td>
                <label css={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={all} onChange={() => tickAll(g, !all)} />
                  <strong>{first.siteName}</strong>
                </label>
                <Muted>
                  All {g.length} {g.length === 1 ? 'update' : 'updates'}
                </Muted>
              </td>
              <td>
                <div css={{ display: 'grid', gap: 4 }}>
                  {g.map((i) => (
                    <label key={key(i)} css={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={ticked.has(key(i))}
                        onChange={() => toggle(key(i))}
                      />
                      <span>
                        {i.name} {i.from} → {i.to} <Flags item={i} />
                      </span>
                    </label>
                  ))}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function Queue({
  data,
  ticked,
  setTicked,
}: {
  data: UpdatesResponse;
  ticked: Set<string>;
  setTicked: (next: Set<string>) => void;
}) {
  const toggle = (k: string) => {
    const next = new Set(ticked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setTicked(next);
  };
  const tickAll = (items: QueueItem[], on: boolean) => {
    const next = new Set(ticked);
    for (const i of items) {
      if (on) next.add(key(i));
      else next.delete(key(i));
    }
    setTicked(next);
  };
  const [grouping, setGrouping] = useState<Grouping>('update');
  const routine = data.items.filter((i) => !i.major);
  return (
    <Panel aria-labelledby="queue">
      <PanelTitle id="queue">Waiting</PanelTitle>
      {data.items.length === 0 ? (
        <Muted>
          {data.unknown > 0
            ? `Nothing to update that Kamaji knows of; ${data.unknown} connected ${data.unknown === 1 ? 'site hasn’t' : 'sites haven’t'} reported yet, so that isn’t the same as nothing.`
            : 'Nothing WordPress offers on the sites Kamaji can update.'}
        </Muted>
      ) : (
        <>
          <div css={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button type="button" onClick={() => setTicked(new Set(routine.map(key)))}>
              Tick all routine ({routine.length})
            </Button>
            <Button type="button" onClick={() => setTicked(new Set())}>
              Clear
            </Button>
            <Muted>Major versions are never routine. Security fixes come first.</Muted>
          </div>
          <div role="group" aria-label="Group by" css={{ display: 'flex', gap: 6 }}>
            {(
              [
                ['update', 'By update'],
                ['site', 'By site'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                aria-pressed={grouping === value}
                onClick={() => setGrouping(value)}
                css={
                  grouping === value
                    ? { borderColor: 'var(--copper)', color: 'var(--copper)' }
                    : undefined
                }
              >
                {label}
              </Button>
            ))}
          </div>
          <div css={{ overflowX: 'auto' }}>
            {grouping === 'site' ? (
              <SiteRows items={data.items} ticked={ticked} toggle={toggle} tickAll={tickAll} />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th scope="col">Update</th>
                    <th scope="col">Sites</th>
                  </tr>
                </thead>
                <tbody>
                  {byUpdate(data.items).map((g) => {
                    const first = g[0]!;
                    return (
                      <tr key={key(first) + first.to}>
                        <td>
                          {first.name} {first.from} → {first.to} <Flags item={first} />
                          <Muted>{first.type === 'core' ? 'WordPress' : first.item}</Muted>
                        </td>
                        <td>
                          <div css={{ display: 'grid', gap: 4 }}>
                            {g.map((i) => (
                              <label
                                key={key(i)}
                                css={{ display: 'flex', gap: 6, alignItems: 'center' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={ticked.has(key(i))}
                                  onChange={() => toggle(key(i))}
                                />
                                {i.siteName}
                              </label>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </div>
        </>
      )}
      {data.sites.some((s) => s.blocked) && (
        <div css={{ display: 'grid', gap: 4 }}>
          {data.sites
            .filter((s) => s.blocked)
            .map((s) => (
              <Muted key={s.siteId}>
                {s.siteName}: {s.blocked}
              </Muted>
            ))}
        </div>
      )}
    </Panel>
  );
}

function Review({
  data,
  ticked,
  done,
}: {
  data: UpdatesResponse;
  ticked: Set<string>;
  done: () => void;
}) {
  const chosen = data.items.filter((i) => ticked.has(key(i)));
  const siteIds = [...new Set(chosen.map((i) => i.siteId))];
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [oneFirst, setOneFirst] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oneSiteFirst = oneFirst ?? siteIds.length >= 3;
  if (chosen.length === 0) return null;
  const site = (id: string) => data.sites.find((s) => s.siteId === id)!;
  const waitingOn = needsBackup(siteIds, data.sites, confirmed);

  async function approve() {
    setBusy(true);
    setError(null);
    const result = await postJson(
      '/api/batches',
      {
        items: chosen.map(({ siteId, type, item, from, to }) => ({ siteId, type, item, from, to })),
        confirmedBackups: [...confirmed],
        oneSiteFirst,
      },
      ApproveResponse,
    );
    setBusy(false);
    if (!result.ok) {
      setError('Kamaji couldn’t store the approval. Nothing was started.');
      return;
    }
    if (!result.data.ok) {
      // A backup still to confirm keeps the ticks, so it can be confirmed here; changed versions
      // reload the queue.
      if (result.data.changed.length === 0 && result.data.needsBackup.length > 0) {
        setError('Confirm the backup for each site that needs it. Nothing was started.');
        return;
      }
      setError(
        'Some versions changed since this page loaded. Nothing was started; check the queue again.',
      );
      done();
      return;
    }
    done();
  }

  return (
    <Panel aria-labelledby="review">
      <PanelTitle id="review">Review</PanelTitle>
      {siteIds.map((id) => {
        const s = site(id);
        const items = chosen.filter((i) => i.siteId === id);
        return (
          <div key={id} css={{ display: 'grid', gap: 4 }}>
            <strong>{s.siteName}</strong>
            {items.map((i) => (
              <span key={key(i)}>
                {i.name} {i.from} → {i.to}
              </span>
            ))}
            <Muted>Backup: {BACKUP_WORDS[s.backupKind]}</Muted>
            {s.backupKind === 'tyler' && (
              <label css={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={confirmed.has(id)}
                  onChange={() => {
                    const next = new Set(confirmed);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setConfirmed(next);
                  }}
                />
                I confirm there’s a backup of {s.siteName}
              </label>
            )}
          </div>
        );
      })}
      {siteIds.length > 1 && (
        <label css={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={oneSiteFirst}
            onChange={() => setOneFirst(!oneSiteFirst)}
          />
          One site first: the rest run only if it passes
        </label>
      )}
      <Muted>
        Kamaji refreshes these sites first, checks each one before and after every update, and holds
        the rest on a site at the first problem.
      </Muted>
      {waitingOn.length > 0 && (
        <Muted id="approve-waits" role="status" css={{ color: 'var(--amber)' }}>
          Approve waits for the backup: tick “I confirm there’s a backup” for{' '}
          {waitingOn.map((s) => s.siteName).join(', ')}, or set its backup under Configure on the
          site’s page.
        </Muted>
      )}
      <PrimaryButton
        type="button"
        disabled={busy || waitingOn.length > 0}
        aria-describedby={waitingOn.length > 0 ? 'approve-waits' : undefined}
        onClick={approve}
        css={{ justifySelf: 'start' }}
      >
        {busy
          ? 'Checking the sites…'
          : `Approve and run ${chosen.length} ${chosen.length === 1 ? 'update' : 'updates'} on ${siteIds.length} ${siteIds.length === 1 ? 'site' : 'sites'}`}
      </PrimaryButton>
      {error && <FormError>{error}</FormError>}
    </Panel>
  );
}

function HeldActions({
  batch,
  site,
  reload,
}: {
  batch: BatchView;
  site: BatchSiteView;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const call = async (action: 'recheck' | 'carry-on') => {
    setBusy(true);
    const result = await postJson(
      `/api/batches/${batch.id}/sites/${encodeURIComponent(site.siteId)}/${action}`,
      {},
      z.object({ ok: z.boolean(), problem: z.string().nullable().optional() }),
    );
    setBusy(false);
    if (action === 'recheck') {
      setSaid(
        result.ok
          ? result.data.ok
            ? 'The home page passes now.'
            : `Still failing: ${result.data.problem ?? 'the check failed'}`
          : 'The re-check couldn’t run.',
      );
    }
    reload();
  };
  return (
    <div css={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <Button type="button" disabled={busy} onClick={() => call('recheck')}>
        Re-run the checks
      </Button>
      <Button type="button" disabled={busy} onClick={() => call('carry-on')}>
        I’ve looked, carry on
      </Button>
      {said && <Muted>{said}</Muted>}
    </div>
  );
}

function Batches({ batches, reload }: { batches: BatchView[]; reload: () => void }) {
  if (batches.length === 0) return null;
  return (
    <Panel aria-labelledby="batches">
      <PanelTitle id="batches">Runs</PanelTitle>
      {batches.map((b) => (
        <div key={b.id} css={{ display: 'grid', gap: 10 }}>
          <Muted>
            Approved <Time iso={b.approvedAt} /> ·{' '}
            {b.state === 'finished' ? 'Finished' : b.state === 'running' ? 'Running' : 'Starting'}
          </Muted>
          {b.sites.map((s) => (
            <div key={s.siteId} css={{ display: 'grid', gap: 6 }}>
              <strong>
                {s.siteName}{' '}
                <Pill tone={s.state === 'held' ? 'red' : s.state === 'done' ? 'green' : 'neutral'}>
                  <Dot /> {STATE_WORDS[s.state]}
                </Pill>
              </strong>
              {s.backup && <Muted>Backup: {s.backup}</Muted>}
              {s.heldReason && <p css={{ margin: 0, color: 'var(--red)' }}>{s.heldReason}</p>}
              <div css={{ overflowX: 'auto' }}>
                <Table>
                  <tbody>
                    {s.items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.name} {i.from} → {i.to}
                        </td>
                        <td>
                          {i.outcome ? (
                            <Pill tone={OUTCOMES[i.outcome][1]}>
                              <Dot /> {OUTCOMES[i.outcome][0]}
                            </Pill>
                          ) : (
                            <Muted>{STATE_WORDS[i.state]}</Muted>
                          )}
                          {i.detail && <Muted>{i.detail}</Muted>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {s.state === 'held' && <HeldActions batch={b} site={s} reload={reload} />}
            </div>
          ))}
        </div>
      ))}
    </Panel>
  );
}

export function UpdatesPage() {
  const updates = useResource('/api/updates', UpdatesResponse, { pollMs: 5_000 });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  return (
    <>
      <PageHeading
        title="Updates"
        purpose="Review changes and their evidence, then approve maintenance."
      />
      <ResourceView resource={updates} label="updates">
        {(data) => {
          const reload = updates.state === 'ready' ? updates.reload : () => {};
          if (data.items.length === 0 && data.batches.length === 0 && data.sites.length === 0) {
            return (
              <Panel>
                <Empty title="No site can be updated yet">
                  Updates come from what a site running Craftish Care {'0.2.0'} reports. Until one
                  does, what’s waiting is unknown, which isn’t the same as nothing.
                </Empty>
              </Panel>
            );
          }
          return (
            <>
              <Queue data={data} ticked={ticked} setTicked={setTicked} />
              <Review
                data={data}
                ticked={ticked}
                done={() => {
                  setTicked(new Set());
                  reload();
                }}
              />
              <Batches batches={data.batches} reload={reload} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
