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
  type ProposalView,
  type QueueItem,
} from '@kamaji/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { FormError, PrimaryButton } from '../components/forms';
import { saved } from '../components/toast';
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
import { reveal, RevealLink } from '../components/reveal';
import { useLink } from '../router';
import {
  byComponent,
  bySite,
  runAnchor,
  runOutcome,
  siteRuns,
  updatesPollMs,
  type SiteRun,
} from '../runHistory';
import { useResource } from '../useResource';
import {
  bySite as queueBySite,
  byUpdate,
  itemKey as key,
  needsBackup,
  type Grouping,
} from '../updatesView';

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

export function Flags({ item }: { item: QueueItem }) {
  return (
    <>
      {item.security && (
        <Pill tone="red">
          <Dot />{' '}
          {item.fixes >= item.findings
            ? 'Security fix'
            : `Partial security fix: ${item.fixes} of ${item.findings}`}
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

/** A current proposal's notes, by item. */
interface Notes {
  by: string;
  byItem: Map<string, string>;
}

function proposalNotes(proposal: ProposalView | null): Notes {
  const byItem = new Map<string, string>();
  if (proposal && !proposal.stale)
    for (const i of proposal.items) if (i.note) byItem.set(key(i), i.note);
  return { by: proposal?.by ?? '', byItem };
}

/** A proposal's note on one item, under it. */
function Note({ notes, item }: { notes: Notes; item: QueueItem }) {
  const note = notes.byItem.get(key(item));
  if (!note) return null;
  return (
    <span css={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
      {notes.by}: {note}
    </span>
  );
}

/** The latest proposed batch: ticked below when it's current, a line when the queue has moved on. */
function ProposalLine({ proposal, data }: { proposal: ProposalView; data: UpdatesResponse }) {
  const n = proposal.items.length;
  const sites = new Set(proposal.items.map((i) => i.siteId)).size;
  if (proposal.stale)
    return (
      <Muted role="status">
        {proposal.by}’s proposal of <Time iso={proposal.createdAt} /> is out of date: the queue has
        changed since, so nothing of it is ticked. Ask for a new one.
      </Muted>
    );
  const first = data.sites.find((s) => s.siteId === proposal.firstSite)?.siteName;
  return (
    <p role="status" css={{ margin: 0 }}>
      <strong>
        {proposal.by} proposed {n} {n === 1 ? 'update' : 'updates'} on {sites}{' '}
        {sites === 1 ? 'site' : 'sites'}
      </strong>{' '}
      <Time iso={proposal.createdAt} />: ticked below with its notes
      {first ? `, ${first} first` : ''}. Nothing runs until you review and approve it.
    </p>
  );
}

/** One row per site, with a box to tick all of that site's updates at once. */
function SiteRows({
  items,
  ticked,
  toggle,
  tickAll,
  notes,
}: {
  items: QueueItem[];
  ticked: Set<string>;
  toggle: (k: string) => void;
  tickAll: (items: QueueItem[], on: boolean) => void;
  notes: Notes;
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
        {queueBySite(items).map((g) => {
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
                        <Note notes={notes} item={i} />
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
  reviewing,
  setReviewing,
}: {
  data: UpdatesResponse;
  ticked: Set<string>;
  setTicked: (next: Set<string>) => void;
  reviewing: boolean;
  setReviewing: (on: boolean) => void;
}) {
  const chosen = data.items.filter((i) => ticked.has(key(i))).length;
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
  const notes = proposalNotes(data.proposal);
  return (
    <Panel aria-labelledby="queue">
      <PanelTitle id="queue">To approve</PanelTitle>
      {data.proposal && <ProposalLine proposal={data.proposal} data={data} />}
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
              Select routine updates ({routine.length})
            </Button>
            <Button
              type="button"
              onClick={() => {
                setTicked(new Set());
                setReviewing(false);
              }}
            >
              Clear
            </Button>
            <Muted>
              Kamaji never updates a site on its own: each update runs only after you review and
              approve it here. Major versions are never routine; security fixes come first.
            </Muted>
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
              <SiteRows
                items={data.items}
                ticked={ticked}
                toggle={toggle}
                tickAll={tickAll}
                notes={notes}
              />
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
                                <span>
                                  {i.siteName}
                                  <Note notes={notes} item={i} />
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
            )}
          </div>
        </>
      )}
      {data.items.length > 0 && !reviewing && (
        <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <PrimaryButton
            type="button"
            disabled={chosen === 0}
            aria-describedby="queue-review-note"
            onClick={() => setReviewing(true)}
          >
            Review selected updates{chosen > 0 ? ` (${chosen})` : ''}
          </PrimaryButton>
          <Muted id="queue-review-note">
            {chosen === 0
              ? 'Select updates first. Nothing runs until you approve the review.'
              : 'Nothing runs until you approve the review.'}
          </Muted>
        </div>
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

/** The review, once asked for: the scope, each site's backup, and Approve. */
function Review(props: Parameters<typeof ReviewBody>[0] & { reviewing: boolean }) {
  const chosen = props.data.items.some((i) => props.ticked.has(key(i)));
  if (!chosen || !props.reviewing) return null;
  return (
    <Panel aria-labelledby="review">
      <PanelTitle id="review">Review</PanelTitle>
      <ReviewBody {...props} />
    </Panel>
  );
}

/**
 * The ticked updates by site, each site's backup, and Approve, bound to exactly that scope: here
 * and on a site's page. `runsAt` says where the run shows once approved.
 */
export function ReviewBody({
  data,
  ticked,
  done,
  runsAt = 'under Runs',
  firstSite = null,
}: {
  data: UpdatesResponse;
  ticked: Set<string>;
  done: () => void;
  runsAt?: string;
  /** A proposal's site to run first: its updates lead, and one site first starts on. */
  firstSite?: string | null;
}) {
  const lead = (i: QueueItem) => (i.siteId === firstSite ? 0 : 1);
  // A stable sort: the queue's order otherwise. The first site in the list runs first.
  const chosen = data.items.filter((i) => ticked.has(key(i))).sort((a, b) => lead(a) - lead(b));
  const siteIds = [...new Set(chosen.map((i) => i.siteId))];
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [oneFirst, setOneFirst] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposedFirst = firstSite !== null && siteIds[0] === firstSite;
  const oneSiteFirst = oneFirst ?? (proposedFirst || siteIds.length >= 3);
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
    saved(
      `Approved ${chosen.length} ${chosen.length === 1 ? 'update' : 'updates'} on ${siteIds.length} ${siteIds.length === 1 ? 'site' : 'sites'}: follow it ${runsAt}`,
    );
    done();
  }

  return (
    <>
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
          One site first, {site(siteIds[0]!).siteName}: the rest run only if it passes
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
    </>
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

/** One site's part of a run: its state, backup, each update's outcome, and a held site's options. */
export function RunSite({
  batch: b,
  site: s,
  reload,
  showReason = true,
}: {
  batch: BatchView;
  site: BatchSiteView;
  reload: () => void;
  /** False where the summary above already says why it's held. */
  showReason?: boolean;
}) {
  return (
    <div css={{ display: 'grid', gap: 6 }}>
      <strong>
        {s.siteName}{' '}
        <Pill tone={runOutcome(s).tone}>
          <Dot /> {runOutcome(s).label}
        </Pill>
      </strong>
      {s.backup && <Muted>Backup: {s.backup}</Muted>}
      {showReason && s.heldReason && <p css={{ margin: 0, color: 'var(--red)' }}>{s.heldReason}</p>}
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
  );
}

// dateStyle can't be combined with timeZoneName, so the parts are named one by one.
const exact = new Intl.DateTimeFormat('en-NZ', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** A time as "4 h ago", with the exact time and zone beside it for the record. */
function Exact({ iso }: { iso: string }) {
  return (
    <>
      <Time iso={iso} /> <Muted css={{ display: 'inline' }}>({exact.format(new Date(iso))})</Muted>
    </>
  );
}

const componentsLine = (r: SiteRun) => {
  const [first, ...rest] = r.site.items;
  if (!first) return 'No components';
  return `${first.name} ${first.from} → ${first.to}${rest.length > 0 ? `, and ${rest.length} more` : ''}`;
};

/** One site's part of a run: its outcome in the summary; approval, components and backup inside. */
const isActive = (r: SiteRun) => r.site.state !== 'done' || r.batch.state !== 'finished';

/**
 * One site's part of a run: its outcome in the summary; approval, components and backup inside.
 * Only a site's newest run with a problem opens by itself; older ones stay closed with their
 * outcome in the summary. A run still going or held is
 * handled once, under "Held and running", and here is only a line pointing there.
 */
function RunEntry({ run, latest, reload }: { run: SiteRun; latest: boolean; reload: () => void }) {
  const { batch: b, site: s } = run;
  const outcome = runOutcome(s);
  const anchor = runAnchor({ batchId: b.id, siteId: s.siteId });
  if (isActive(run))
    return (
      <div
        id={anchor}
        css={{
          borderTop: '1px solid var(--line)',
          padding: '8px 0',
          display: 'flex',
          gap: '4px 12px',
          flexWrap: 'wrap',
          alignItems: 'baseline',
        }}
      >
        <span css={{ fontWeight: 550 }}>{componentsLine(run)}</span>
        <Pill tone={outcome.tone}>
          <Dot /> {outcome.label}
        </Pill>
        <span css={{ marginLeft: 'auto', fontSize: 12 }}>
          <RevealLink to={`active-${anchor}`}>Handled under Held and running</RevealLink>
        </span>
      </div>
    );
  return (
    <details
      id={anchor}
      open={outcome.problem && latest}
      css={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}
    >
      <summary
        css={{
          cursor: 'pointer',
          display: 'flex',
          gap: '4px 12px',
          flexWrap: 'wrap',
          alignItems: 'baseline',
        }}
      >
        <span css={{ fontWeight: 550 }}>{componentsLine(run)}</span>
        <Pill tone={outcome.tone}>
          <Dot /> {outcome.label}
        </Pill>
        <Muted css={{ display: 'inline', marginLeft: 'auto' }}>
          {s.finishedAt ? (
            <>
              Finished <Time iso={s.finishedAt} />
            </>
          ) : (
            <>
              Approved <Time iso={b.approvedAt} />, not finished
            </>
          )}
        </Muted>
      </summary>
      <div
        css={{
          display: 'grid',
          gap: 14,
          gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)',
          marginTop: 8,
          '@media (max-width: 760px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
        }}
      >
        <div css={{ display: 'grid', gap: 6, alignContent: 'start' }}>
          <h3 css={{ fontSize: 12 }}>Components and checks</h3>
          <RunSite batch={b} site={s} reload={reload} />
        </div>
        <dl
          css={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'max-content minmax(0, 1fr)',
            gap: '4px 12px',
            fontSize: 12,
            alignContent: 'start',
            dt: { color: 'var(--muted)' },
            dd: { margin: 0 },
          }}
        >
          <dt>Approved</dt>
          <dd>
            <Exact iso={b.approvedAt} /> by {b.approvedBy}
          </dd>
          <dt>Started</dt>
          <dd>{s.startedAt ? <Exact iso={s.startedAt} /> : 'Not yet'}</dd>
          <dt>Finished</dt>
          <dd>{s.finishedAt ? <Exact iso={s.finishedAt} /> : 'Not yet'}</dd>
          <dt>Backup</dt>
          <dd>
            {BACKUP_WORDS[s.backupKind]}
            {s.backup && <Muted>Recorded: {s.backup}</Muted>}
            <Muted>
              {s.backupKind === 'kamaji'
                ? 'A database export, not a whole-site backup.'
                : 'Recorded for this run; Kamaji didn’t make or check it.'}
            </Muted>
          </dd>
          <dt>Run</dt>
          <dd>
            <code>{b.id}</code>
            {b.sites.length > 1 && (
              <Muted>
                With {b.sites.length - 1} other {b.sites.length === 2 ? 'site' : 'sites'}
                {b.oneSiteFirst ? ', one site first' : ''}
              </Muted>
            )}
          </dd>
        </dl>
      </div>
    </details>
  );
}

/** Runs still going or held: the first thing to see, and where held sites are handled. */
function Active({ batches, reload }: { batches: BatchView[]; reload: () => void }) {
  const runs = siteRuns(batches).filter(isActive);
  if (runs.length === 0) return null;
  const held = runs.some((r) => r.site.state === 'held');
  return (
    <Panel
      aria-labelledby="active"
      css={{ borderLeft: `3px solid var(--${held ? 'red' : 'amber'})` }}
    >
      <PanelTitle id="active">{held ? 'Held and running' : 'Running'}</PanelTitle>
      {runs.map((r) => (
        <div
          key={`${r.batch.id}-${r.site.siteId}`}
          id={`active-${runAnchor({ batchId: r.batch.id, siteId: r.site.siteId })}`}
          css={{ display: 'grid', gap: 6 }}
        >
          <Muted>
            Approved <Time iso={r.batch.approvedAt} /> · {r.site.siteName}
          </Muted>
          <RunSite batch={r.batch} site={r.site} reload={reload} />
        </div>
      ))}
    </Panel>
  );
}

function SiteName({ id, name }: { id: string; name: string }) {
  const link = useLink(`/sites/${id}`);
  return (
    <a {...link} css={{ color: 'inherit', fontWeight: 600 }}>
      {name}
    </a>
  );
}

/** The history, by site or by component, with search. */
function History({ batches, reload }: { batches: BatchView[]; reload: () => void }) {
  const [grouping, setGrouping] = useState<'site' | 'component'>('site');
  const [typed, setTyped] = useState('');
  // "Open run" switches to By site; once that has rendered, open the run and move to it.
  // A link from Overview names a run in the address: open it once it's on the page.
  const goTo = useRef<string | null>(
    window.location.hash.startsWith('#run-') ? window.location.hash.slice(1) : null,
  );
  useEffect(() => {
    if (goTo.current && reveal(goTo.current)) goTo.current = null;
  });
  if (batches.length === 0) return null;
  const sites = bySite(batches, typed);
  const components = byComponent(batches, typed);
  const total = siteRuns(batches).length;
  const shown = grouping === 'site' ? sites.reduce((n, g) => n + g.runs.length, 0) : null;
  return (
    <section aria-labelledby="history" css={{ display: 'grid', gap: 'var(--gap)' }}>
      <div css={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
        <div css={{ marginRight: 'auto' }}>
          <h2 id="history" css={{ fontSize: 15 }}>
            Run history
          </h2>
          <Muted>Outcomes first; approval, components and backup evidence inside each run.</Muted>
        </div>
        <div role="group" aria-label="Group run history" css={{ display: 'flex', gap: 6 }}>
          {(
            [
              ['site', 'By site'],
              ['component', 'By component'],
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
      </div>
      <form
        role="search"
        aria-label="Search run history"
        onSubmit={(e) => e.preventDefault()}
        css={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}
      >
        <label
          css={{
            display: 'grid',
            gap: 4,
            fontSize: 12,
            fontWeight: 600,
            flex: '1 1 240px',
            maxWidth: 360,
          }}
        >
          Search
          <input
            type="search"
            value={typed}
            placeholder="Site, component or version"
            onChange={(e) => setTyped(e.target.value)}
            css={{
              font: 'inherit',
              color: 'var(--ink)',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 3,
              padding: '7px 9px',
            }}
          />
        </label>
        <Button type="button" disabled={typed === ''} onClick={() => setTyped('')}>
          Reset
        </Button>
        <Muted role="status" aria-live="polite">
          {grouping === 'site'
            ? `${shown} of ${total} site runs`
            : `${components.reduce((n, g) => n + g.changes.length, 0)} component changes`}
          {batches.length >= 50 ? ' · the 50 newest runs' : ''}
        </Muted>
      </form>
      {(grouping === 'site' ? sites.length : components.length) === 0 && (
        <Panel>
          <Empty title="Nothing matches">Try a site name, a component or a version.</Empty>
        </Panel>
      )}
      {grouping === 'site'
        ? sites.map((g) => (
            <Panel key={g.siteId} aria-label={g.siteName}>
              <div css={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <SiteName id={g.siteId} name={g.siteName} />
                <Muted css={{ display: 'inline' }}>
                  {g.runs.length} {g.runs.length === 1 ? 'run' : 'runs'}
                </Muted>
              </div>
              <div>
                {g.runs.map((r) => (
                  <RunEntry
                    key={`${r.batch.id}-${r.site.siteId}`}
                    run={r}
                    latest={r === g.runs.find((x) => !isActive(x) && runOutcome(x.site).problem)}
                    reload={reload}
                  />
                ))}
              </div>
            </Panel>
          ))
        : components.map((g) => (
            <Panel key={g.name} aria-label={g.name}>
              <div css={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <strong>{g.name}</strong>
                <Muted css={{ display: 'inline' }}>
                  {g.changes.length} {g.changes.length === 1 ? 'change' : 'changes'} on{' '}
                  {new Set(g.changes.map((c) => c.site.siteId)).size} sites
                </Muted>
              </div>
              <div css={{ overflowX: 'auto' }}>
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">Site</th>
                      <th scope="col">Change</th>
                      <th scope="col">Result</th>
                      <th scope="col">Finished</th>
                      <th scope="col">Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.changes.map((c) => (
                      <tr key={`${c.batch.id}-${c.site.siteId}-${c.item.id}`}>
                        <td>{c.site.siteName}</td>
                        <td>
                          {c.item.from} → {c.item.to}
                        </td>
                        <td>
                          {c.item.outcome ? (
                            <Pill tone={OUTCOMES[c.item.outcome][1]}>
                              <Dot /> {OUTCOMES[c.item.outcome][0]}
                            </Pill>
                          ) : (
                            <Muted>{STATE_WORDS[c.item.state]}</Muted>
                          )}
                        </td>
                        <td>
                          {c.site.finishedAt ? (
                            <Time iso={c.site.finishedAt} />
                          ) : (
                            <Muted>Not yet</Muted>
                          )}
                        </td>
                        <td>
                          <Button
                            type="button"
                            onClick={() => {
                              setTyped('');
                              setGrouping('site');
                              goTo.current = runAnchor({
                                batchId: c.batch.id,
                                siteId: c.site.siteId,
                              });
                            }}
                          >
                            Open run
                            {c.site.items.length > 1 ? ` (${c.site.items.length} components)` : ''}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Panel>
          ))}
    </section>
  );
}

export function UpdatesPage() {
  const updates = useResource('/api/updates', UpdatesResponse, { pollMs: updatesPollMs });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  // A current proposal arrives ticked, once: after that the ticks are Tyler's.
  const [shown, setShown] = useState<number | null>(null);
  const proposal = updates.state === 'ready' ? updates.data.proposal : null;
  const current = proposal && !proposal.stale ? proposal : null;
  if (current && current.id !== shown) {
    setShown(current.id);
    setTicked(new Set(current.items.map(key)));
    setReviewing(false);
  }
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
              <Active batches={data.batches} reload={reload} />
              <Queue
                data={data}
                ticked={ticked}
                setTicked={setTicked}
                reviewing={reviewing}
                setReviewing={setReviewing}
              />
              <Review
                data={data}
                ticked={ticked}
                reviewing={reviewing}
                firstSite={current?.firstSite ?? null}
                done={() => {
                  setTicked(new Set());
                  setReviewing(false);
                  reload();
                }}
              />
              <History batches={data.batches} reload={reload} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
