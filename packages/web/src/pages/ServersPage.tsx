import { ServersResponse, type LinuxHealth, type ServerSummary } from '@kamaji/shared';
import {
  Empty,
  Grid,
  Muted,
  PageHeading,
  Panel,
  PanelTitle,
  ResourceView,
  Time,
} from '../components/ui';
import { useResource } from '../useResource';
import { Fact, Facts, Flag, gb, MacFacts, MacJobs } from './MolcajeteFacts';

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 2) return `${days} days`;
  const hours = Math.floor(seconds / 3_600);
  return hours >= 1 ? `${hours} h` : `${Math.floor(seconds / 60)} min`;
}

function LinuxFacts({ health }: { health: LinuxHealth }) {
  const security = health.securityUpdates.length;
  return (
    <Facts>
      <Fact label="Updates">
        {security > 0 ? (
          <Flag tone="amber">
            {security} security {security === 1 ? 'update' : 'updates'}
          </Flag>
        ) : (
          <Flag tone="green">No security updates</Flag>
        )}{' '}
        <Muted css={{ display: 'inline' }}>
          {health.otherUpdates} other {health.otherUpdates === 1 ? 'package' : 'packages'}
        </Muted>
        {security > 0 && <Muted>{health.securityUpdates.join(', ')}</Muted>}
      </Fact>
      <Fact label="Restart">
        {health.rebootRequired ? <Flag tone="amber">Needed</Flag> : 'Not needed'}
        {health.uptimeSeconds !== null && <Muted>Up {uptime(health.uptimeSeconds)}</Muted>}
      </Fact>
      <Fact label="Services">
        {health.stopped.length > 0 ? (
          <Flag tone="red">Stopped: {health.stopped.join(', ')}</Flag>
        ) : (
          'All running'
        )}
      </Fact>
      <Fact label="Disk">
        {health.disks.map((d) => (
          <div key={d.mount}>
            {d.usedPercent >= 85 ? (
              <Flag tone={d.usedPercent >= 95 ? 'red' : 'amber'}>
                {d.mount} {d.usedPercent}% full
              </Flag>
            ) : (
              <>
                {d.mount} {d.usedPercent}% full
              </>
            )}{' '}
            <Muted css={{ display: 'inline' }}>{gb(d.availableBytes)} free</Muted>
          </div>
        ))}
      </Fact>
      <Fact label="Memory">
        {health.memoryUsedPercent === null ? 'Unknown' : `${health.memoryUsedPercent}% in use`}
      </Fact>
      <Fact label="Load">
        {health.load.one === null
          ? 'Unknown'
          : `${health.load.one.toFixed(2)}${health.load.cpus ? ` on ${health.load.cpus} CPUs` : ''}`}
      </Fact>
      <Fact label="OS">
        {health.os}
        <Muted>
          {health.osSupportEnds
            ? `Standard support until ${health.osSupportEnds}`
            : 'Support end date unknown to Kamaji'}
        </Muted>
      </Fact>
      {health.php.length > 0 && <Fact label="PHP">{health.php.join(', ')}</Fact>}
    </Facts>
  );
}

function ServerCard({ server }: { server: ServerSummary }) {
  const attempt = server.lastAttempt;
  return (
    <Panel aria-labelledby={`server-${server.id}`}>
      <div css={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <PanelTitle id={`server-${server.id}`}>{server.name}</PanelTitle>
          <Muted>
            {server.kind === 'linux-ssh' ? 'Report over a forced-command SSH key' : 'Read locally'}
          </Muted>
        </div>
        {attempt.known && (
          <div css={{ textAlign: 'right' }}>
            {attempt.value.ok ? (
              <Muted>
                Read <Time iso={attempt.value.at} />
              </Muted>
            ) : (
              <>
                <Flag tone="red">Last read failed</Flag>
                <Muted>
                  {attempt.value.problem} · <Time iso={attempt.value.at} />
                </Muted>
              </>
            )}
          </div>
        )}
      </div>
      {server.health.known ? (
        <>
          {attempt.known && !attempt.value.ok && (
            <Muted>
              Showing the last report that could be read, from{' '}
              <Time iso={server.health.value.checkedAt} />.
            </Muted>
          )}
          {server.health.value.kind === 'linux-ssh' ? (
            <LinuxFacts health={server.health.value} />
          ) : (
            <MacFacts health={server.health.value} />
          )}
        </>
      ) : (
        <Muted>{server.health.reason}</Muted>
      )}
    </Panel>
  );
}

export function ServersPage() {
  const servers = useResource('/api/servers', ServersResponse, { pollMs: 60_000 });
  return (
    <>
      <PageHeading
        title="Servers"
        purpose="Resolve infrastructure issues and plan server maintenance."
      />
      <ResourceView resource={servers} label="servers">
        {({ servers }) =>
          servers.length === 0 ? (
            <Panel>
              <Empty title="No servers yet">
                craftish, molcajete and Calcifer’s own jobs join with monitoring: security packages,
                restarts, failed services and job errors, and disk. Kamaji recommends; patching and
                restarts stay yours.
              </Empty>
            </Panel>
          ) : (
            <>
              <Grid columns="repeat(2, minmax(0, 1fr))">
                {servers.map((server) => (
                  <ServerCard key={server.id} server={server} />
                ))}
              </Grid>
              {servers.map((server) =>
                server.health.known && server.health.value.kind === 'local-mac' ? (
                  <MacJobs key={server.id} health={server.health.value} />
                ) : null,
              )}
            </>
          )
        }
      </ResourceView>
      <Muted>Kamaji recommends; patching and restarts stay yours.</Muted>
    </>
  );
}
