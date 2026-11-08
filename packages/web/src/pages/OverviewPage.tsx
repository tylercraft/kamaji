import styled from '@emotion/styled';
import { OverviewResponse, StatusResponse, type Known } from '@kamaji/shared';
import type { ReactNode } from 'react';
import {
  Dot,
  Empty,
  Grid,
  Muted,
  PageHeading,
  Panel,
  PanelTitle,
  Pill,
  ResourceView,
  Table,
  Time,
} from '../components/ui';
import { alertsHealth, cycleHealth, heartbeatHealth } from '../kamajiHealth';
import { useResource } from '../useResource';

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
  div {
    padding: 10px 15px;
    border-left: 1px solid var(--line);
    min-width: 0;
  }
  div:first-of-type {
    border-left: 0;
  }
  dt {
    font-size: 11px;
    color: var(--muted);
  }
  dd {
    margin: 3px 0 0;
    font-size: 24px;
    line-height: 1.3;
    font-weight: 600;
    letter-spacing: -0.7px;
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

function siteNote(sites: OverviewResponse['sites']): string {
  if (sites.total === 0) return 'None added yet';
  const parts: string[] = [];
  if (sites.down) parts.push(`${sites.down} down`);
  if (sites.unchecked) parts.push(`${sites.unchecked} not checked yet`);
  if (sites.connected) parts.push(`${sites.connected} connected`);
  if (sites.monitoring) parts.push(`${sites.monitoring} monitoring only`);
  if (sites.paused) parts.push(`${sites.paused} paused`);
  if (sites.unfinished) parts.push(`${sites.unfinished} setup unfinished`);
  return parts.join(' · ');
}

function Attention({ attention }: { attention: OverviewResponse['attention'] }) {
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
    <Table>
      <thead>
        <tr>
          <th scope="col">Problem</th>
          <th scope="col">Urgency</th>
          <th scope="col">Since</th>
        </tr>
      </thead>
      <tbody>
        {attention.value.map((issue) => (
          <tr key={issue.id}>
            <td>{issue.summary}</td>
            <td>
              <Pill tone={issue.severity === 'urgent' ? 'red' : 'amber'}>
                <Dot /> {issue.severity === 'urgent' ? 'Urgent' : 'Needs a look'}
              </Pill>
            </td>
            <td>
              <Time iso={issue.firstSeenAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function KamajiItself() {
  const status = useResource('/api/status', StatusResponse, { pollMs: 30_000 });
  return (
    <Panel aria-labelledby="kamaji-itself">
      <PanelTitle id="kamaji-itself">Kamaji itself</PanelTitle>
      <ResourceView resource={status} label="Kamaji’s status">
        {(s) => {
          const lines = [cycleHealth(s), heartbeatHealth(s), alertsHealth(s)];
          return (
            <>
              {lines.map((line) => (
                <div key={line.label} css={{ display: 'grid', gap: 3 }}>
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
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}

export function OverviewPage() {
  const overview = useResource('/api/overview', OverviewResponse, { pollMs: 60_000 });
  return (
    <>
      <PageHeading title="Overview" purpose="Start here. Decide what deserves your attention." />
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
              note="open problems"
            />
            <Metric
              label="Updates waiting"
              value={o.updatesWaiting}
              note="components with an update"
            />
          </Metrics>
        )}
      </ResourceView>
      <Grid columns="minmax(0, 2fr) minmax(260px, 1fr)">
        <Panel aria-labelledby="attention">
          <PanelTitle id="attention">Needs attention</PanelTitle>
          <ResourceView resource={overview} label="open problems">
            {(o) => <Attention attention={o.attention} />}
          </ResourceView>
        </Panel>
        <div css={{ display: 'grid', gap: 'var(--gap)', alignContent: 'start' }}>
          <KamajiItself />
          <Panel aria-labelledby="briefing">
            <PanelTitle id="briefing">Calcifer’s briefing</PanelTitle>
            <Muted>Calcifer isn’t connected to Kamaji yet, so there’s no briefing.</Muted>
          </Panel>
        </div>
      </Grid>
    </>
  );
}
