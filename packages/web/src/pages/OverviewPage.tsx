import styled from '@emotion/styled';
import {
  ActivityResponse,
  OverviewResponse,
  ServersResponse,
  SitesResponse,
  StatusResponse,
  UpdatesResponse,
  type Known,
} from '@kamaji/shared';
import type { ReactNode } from 'react';
import {
  Dot,
  Empty,
  Grid,
  Muted,
  PageHeading,
  Panel,
  PanelHead,
  PanelTitle,
  Pill,
  ResourceView,
  Time,
} from '../components/ui';
import { alertsHealth, cycleHealth, heartbeatHealth } from '../kamajiHealth';
import { groupIssues, recentOutcomes, siteNote, withoutName, type Outcome } from '../overviewView';
import { useLink } from '../router';
import { useResource, type Resource } from '../useResource';

const Metrics = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  @media (max-width: 760px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  border-top-color: var(--seam);
  div {
    padding: 10px 13px;
    border-left: 1px solid var(--line);
    min-width: 0;
  }
  div:first-of-type {
    border-left: 0;
  }
  dt {
    font: 11px/1.45 var(--mono);
    color: var(--muted);
  }
  dd {
    margin: 3px 0 0;
    font: 500 24px/1.3 var(--mono);
    letter-spacing: -1px;
  }
  dd.unknown {
    font-size: 15px;
    letter-spacing: 0;
    line-height: 2;
    color: var(--muted);
  }
  p {
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
  }
`;

function Metric({ label, value, note }: { label: string; value: Known<number>; note?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      {value.known ? <dd>{value.value}</dd> : <dd className="unknown">Unknown</dd>}
      <p>{value.known ? note : value.reason}</p>
    </div>
  );
}

const yes = (value: number): Known<number> => ({ known: true, value });

function ResourceName({
  type,
  id,
  names,
}: {
  type: string;
  id: string;
  names: Map<string, string>;
}) {
  const link = useLink(type === 'site' ? `/sites/${id}` : type === 'server' ? '/servers' : '/');
  const name = type === 'kamaji' ? 'Kamaji itself' : (names.get(`${type}:${id}`) ?? id);
  return type === 'kamaji' ? (
    <strong>{name}</strong>
  ) : (
    <a {...link} css={{ color: 'inherit', fontWeight: 600 }}>
      {name}
    </a>
  );
}

/** Open issues grouped by site or server, each with when it started and was last seen. */
function Attention({
  attention,
  names,
}: {
  attention: OverviewResponse['attention'];
  names: Map<string, string>;
}) {
  if (!attention.known)
    return (
      <Empty title={attention.reason}>
        Until checks have run, an empty list here doesn’t mean all clear. Problems show here, most
        urgent first, once they have.
      </Empty>
    );
  if (attention.value.length === 0)
    return <Empty title="Nothing needs you">Every check that ran last passed.</Empty>;
  return (
    <div css={{ display: 'grid', gap: 14 }}>
      {groupIssues(attention.value).map((g) => (
        <section key={`${g.type}:${g.id}`} css={{ display: 'grid', gap: 6 }}>
          <h3 css={{ fontSize: 13 }}>
            <ResourceName type={g.type} id={g.id} names={names} />
          </h3>
          <ul css={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {g.issues.map((issue) => (
              <li
                key={issue.id}
                css={{
                  display: 'grid',
                  gap: 2,
                  padding: '8px 10px',
                  background: 'var(--soft)',
                  borderRadius: 4,
                }}
              >
                <span css={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <span css={{ fontWeight: 550 }}>
                    {withoutName(issue.summary, names.get(`${g.type}:${g.id}`) ?? g.id)}
                  </span>
                  <Pill tone={issue.severity === 'urgent' ? 'red' : 'amber'}>
                    <Dot /> {issue.severity === 'urgent' ? 'Urgent' : 'Needs a look'}
                  </Pill>
                </span>
                <Muted>
                  Open since <Time iso={issue.firstSeenAt} /> · last seen{' '}
                  <Time iso={issue.lastSeenAt} />
                </Muted>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OutcomeLink({ o }: { o: Outcome }) {
  const link = useLink(o.href);
  return (
    <a {...link} css={{ color: 'inherit', fontWeight: 550 }}>
      {o.title}
    </a>
  );
}

/** Finished runs, whole-site backups and restore checks, newest first, each linked to its record. */
function RecentOutcomes() {
  const updates = useResource('/api/updates', UpdatesResponse, { pollMs: 60_000 });
  const activity = useResource('/api/activity?limit=200', ActivityResponse, { pollMs: 60_000 });
  const updatesLink = useLink('/updates');
  return (
    <Panel aria-labelledby="outcomes">
      <PanelHead id="outcomes" title="Recent outcomes">
        <a {...updatesLink} css={{ fontSize: 12 }}>
          Update history
        </a>
      </PanelHead>
      <ResourceView resource={updates} label="recent runs">
        {(u) => {
          const events = activity.state === 'ready' ? activity.data.events : [];
          const outcomes = recentOutcomes(u.batches, events);
          if (outcomes.length === 0) return <Muted>No finished runs or backups yet.</Muted>;
          return (
            <ul css={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid' }}>
              {outcomes.map((o) => (
                <li
                  key={o.key}
                  css={{
                    display: 'flex',
                    gap: '4px 12px',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    padding: '8px 0',
                    borderTop: '1px solid var(--line)',
                    '&:first-of-type': { borderTop: 0 },
                  }}
                >
                  <div css={{ display: 'grid', gap: 2, minWidth: 0 }}>
                    <OutcomeLink o={o} />
                    {o.detail && <Muted>{o.detail}</Muted>}
                  </div>
                  <div css={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
                    <Pill tone={o.tone}>
                      <Dot /> {o.label}
                    </Pill>
                    <Muted>
                      {o.atWords} <Time iso={o.at} />
                    </Muted>
                  </div>
                </li>
              ))}
            </ul>
          );
        }}
      </ResourceView>
    </Panel>
  );
}

/** Each server's maintenance in a line or two; Servers has the detail. */
function ServerMaintenance({ servers }: { servers: Resource<ServersResponse> }) {
  const link = useLink('/servers');
  return (
    <Panel aria-labelledby="maintenance">
      <PanelTitle id="maintenance">Server maintenance</PanelTitle>
      <ResourceView resource={servers} label="servers">
        {({ servers: list }) =>
          list.length === 0 ? (
            <Muted>No servers yet.</Muted>
          ) : (
            <>
              {list.map((s) => (
                <div key={s.id} css={{ display: 'grid', gap: 2 }}>
                  <strong>{s.name}</strong>
                  {!s.health.known ? (
                    <Muted>{s.health.reason}</Muted>
                  ) : s.health.value.kind === 'linux-ssh' ? (
                    <>
                      <span>
                        <Pill
                          tone={
                            s.health.value.updates.level === 'urgent'
                              ? 'red'
                              : s.health.value.updates.level === 'digest'
                                ? 'amber'
                                : 'green'
                          }
                        >
                          <Dot />{' '}
                          {s.health.value.updates.level === 'urgent'
                            ? 'Urgent'
                            : s.health.value.updates.level === 'digest'
                              ? 'For the digest'
                              : 'Nothing pressing'}
                        </Pill>
                      </span>
                      {s.health.value.updates.words.map((w) => (
                        <Muted key={w}>{w}</Muted>
                      ))}
                      {s.health.value.rebootRequired && <Muted>A restart is needed.</Muted>}
                    </>
                  ) : !s.health.value.updates.known ? (
                    <Muted>Updates: {s.health.value.updates.reason}</Muted>
                  ) : s.health.value.updates.value.items.length === 0 ? (
                    <Muted>No macOS updates waiting.</Muted>
                  ) : (
                    <Muted>
                      {s.health.value.updates.value.items.length} macOS{' '}
                      {s.health.value.updates.value.items.length === 1 ? 'update' : 'updates'}{' '}
                      waiting
                      {s.health.value.updates.value.items.some((i) => i.restart)
                        ? ', needing a restart'
                        : ''}
                      .
                    </Muted>
                  )}
                </div>
              ))}
              <Muted>Kamaji recommends; patching and restarts stay yours.</Muted>
              <a {...link} css={{ fontSize: 12 }}>
                Review servers
              </a>
            </>
          )
        }
      </ResourceView>
    </Panel>
  );
}

/** Kamaji's own health in a line; the three checks and the version one click down. */
/** Whether Kamaji itself needs a look: then its card goes first, since every other number depends on it. */
function kamajiTrouble(status: Resource<StatusResponse>): boolean {
  if (status.state !== 'ready') return status.state === 'error';
  const s = status.data;
  return [cycleHealth(s), heartbeatHealth(s), alertsHealth(s)].some(
    (l) => l.tone === 'red' || l.tone === 'amber',
  );
}

function KamajiItself({ status }: { status: Resource<StatusResponse> }) {
  return (
    <Panel aria-labelledby="kamaji-itself">
      <ResourceView resource={status} label="Kamaji’s status">
        {(s) => {
          const lines = [cycleHealth(s), heartbeatHealth(s), alertsHealth(s)];
          const bad = lines.filter((l) => l.tone === 'red' || l.tone === 'amber');
          const worst =
            lines.find((l) => l.tone === 'red') ?? lines.find((l) => l.tone === 'amber');
          return (
            <>
              <PanelHead id="kamaji-itself" title="Kamaji itself">
                <Pill tone={worst?.tone ?? 'green'}>
                  <Dot /> {worst ? `${bad.length} to look at` : 'Normal'}
                </Pill>
              </PanelHead>
              {bad.map((line) => (
                <div key={line.label} css={{ display: 'grid', gap: 2 }}>
                  <strong css={{ color: `var(--${line.tone})`, fontSize: 12 }}>{line.label}</strong>
                  <Muted>{line.detail}</Muted>
                </div>
              ))}
              <details>
                <summary>System details</summary>
                <div css={{ display: 'grid', gap: 6, marginTop: 6 }}>
                  {lines.map((line) => (
                    <div key={line.label} css={{ display: 'grid', gap: 2 }}>
                      <span>
                        <Pill tone={line.tone}>
                          <Dot /> {line.label}
                        </Pill>
                      </span>
                      <Muted>{line.detail}</Muted>
                    </div>
                  ))}
                  <Muted>
                    {s.cycle.last && (
                      <>
                        Last cycle <Time iso={s.cycle.last.startedAt} />.{' '}
                      </>
                    )}
                    {s.heartbeat.configured && s.heartbeat.lastSuccessAt && (
                      <>
                        Last ping <Time iso={s.heartbeat.lastSuccessAt} />.{' '}
                      </>
                    )}
                    Running {s.version}
                    {s.commit ? ` (${s.commit})` : ''} since <Time iso={s.startedAt} />.
                  </Muted>
                </div>
              </details>
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}

/** What the numbers cover: availability for every site, software only through Craftish Care. */
function Coverage({ overview }: { overview: Resource<OverviewResponse> }) {
  const link = useLink('/sites');
  return (
    <Panel aria-labelledby="coverage">
      <PanelTitle id="coverage">Monitoring coverage</PanelTitle>
      <ResourceView resource={overview} label="coverage">
        {(o) => (
          <>
            <Muted>
              {o.sites.connected} {o.sites.connected === 1 ? 'site reports' : 'sites report'} its
              software through Craftish Care. {o.sites.monitoring}{' '}
              {o.sites.monitoring === 1 ? 'has' : 'have'} reachability and certificate checks only,
              so the update count doesn’t describe their software.
            </Muted>
            <a {...link} css={{ fontSize: 12 }}>
              Browse sites
            </a>
          </>
        )}
      </ResourceView>
      <details>
        <summary>Calcifer’s briefing</summary>
        <Muted css={{ marginTop: 6 }}>
          Calcifer isn’t connected to Kamaji yet, so there’s no briefing.
        </Muted>
      </details>
    </Panel>
  );
}

export function OverviewPage() {
  const overview = useResource('/api/overview', OverviewResponse, { pollMs: 60_000 });
  const sites = useResource('/api/sites', SitesResponse, { pollMs: 60_000 });
  const servers = useResource('/api/servers', ServersResponse, { pollMs: 60_000 });
  const status = useResource('/api/status', StatusResponse, { pollMs: 30_000 });
  // Offers already in a run aren't waiting for an approval; they're counted beside it.
  const runs =
    sites.state === 'ready'
      ? sites.data.sites.reduce(
          (n, s) => ({
            held: n.held + s.updateWork.held,
            running: n.running + s.updateWork.running,
          }),
          { held: 0, running: 0 },
        )
      : { held: 0, running: 0 };
  const inRunsNote =
    runs.held + runs.running > 0
      ? [runs.held > 0 && `${runs.held} held`, runs.running > 0 && `${runs.running} running`]
          .filter(Boolean)
          .join(' · ')
      : null;
  const trouble = kamajiTrouble(status);
  const names = new Map<string, string>([
    ...(sites.state === 'ready'
      ? sites.data.sites.map((s) => [`site:${s.id}`, s.name] as const)
      : []),
    ...(servers.state === 'ready'
      ? servers.data.servers.map((s) => [`server:${s.id}`, s.name] as const)
      : []),
  ]);
  return (
    <>
      <PageHeading title="Overview" purpose="What needs attention, and what’s happened recently." />
      <ResourceView resource={overview} label="the overview">
        {(o) => (
          <Metrics>
            <Metric label="Sites" value={yes(o.sites.total)} note={siteNote(o.sites)} />
            <Metric
              label="Servers"
              value={yes(o.servers.total)}
              note={o.servers.total ? undefined : 'None added yet'}
            />
            <Metric
              label="Needs attention"
              value={o.attention.known ? yes(o.attention.value.length) : o.attention}
              note="open findings"
            />
            <Metric
              label="Updates to approve"
              value={o.updatesWaiting}
              note={inRunsNote ?? 'on sites Kamaji can update'}
            />
          </Metrics>
        )}
      </ResourceView>
      <Grid columns="minmax(0, 2fr) minmax(260px, 1fr)">
        <div css={{ display: 'grid', gap: 'var(--gap)', alignContent: 'start' }}>
          <Panel aria-labelledby="attention">
            <PanelTitle id="attention">Needs attention</PanelTitle>
            <ResourceView resource={overview} label="open problems">
              {(o) => <Attention attention={o.attention} names={names} />}
            </ResourceView>
          </Panel>
          <RecentOutcomes />
        </div>
        <div css={{ display: 'grid', gap: 'var(--gap)', alignContent: 'start' }}>
          {trouble && <KamajiItself status={status} />}
          <ServerMaintenance servers={servers} />
          {!trouble && <KamajiItself status={status} />}
          <Coverage overview={overview} />
        </div>
      </Grid>
    </>
  );
}
