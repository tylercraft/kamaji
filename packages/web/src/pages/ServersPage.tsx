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
import { CURRENT_FOR, isOutOfDate } from '../siteStatus';
import { useResource } from '../useResource';
import { DISK_URGENT, DISK_WARN, Meter, Part, PartsRow } from '../components/serverParts';
import { Fact, Facts, Flag, gb, MacFacts, MacJobs } from './MolcajeteFacts';
import { PackageLists, UpdatesRating } from './ServerUpdatesPanel';

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 2) return `${days} days`;
  const hours = Math.floor(seconds / 3_600);
  return hours >= 1 ? `${hours} h` : `${Math.floor(seconds / 60)} min`;
}

/** Pending over 7 days: the point it turns urgent (checks/serverUpdates.ts). */
function restartOverdue(health: LinuxHealth): boolean {
  const since = health.updates.reboot?.since;
  return since !== null && since !== undefined
    ? Date.parse(health.checkedAt) - Date.parse(since) > 7 * 86_400_000
    : false;
}

/** craftish and any Linux server: maintenance, resources, services, then system details. */
function LinuxParts({ health, now }: { health: LinuxHealth; now: number }) {
  const u = health.updates;
  const listed = u.security.length + u.care.length + u.routine.length;
  return (
    <>
      <PartsRow>
        <Part title="Maintenance">
          <div css={{ display: 'grid', gap: 2, justifyItems: 'start' }}>
            <UpdatesRating updates={u} />
          </div>
          <Facts>
            <Fact label="Restart">
              {health.rebootRequired ? (
                <>
                  <Flag tone={restartOverdue(health) ? 'red' : 'amber'}>Needed</Flag>
                  {u.reboot?.since && (
                    <Muted>
                      Pending since <Time iso={u.reboot.since} />
                      {u.reboot.packages.length > 0 ? ` for ${u.reboot.packages.join(', ')}` : ''}
                    </Muted>
                  )}
                </>
              ) : (
                'Not needed'
              )}
            </Fact>
            <Fact label="Waiting">
              {u.total === 0
                ? 'Nothing waiting'
                : `${u.security.length} security · ${u.care.length} need care · ${u.routine.length} routine`}
            </Fact>
          </Facts>
          <Muted>
            This is what the latest report lists as waiting. Kamaji doesn’t see whether automatic
            upgrades installed anything until the next report stops listing it.
          </Muted>
        </Part>
        <Part title="Resources">
          {health.disks.map((d) => (
            <Meter
              key={d.mount}
              label={`Disk ${d.mount}`}
              percent={d.usedPercent}
              words={`${d.usedPercent}% used · ${gb(d.availableBytes)} free`}
              thresholds={[DISK_WARN, DISK_URGENT]}
            />
          ))}
          {health.memoryUsedPercent === null ? (
            <Muted>Memory: unknown</Muted>
          ) : (
            <Meter
              label="Memory"
              percent={health.memoryUsedPercent}
              words={`${health.memoryUsedPercent}% in use`}
            />
          )}
          <Muted>
            Load{' '}
            {health.load.one === null
              ? 'unknown'
              : `${health.load.one.toFixed(2)}${health.load.cpus ? ` on ${health.load.cpus} CPUs` : ''}`}
          </Muted>
        </Part>
        <Part
          title="Services"
          aside={
            health.stopped.length > 0 ? (
              <Flag tone="red">Stopped: {health.stopped.join(', ')}</Flag>
            ) : (
              <Muted css={{ display: 'inline' }}>All running</Muted>
            )
          }
        >
          {health.uptimeSeconds !== null && <Muted>Up {uptime(health.uptimeSeconds)}</Muted>}
        </Part>
      </PartsRow>
      {listed > 0 && (
        <details>
          <summary>Packages and impact ({u.total})</summary>
          <div css={{ marginTop: 6 }}>
            <PackageLists updates={u} />
          </div>
        </details>
      )}
      <details>
        <summary>System and reporting</summary>
        <Facts css={{ marginTop: 6 }}>
          <Fact label="OS">
            {health.os}
            <Muted>
              {health.osSupportEnds
                ? `Standard support until ${health.osSupportEnds}`
                : 'Support end date unknown to Kamaji'}
            </Muted>
          </Fact>
          {health.php.length > 0 && <Fact label="PHP">{health.php.join(', ')}</Fact>}
          <Fact label="Reporting">Report over a forced-command SSH key</Fact>
          <Fact label="Report">
            <Time iso={health.checkedAt} />
            {isOutOfDate(health.checkedAt, CURRENT_FOR.serverRead, now) && (
              <span css={{ color: 'var(--amber)' }}> · out of date</span>
            )}
          </Fact>
        </Facts>
      </details>
    </>
  );
}

function ServerCard({ server, now }: { server: ServerSummary; now: number }) {
  const attempt = server.lastAttempt;
  return (
    <Panel aria-labelledby={`server-${server.id}`}>
      <div css={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <PanelTitle id={`server-${server.id}`}>{server.name}</PanelTitle>
        </div>
        {attempt.known && (
          <div css={{ textAlign: 'right' }}>
            {attempt.value.ok ? (
              <Muted>
                Read <Time iso={attempt.value.at} />
                {isOutOfDate(attempt.value.at, CURRENT_FOR.serverRead, now) && (
                  <span css={{ color: 'var(--amber)' }}> · out of date</span>
                )}
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
            <LinuxParts health={server.health.value} now={now} />
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
  const now = servers.state === 'ready' ? servers.loadedAt : 0;
  return (
    <>
      <PageHeading
        title="Servers"
        purpose="Maintenance first, with resources and diagnostics close at hand."
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
              <Grid>
                {servers.map((server) => (
                  <ServerCard key={server.id} server={server} now={now} />
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
