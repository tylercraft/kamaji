import { SitesResponse, type SiteSummary } from '@kamaji/shared';
import { useState } from 'react';
import {
  Button,
  Dot,
  Empty,
  Muted,
  PageHeading,
  Panel,
  Pill,
  ResourceView,
  Table,
  Time,
  type Tone,
} from '../components/ui';
import { useLink } from '../router';
import {
  certificate,
  CURRENT_FOR,
  fromOutside,
  isOutOfDate,
  updates,
  workTone,
  workWords,
} from '../siteStatus';
import { filterSites, NO_FILTERS, present, type SiteFilters } from '../sitesView';
import { useResource } from '../useResource';

const hostNames: Record<SiteSummary['hostKind'], string> = {
  craftish: 'craftish',
  kinsta: 'Kinsta',
  wpengine: 'WP Engine',
  other: 'Other host',
};

const stateLabels = {
  up: ['Reachable', 'green'],
  failing: ['Failed once', 'amber'],
  down: ['Down', 'red'],
} as const satisfies Record<string, [string, Tone]>;

/** When a check is older than it should be, its time says so, and a pass stops looking green. */
function Checked({ iso, old }: { iso: string; old: boolean }) {
  return (
    <>
      <Time iso={iso} />
      {old && <span css={{ color: 'var(--amber)' }}> · out of date</span>}
    </>
  );
}

/** Reachable: the home page answered (with its expected text, if set). Not the same as healthy. */
function Availability({ site, now }: { site: SiteSummary; now: number }) {
  if (site.setup !== 'done') return <Pill tone="amber">Setup unfinished</Pill>;
  if (site.pausedAt) return <Pill>Paused</Pill>;
  const a = site.availability;
  // Unknown is never "up": until the first check lands, it says why it doesn't know.
  if (!a.known) return <Muted>{a.reason}</Muted>;
  const old = isOutOfDate(a.value.checkedAt, CURRENT_FOR.pageCheck, now);
  const [label, tone] = stateLabels[a.value.state];
  return (
    <div css={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
      <Pill tone={old && a.value.state === 'up' ? 'neutral' : tone}>
        <Dot /> {old && a.value.state === 'up' ? 'Last reachable' : label}
      </Pill>
      <Muted>
        {a.value.problem ?? (a.value.responseMs !== null ? `${a.value.responseMs} ms` : '')}
        {' · '}
        <Checked iso={a.value.checkedAt} old={old} />
      </Muted>
    </div>
  );
}

function Outside({ site, now }: { site: SiteSummary; now: number }) {
  // A private site can't be seen from outside: that's not a failure or an unknown.
  if (site.tailnetOnly) return <Muted>Not applicable: private site</Muted>;
  const o = site.outside;
  if (!o.known) return <Muted>{o.reason}</Muted>;
  const old = isOutOfDate(o.value.checkedAt, CURRENT_FOR.pageCheck, now);
  return (
    <div css={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
      <Pill tone={o.value.ok ? (old ? 'neutral' : 'green') : 'red'}>
        <Dot /> {o.value.ok ? (old ? 'Last reachable' : 'Reachable') : 'Failing'}
      </Pill>
      <Muted>
        {o.value.problem ? `${o.value.problem} · ` : ''}
        <Checked iso={o.value.checkedAt} old={old} />
      </Muted>
    </div>
  );
}

/** The same words as the site's page: a timed-out check isn't a bad certificate. */
function CertificateCell({ site }: { site: SiteSummary }) {
  const l = certificate(site);
  if (l.tone === 'green') return <Muted>{l.detail.replace(/\.$/, '')}</Muted>;
  if (l.tone === 'neutral') return <Muted>{l.state}</Muted>;
  return (
    <div css={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
      <Pill tone={l.tone}>
        <Dot /> {l.state}
      </Pill>
      {l.tone === 'red' && <Muted>{l.detail}</Muted>}
    </div>
  );
}

function UpdatesCell({ site }: { site: SiteSummary }) {
  if (site.mode !== 'connected') return <Muted>Not monitored</Muted>;
  if (!site.updates.known) return <Muted>Unknown: {lower(site.updates.reason)}</Muted>;
  // The same words as the site's page and the Updates queue: to approve, held, running.
  const words = workWords(site.updateWork);
  return words === '' ? (
    <Muted>None offered</Muted>
  ) : (
    <Pill tone={workTone(site.updateWork)}>
      <Dot /> {words}
    </Pill>
  );
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Open findings other than reachability: a site can be reachable and still need attention. */
function Findings({ site }: { site: SiteSummary }) {
  const f = site.findings;
  if (f.length === 0) return null;
  const urgent = f.some((x) => x.severity === 'urgent');
  return (
    <details css={{ marginTop: 3 }}>
      <summary
        css={{ cursor: 'pointer', fontSize: 12, color: `var(--${urgent ? 'red' : 'amber'})` }}
      >
        {f.length} {f.length === 1 ? 'finding' : 'findings'}
      </summary>
      <ul css={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, maxWidth: 360 }}>
        {f.map((x) => (
          <li key={x.kind}>{x.summary}</li>
        ))}
      </ul>
    </details>
  );
}

function SiteLink({ site }: { site: SiteSummary }) {
  const link = useLink(`/sites/${site.id}`);
  return (
    <a {...link} css={{ fontWeight: 600, color: 'inherit' }}>
      {site.name}
    </a>
  );
}

function AddSiteLink() {
  const link = useLink('/sites/new');
  return (
    <a
      {...link}
      css={{
        padding: '7px 13px',
        borderRadius: 3,
        background: 'var(--copper)',
        color: 'var(--on-copper)',
        fontSize: 12,
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      Add site
    </a>
  );
}

const MODES: Record<SiteSummary['mode'], string> = {
  connected: 'Craftish Care',
  monitoring: 'Monitoring only',
};

const field = {
  font: 'inherit',
  color: 'var(--ink)',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '7px 9px',
  '&:focus-visible': { outline: '2px solid var(--copper)', outlineOffset: 1 },
} as const;

/**
 * On a phone, a site per card: its home page check always, then a flag for anything else that
 * needs a look (outside check, certificate, updates, findings), and every check one click down.
 */
function SiteCard({ site, now }: { site: SiteSummary; now: number }) {
  const lines =
    site.setup !== 'done'
      ? []
      : [
          ...(site.tailnetOnly ? [] : [fromOutside(site, now)]),
          certificate(site),
          ...(site.mode === 'connected' ? [updates(site)] : []),
        ].filter((l) => l.tone === 'red' || l.tone === 'amber' || l.outOfDate);
  return (
    <li
      css={{
        borderTop: '1px solid var(--line)',
        padding: '10px 0',
        display: 'grid',
        gap: 4,
        '&:first-of-type': { borderTop: 0 },
      }}
    >
      <SiteLink site={site} />
      <Muted>
        <a href={site.url} target="_blank" rel="noreferrer" css={{ color: 'inherit' }}>
          {new URL(site.url).host} ↗
        </a>{' '}
        · {hostNames[site.hostKind]} · {MODES[site.mode]}
        {site.tailnetOnly ? ' · private' : ''}
      </Muted>
      <div css={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Availability site={site} now={now} />
        {lines.map((l) => (
          <Pill key={l.label} tone={l.tone === 'green' ? 'neutral' : l.tone}>
            <Dot /> {l.label}:{' '}
            {l.outOfDate && l.tone !== 'red' && l.tone !== 'amber' ? 'out of date' : l.state}
          </Pill>
        ))}
        {site.findings.length > 0 && (
          <Pill tone={site.findings.some((f) => f.severity === 'urgent') ? 'red' : 'amber'}>
            <Dot /> {site.findings.length} {site.findings.length === 1 ? 'finding' : 'findings'}
          </Pill>
        )}
      </div>
      <details>
        <summary css={{ fontSize: 12 }}>All checks</summary>
        <dl
          css={{
            margin: '6px 0 0',
            display: 'grid',
            gridTemplateColumns: 'max-content minmax(0, 1fr)',
            gap: '6px 12px',
            fontSize: 12,
            dt: { color: 'var(--muted)' },
            dd: { margin: 0 },
          }}
        >
          <dt>From outside</dt>
          <dd>
            <Outside site={site} now={now} />
          </dd>
          <dt>Certificate</dt>
          <dd>
            <CertificateCell site={site} />
          </dd>
          <dt>Updates</dt>
          <dd>
            <UpdatesCell site={site} />
          </dd>
          {site.findings.length > 0 && (
            <>
              <dt>Findings</dt>
              <dd>
                <ul css={{ margin: 0, paddingLeft: 16 }}>
                  {site.findings.map((f) => (
                    <li key={f.kind}>{f.summary}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      </details>
    </li>
  );
}

/** Search, host and mode, together; Escape in the search clears it, Reset clears all three. */
function Toolbar({
  filters,
  onChange,
  sites,
}: {
  filters: SiteFilters;
  onChange: (f: SiteFilters) => void;
  sites: SiteSummary[];
}) {
  const { hosts, modes } = present(sites);
  const label = { display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 } as const;
  return (
    <form
      role="search"
      aria-label="Filter sites"
      onSubmit={(e) => e.preventDefault()}
      css={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}
    >
      <label css={{ ...label, flex: '1 1 240px', maxWidth: 360 }}>
        Search
        <input
          type="search"
          placeholder="Name, domain or client"
          value={filters.typed}
          onChange={(e) => onChange({ ...filters, typed: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onChange({ ...filters, typed: '' });
            }
          }}
          css={field}
        />
      </label>
      <label css={label}>
        Host
        <select
          value={filters.host}
          onChange={(e) => onChange({ ...filters, host: e.target.value })}
          css={field}
        >
          <option value="">All hosts</option>
          {hosts.map((h) => (
            <option key={h} value={h}>
              {hostNames[h]}
            </option>
          ))}
        </select>
      </label>
      <label css={label}>
        Mode
        <select
          value={filters.mode}
          onChange={(e) => onChange({ ...filters, mode: e.target.value })}
          css={field}
        >
          <option value="">All modes</option>
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODES[m]}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        disabled={filters.typed === '' && filters.host === '' && filters.mode === ''}
        onClick={() => onChange(NO_FILTERS)}
      >
        Reset filters
      </Button>
    </form>
  );
}

export function SitesPage() {
  const sites = useResource('/api/sites', SitesResponse, { pollMs: 60_000 });
  const [filters, setFilters] = useState<SiteFilters>(NO_FILTERS);
  const now = sites.state === 'ready' ? sites.loadedAt : 0;
  return (
    <>
      <PageHeading
        title="Sites"
        purpose="Reachability, maintenance findings and monitoring coverage."
      >
        <AddSiteLink />
      </PageHeading>
      <Panel>
        <ResourceView resource={sites} label="sites">
          {({ sites: all }) => {
            if (all.length === 0)
              return (
                <Empty title="No sites yet">
                  Nothing is being watched. Adding sites comes with monitoring: uptime and
                  certificates first, then Craftish Care for inventory and updates.
                </Empty>
              );
            const sites = filterSites(all, filters);
            const connected = sites.filter((s) => s.mode === 'connected').length;
            return (
              <>
                <Toolbar filters={filters} onChange={setFilters} sites={all} />
                <Muted role="status" aria-live="polite">
                  {sites.length === all.length
                    ? `${all.length} sites`
                    : `${sites.length} of ${all.length} sites`}{' '}
                  · {connected} with Craftish Care
                </Muted>
                {sites.length === 0 ? (
                  <Empty title="No sites match">
                    Try another host or mode, or reset the filters.
                  </Empty>
                ) : (
                  <>
                    <ul
                      aria-label="Sites"
                      css={{
                        margin: 0,
                        padding: 0,
                        listStyle: 'none',
                        '@media (min-width: 761px)': { display: 'none' },
                      }}
                    >
                      {sites.map((site) => (
                        <SiteCard key={site.id} site={site} now={now} />
                      ))}
                    </ul>
                    <div
                      css={{ overflowX: 'auto', '@media (max-width: 760px)': { display: 'none' } }}
                    >
                      <Table>
                        <thead>
                          <tr>
                            <th scope="col">Site</th>
                            <th scope="col">From the mini</th>
                            <th scope="col">From outside</th>
                            <th scope="col">Certificate</th>
                            <th scope="col">Updates</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sites.map((site) => (
                            <tr key={site.id}>
                              <td>
                                <SiteLink site={site} />
                                <Muted>
                                  <a
                                    href={site.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    css={{ color: 'inherit' }}
                                  >
                                    {new URL(site.url).host} ↗
                                  </a>
                                </Muted>
                                <Muted>
                                  {hostNames[site.hostKind]} · {MODES[site.mode]}
                                  {site.tailnetOnly ? ' · private' : ''}
                                </Muted>
                                <Findings site={site} />
                              </td>
                              <td>
                                <Availability site={site} now={now} />
                              </td>
                              <td>
                                <Outside site={site} now={now} />
                              </td>
                              <td>
                                <CertificateCell site={site} />
                              </td>
                              <td>
                                <UpdatesCell site={site} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                  </>
                )}
                <Muted>
                  Reachable means the home page answered; findings are listed under each site.
                  Updates aren’t monitored on monitoring-only sites.
                </Muted>
              </>
            );
          }}
        </ResourceView>
      </Panel>
    </>
  );
}
