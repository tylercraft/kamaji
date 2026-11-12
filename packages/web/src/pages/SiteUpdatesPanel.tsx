// A site's own Updates panel: what's waiting on it, ticked and approved exactly as on the Updates
// page (the same review and POST /api/batches), with the site's latest run under it.
import { UpdatesResponse, type BatchView } from '@kamaji/shared';
import { useState } from 'react';
import { Button, Muted, Panel, PanelTitle, ResourceView, Time } from '../components/ui';
import { itemKey as key } from '../updatesView';
import { useResource } from '../useResource';
import { Flags, ReviewBody, RunSite } from './UpdatesPage';

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
  const toggle = (k: string) => {
    const next = new Set(ticked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setTicked(next);
  };
  return (
    <Panel aria-labelledby="site-updates">
      <PanelTitle id="site-updates">Updates</PanelTitle>
      <ResourceView resource={updates} label="this site’s updates">
        {(data) => {
          const reload = updates.state === 'ready' ? updates.reload : () => {};
          const site = data.sites[0];
          const latest = data.batches[0];
          const run = latest?.sites[0];
          const routine = data.items.filter((i) => !i.major);
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
                      Tick all routine ({routine.length})
                    </Button>
                    <Button type="button" onClick={() => setTicked(new Set())}>
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
                  <ReviewBody
                    data={data}
                    ticked={ticked}
                    runsAt="below"
                    done={() => {
                      setTicked(new Set());
                      reload();
                    }}
                  />
                </>
              )}
              {latest && run && (
                <div
                  css={{
                    display: 'grid',
                    gap: 6,
                    borderTop: '1px solid var(--line)',
                    paddingTop: 10,
                  }}
                >
                  <Muted>
                    Latest run: approved <Time iso={latest.approvedAt} /> ·{' '}
                    {RUN_STATE[latest.state]}
                  </Muted>
                  <RunSite batch={latest} site={run} reload={reload} />
                </div>
              )}
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}
