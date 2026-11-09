// molcajete's part of the Servers page: its own health, then Calcifer's jobs and their crashes.
import styled from '@emotion/styled';
import {
  JobDetailResponse,
  type CrashGroup,
  type Known,
  type MacHealth,
  type MacJob,
} from '@kamaji/shared';
import { useState, type ReactNode } from 'react';
import {
  Button,
  Dot,
  Muted,
  Panel,
  PanelTitle,
  Pill,
  ResourceView,
  Table,
  Time,
  type Tone,
} from '../components/ui';
import { useResource } from '../useResource';

export const Facts = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 7px 16px;
  font-size: 12px;
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
`;

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function Flag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Pill tone={tone}>
      <Dot /> {children}
    </Pill>
  );
}

export const gb = (bytes: number) =>
  bytes >= 1024 ** 4
    ? `${(bytes / 1024 ** 4).toFixed(1)} TB`
    : `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

function KnownOr<T>({ value, children }: { value: Known<T>; children: (v: T) => ReactNode }) {
  return value.known ? <>{children(value.value)}</> : <Muted>{value.reason}</Muted>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function MacFacts({ health }: { health: MacHealth }) {
  return (
    <Facts>
      <Fact label="Disks">
        {health.disks.map((d) => (
          <div key={d.name}>
            {!d.mounted ? (
              <Flag tone="red">{d.name} isn’t mounted</Flag>
            ) : d.usedPercent === null ? (
              <>
                {d.name} <Muted css={{ display: 'inline' }}>couldn’t be read</Muted>
              </>
            ) : d.usedPercent >= 85 ? (
              <Flag tone={d.usedPercent >= 95 ? 'red' : 'amber'}>
                {d.name} {d.usedPercent}% full
              </Flag>
            ) : (
              <>
                {d.name} {d.usedPercent}% full
              </>
            )}{' '}
            {d.availableBytes !== null && (
              <Muted css={{ display: 'inline' }}>{gb(d.availableBytes)} free</Muted>
            )}
            {d.smart && d.smart !== 'Verified' && <Flag tone="red">SMART: {d.smart}</Flag>}
            {d.mounted && d.writable === false && d.mount !== '/' && (
              <Flag tone="amber">Read-only</Flag>
            )}
          </div>
        ))}
      </Fact>
      <Fact label="Updates">
        <KnownOr value={health.updates}>
          {(u) => (
            <>
              {u.items.length === 0 ? (
                'Up to date'
              ) : (
                <>
                  {u.items.map((i) => i.title).join(', ')}
                  {u.items.some((i) => i.restart) && <Muted>Needs a restart to install</Muted>}
                </>
              )}
              <Muted>
                Checked <Time iso={u.checkedAt} />
              </Muted>
            </>
          )}
        </KnownOr>
      </Fact>
      <Fact label="Docker">
        <KnownOr value={health.docker}>
          {(d) => {
            const unwell = d.containers.filter((c) => !c.healthy);
            return (
              <>
                {unwell.length > 0 ? (
                  <Flag tone="amber">Not running well: {unwell.map((c) => c.name).join(', ')}</Flag>
                ) : (
                  `${plural(d.containers.length, 'container')} running`
                )}
                <Muted>{d.desktop ?? `Engine ${d.engine}`}</Muted>
              </>
            );
          }}
        </KnownOr>
      </Fact>
      <Fact label="Tailscale">
        <KnownOr value={health.tailscale}>
          {(t) => (
            <>
              {t.state === 'Running' ? 'Connected' : <Flag tone="red">{t.state}</Flag>}
              {t.health.map((h) => (
                <Muted key={h}>{h}</Muted>
              ))}
              <Muted>Version {t.version}</Muted>
            </>
          )}
        </KnownOr>
      </Fact>
      <Fact label="Restarted">
        <KnownOr value={health.bootedAt}>
          {(at) => (
            <>
              <Time iso={at} />
              <Muted>The cause isn’t kept long enough to tell</Muted>
            </>
          )}
        </KnownOr>
      </Fact>
      <Fact label="repo-pull">
        <KnownOr value={health.repoPull}>
          {(r) =>
            r.failingSince ? (
              <>
                <Flag tone="amber">
                  Failing since <Time iso={r.failingSince} />
                </Flag>
                <Muted>
                  Last tried <Time iso={r.lastAt} />
                </Muted>
              </>
            ) : (
              <>
                Pulling{' '}
                <Muted>
                  Last pulled <Time iso={r.lastAt} />
                </Muted>
              </>
            )
          }
        </KnownOr>
      </Fact>
    </Facts>
  );
}

function stateLabel(job: MacJob): string {
  if (job.state === 'not-loaded') return 'Not loaded';
  return job.state === 'running' ? 'Running' : 'Idle';
}

function exitLabel(code: number | null): string {
  if (code === null) return '–';
  return code < 0 ? `signal ${-code}` : String(code);
}

const Pre = styled.pre`
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  background: var(--sunk, rgba(127, 127, 127, 0.08));
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

function JobDetail({ name }: { name: string }) {
  const detail = useResource(`/api/servers/molcajete/jobs/${name}`, JobDetailResponse);
  return (
    <ResourceView resource={detail} label={`${name}’s details`}>
      {(d) => (
        <div css={{ display: 'grid', gap: 8 }}>
          <div>
            <strong>Latest crash</strong>
            <KnownOr value={d.crash}>
              {(c) =>
                c === null ? (
                  <Muted>None in the crash log</Muted>
                ) : (
                  <>
                    <Muted>
                      {c.type} in {c.where ?? 'an unknown place'}
                      {c.line !== null && `, line ${c.line}`} · <Time iso={c.at} />
                    </Muted>
                    {c.message && <Muted>{c.message}</Muted>}
                    {c.traceback && <Pre>{c.traceback}</Pre>}
                  </>
                )
              }
            </KnownOr>
          </div>
          <div>
            <strong>Log</strong>
            <KnownOr value={d.log}>{(text) => <Pre>{text || '(empty)'}</Pre>}</KnownOr>
          </div>
        </div>
      )}
    </ResourceView>
  );
}

function JobRow({ job, crashes }: { job: MacJob; crashes: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>
          {job.name}
          {job.schedule && <Muted>{job.schedule}</Muted>}
        </td>
        <td>{job.attention ? <Flag tone="red">{job.attention}</Flag> : stateLabel(job)}</td>
        <td>{exitLabel(job.lastExitCode)}</td>
        <td>{job.lastRunAt ? <Time iso={job.lastRunAt} /> : <Muted>Not seen yet</Muted>}</td>
        <td>
          {crashes > 0 ? <Flag tone="amber">{plural(crashes, 'crash', 'crashes')}</Flag> : '–'}
        </td>
        <td css={{ textAlign: 'right' }}>
          <Button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            css={{ fontSize: 11, padding: '2px 8px' }}
          >
            {open ? 'Hide' : 'Details'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <JobDetail name={job.name} />
          </td>
        </tr>
      )}
    </>
  );
}

function CrashList({ crashes }: { crashes: CrashGroup[] }) {
  return (
    <div css={{ display: 'grid', gap: 10 }}>
      {crashes.map((g) => (
        <div key={g.id}>
          <Flag tone="amber">
            {g.job.replace(/^dev\.craftish\.calcifer\./, '')}: {g.type}
          </Flag>{' '}
          <Muted css={{ display: 'inline' }}>
            {plural(g.recent, 'time')} this week, last <Time iso={g.lastAt} />
          </Muted>
          <Muted>
            {g.where ?? 'Unknown place'}
            {g.line !== null && `:${g.line}`}
          </Muted>
          {g.frames.length > 0 && (
            <details>
              <summary css={{ fontSize: 11, cursor: 'pointer' }}>Stack</summary>
              <Pre>
                {g.frames.map((f) => `${f.file}:${f.line ?? '?'} in ${f.function}`).join('\n')}
              </Pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export function MacJobs({ health }: { health: MacHealth }) {
  const crashCount = (job: MacJob) =>
    health.crashes.filter((g) => g.job === job.label).reduce((n, g) => n + g.recent, 0);
  const jobs = [...health.jobs].sort(
    (a, b) =>
      Number(Boolean(b.attention)) - Number(Boolean(a.attention)) ||
      crashCount(b) - crashCount(a) ||
      a.name.localeCompare(b.name),
  );
  return (
    <Panel aria-labelledby="calcifer-jobs">
      <PanelTitle id="calcifer-jobs">Calcifer’s jobs on molcajete</PanelTitle>
      <Muted>
        Logs and crash messages show only for jobs that never read mail or untrusted text.
      </Muted>
      {health.crashes.length > 0 && (
        <div css={{ margin: '12px 0' }}>
          <CrashList crashes={health.crashes} />
        </div>
      )}
      <div css={{ overflowX: 'auto' }}>
        <Table>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">State</th>
              <th scope="col">Last exit</th>
              <th scope="col">Last run</th>
              <th scope="col">Crashes (7 days)</th>
              <th scope="col" aria-label="Details" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow key={job.label} job={job} crashes={crashCount(job)} />
            ))}
          </tbody>
        </Table>
      </div>
    </Panel>
  );
}
