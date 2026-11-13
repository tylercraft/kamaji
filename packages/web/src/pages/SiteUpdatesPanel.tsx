// A site's own Updates panel: what's waiting on it, ticked and approved exactly as on the Updates
// page (the same review and POST /api/batches), with the site's latest run under it: its outcome
// in a line, the components and backup evidence one click down (open when the run is held).
import { UpdatesResponse, type Known, type SiteSummary } from '@kamaji/shared';
import { useState } from 'react';
import { PrimaryButton } from '../components/forms';
import { Button, Dot, Muted, Panel, PanelHead, Pill, ResourceView, Time } from '../components/ui';
import { runOutcome } from '../runHistory';
import { workTone, workWords } from '../siteStatus';
import { itemKey as key } from '../updatesView';
import { useResource } from '../useResource';
import { Flags, ReviewBody, RunSite } from './UpdatesPage';

/** Items of this site's unfinished runs, held or still going (the batches are this site's only). */
function inRuns(batches: UpdatesResponse['batches']): { held: number; running: number } {
  let held = 0;
  let running = 0;
  for (const b of batches)
    for (const s of b.sites)
      for (const i of s.items)
        if (i.state !== 'done') {
          if (s.state === 'held') held += 1;
          else running += 1;
        }
  return { held, running };
}

export function SiteUpdatesPanel({
  siteId,
  work,
}: {
  siteId: string;
  /** Where this site's offers stand, from its summary: the same words as Sites and Overview. */
  work: Known<SiteSummary['updateWork']>;
}) {
  const updates = useResource(`/api/updates?site=${encodeURIComponent(siteId)}`, UpdatesResponse, {
    pollMs: 5_000,
  });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const toggle = (k: string) => {
    const next = new Set(ticked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setTicked(next);
  };
  // Counted from this card's own data, which refreshes every few seconds, so an approval shows at
  // once; only offers without a download come from the site's summary.
  const now =
    updates.state === 'ready' && updates.data.sites[0] && work.known
      ? {
          toApprove: updates.data.items.length,
          ...inRuns(updates.data.batches),
          noDownload: work.value.noDownload,
        }
      : null;
  return (
    <Panel aria-labelledby="site-updates" id="updates">
      <PanelHead id="site-updates" title="Updates">
        {now && workWords(now) !== '' && <Pill tone={workTone(now)}>{workWords(now)}</Pill>}
      </PanelHead>
      <ResourceView resource={updates} label="this site’s updates">
        {(data) => {
          const reload = updates.state === 'ready' ? updates.reload : () => {};
          const site = data.sites[0];
          const latest = data.batches[0];
          const run = latest?.sites[0];
          const routine = data.items.filter((i) => !i.major);
          const outcome = run ? runOutcome(run) : null;
          const chosen = data.items.filter((i) => ticked.has(key(i))).length;
          return (
            <>
              {!site ? (
                <Muted>
                  Kamaji can’t update this site: that needs Craftish Care connected, setup finished,
                  and its checks not paused.
                </Muted>
              ) : site.blocked ? (
                <Muted css={{ color: 'var(--amber)' }}>{site.blocked}.</Muted>
              ) : data.unknown > 0 ? (
                <Muted>
                  It hasn’t reported yet, so what’s waiting is unknown, which isn’t the same as
                  nothing.
                </Muted>
              ) : data.items.length === 0 ? (
                <Muted>
                  {work.known && (work.value.held > 0 || work.value.running > 0)
                    ? 'Nothing else to approve: the rest is in the run below.'
                    : 'Nothing to approve: WordPress offers no updates here.'}
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
                  </div>
                  <div css={{ display: 'grid', gap: 4 }}>
                    {data.items.map((i) => (
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
                  {reviewing && chosen > 0 ? (
                    <section
                      aria-label="Review"
                      css={{
                        display: 'grid',
                        gap: 8,
                        borderTop: '1px solid var(--line)',
                        paddingTop: 10,
                      }}
                    >
                      <h3 css={{ fontSize: 13 }}>Review</h3>
                      <ReviewBody
                        data={data}
                        ticked={ticked}
                        runsAt="below"
                        done={() => {
                          setTicked(new Set());
                          setReviewing(false);
                          reload();
                        }}
                      />
                    </section>
                  ) : (
                    <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <PrimaryButton
                        type="button"
                        disabled={chosen === 0}
                        aria-describedby="review-note"
                        onClick={() => setReviewing(true)}
                      >
                        Review selected updates{chosen > 0 ? ` (${chosen})` : ''}
                      </PrimaryButton>
                      <Muted id="review-note">
                        {chosen === 0
                          ? 'Select updates first. Nothing runs until you approve the review.'
                          : 'Nothing runs until you approve the review.'}
                      </Muted>
                    </div>
                  )}
                </>
              )}
              {latest && run && outcome && (
                <div
                  css={{
                    display: 'grid',
                    gap: 6,
                    borderTop: '1px solid var(--line)',
                    paddingTop: 10,
                  }}
                >
                  <div
                    css={{
                      display: 'flex',
                      gap: 8,
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                    }}
                  >
                    <h3 css={{ fontSize: 13 }}>Latest run</h3>
                    <Pill tone={outcome.tone}>
                      <Dot /> {outcome.label}
                    </Pill>
                  </div>
                  <p css={{ margin: 0 }}>
                    {run.items.map((i) => `${i.name} ${i.from} → ${i.to}`).join(', ')}
                  </p>
                  <Muted>
                    Approved <Time iso={latest.approvedAt} /> ·{' '}
                    {run.state === 'held'
                      ? 'held, waiting for you'
                      : run.state === 'done'
                        ? latest.state === 'finished'
                          ? 'finished'
                          : 'done here; the run continues on other sites'
                        : run.state === 'running'
                          ? 'running now'
                          : 'waiting its turn'}
                  </Muted>
                  {run.heldReason && (
                    <p css={{ margin: 0, color: 'var(--red)' }}>{run.heldReason}</p>
                  )}
                  <details open={outcome.problem}>
                    <summary>Run details and backup evidence</summary>
                    <div css={{ marginTop: 6 }}>
                      <RunSite batch={latest} site={run} reload={reload} showReason={false} />
                    </div>
                  </details>
                </div>
              )}
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}
