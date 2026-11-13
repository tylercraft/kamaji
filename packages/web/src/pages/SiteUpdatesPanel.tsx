// A site's own Updates panel: what's waiting on it, ticked and approved exactly as on the Updates
// page (the same review and POST /api/batches), with the site's latest run under it: its outcome
// in a line, the components and backup evidence one click down (open when the run is held).
import { UpdatesResponse, type BatchSiteView, type BatchView } from '@kamaji/shared';
import { useState } from 'react';
import { PrimaryButton } from '../components/forms';
import {
  Button,
  Dot,
  Muted,
  Panel,
  PanelHead,
  Pill,
  ResourceView,
  Time,
  type Tone,
} from '../components/ui';
import { itemKey as key } from '../updatesView';
import { useResource } from '../useResource';
import { Flags, ReviewBody, RunSite } from './UpdatesPage';

/** The run's outcome on this site in a flag: held, failed or unverified items say so. */
function runOutcome(run: BatchSiteView): [string, Tone, boolean] {
  if (run.state === 'held') return ['Held', 'red', true];
  if (run.state !== 'done')
    return [run.state === 'running' ? 'Running' : 'Waiting', 'neutral', false];
  const failed = run.items.filter(
    (i) => i.outcome === 'checks_failed' || i.outcome === 'update_failed',
  ).length;
  if (failed > 0) return [`${failed} failed`, 'red', true];
  if (run.items.some((i) => i.outcome !== 'passed')) return ['Couldn’t verify', 'amber', true];
  return ['Updated, checks passed', 'green', false];
}

const RUN_STATE: Record<BatchView['state'], string> = {
  approved: 'Starting',
  running: 'Running',
  finished: 'Finished',
};

export function SiteUpdatesPanel({ siteId }: { siteId: string }) {
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
  return (
    <Panel aria-labelledby="site-updates" id="updates">
      <PanelHead id="site-updates" title="Updates">
        {updates.state === 'ready' && updates.data.sites[0] && (
          <Pill tone={updates.data.items.length > 0 ? 'amber' : 'neutral'}>
            {updates.data.items.length} pending
          </Pill>
        )}
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
                <Muted>Nothing waiting: WordPress offers no updates here.</Muted>
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
                    <Pill tone={outcome[1]}>
                      <Dot /> {outcome[0]}
                    </Pill>
                  </div>
                  <p css={{ margin: 0 }}>
                    {run.items.map((i) => `${i.name} ${i.from} → ${i.to}`).join(', ')}
                  </p>
                  <Muted>
                    Approved <Time iso={latest.approvedAt} /> · {RUN_STATE[latest.state]}
                  </Muted>
                  {run.heldReason && (
                    <p css={{ margin: 0, color: 'var(--red)' }}>{run.heldReason}</p>
                  )}
                  <details open={outcome[2]}>
                    <summary>Run details and backup evidence</summary>
                    <div css={{ marginTop: 6 }}>
                      <RunSite batch={latest} site={run} reload={reload} />
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
