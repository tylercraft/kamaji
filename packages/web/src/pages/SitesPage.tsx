import { RecheckAllResponse, SitesResponse, type SiteSummary } from '@kamaji/shared';
import { postJson } from '../api';
import { failed, reason, saved } from '../components/toast';
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
  careState,
  certificate,
  CURRENT_FOR,
  domain,
  fromOutside,
  isOutOfDate,
  updates,
  workTone,
  workWords,
} from '../siteStatus';
import {
  filterSites,
  GROUP_BYS,
  groupSites,
  HOST_NAMES,
  NO_FILTERS,
  PLATFORM_NAMES,
  readGroupBy,
  saveGroupBy,
  type GroupBy,
  present,
  recheckable,
  recheckSummary,
  type SiteFilters,
} from '../sitesView';
import { useResource } from '../useResource';
import { IssueStep } from '../components/IssueStep';
import { SiteIcon, WithIcon } from '../components/SiteIcon';

const hostNames = HOST_NAMES;

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

/** "Renews 2027-03-14", coloured within 30 days as the domain-expiring issue counts them. */
function RenewalCell({ site, now }: { site: SiteSummary; now: number }) {
  const l = domain(site, now);
  if (l.tone === 'neutral' || l.tone === 'green') return <Muted>{l.state}</Muted>;
  return (
    <Pill tone={l.tone}>
      <Dot /> {l.state}
    </Pill>
  );
}

function UpdatesCell({ site }: { site: SiteSummary }) {
  // A static site or an app has nothing WordPress offers.
  if (site.platform !== 'wordpress') return <Muted>Not applicable</Muted>;
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

/**
 * Open findings other than reachability: a site can be reachable and still need attention. Each
 * with its next step, as on Overview.
 */
function Findings({ site, reload }: { site: SiteSummary; reload: () => void }) {
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
      <FindingList findings={f} reload={reload} />
    </details>
  );
}

/** A group's name and how many of the shown sites are in it. */
function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <h2 css={{ margin: '14px 0 2px', fontSize: 13, fontWeight: 600 }}>
      {label} <span css={{ color: 'var(--muted)', fontWeight: 400 }}>{count}</span>
    </h2>
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

/**
 * Recheck all: a fresh report from every connected site, as each one's Refresh inventory does.
 * Nothing changes on a site, so it needs no passkey. The table reloads after, with new times.
 */
function RecheckAll({ count, reload }: { count: number; reload: () => void }) {
  const [asking, setAsking] = useState<number | null>(null);
  if (count === 0 && asking === null) return null;
  async function recheck() {
    setAsking(count);
    const result = await postJson('/api/sites/report', {}, RecheckAllResponse);
    setAsking(null);
    if (!result.ok) failed(`Recheck all didn’t run: ${reason(result.error)}`);
    else {
      const summary = recheckSummary(result.data.sites);
      (summary.ok ? saved : failed)(summary.message);
    }
    reload();
  }
  return (
    <Button
      type="button"
      disabled={asking !== null}
      onClick={recheck}
      title="Has WordPress check for updates first on each connected site, then reports"
    >
      {asking === null ? 'Recheck all' : `Asking ${asking} site${asking === 1 ? '' : 's'}…`}
    </Button>
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

const TONE_COLOUR: Record<Tone, string> = {
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  copper: 'var(--copper)',
  neutral: 'var(--muted)',
};

/**
 * How a site is watched, in its meta line. A connected site says whether Craftish Care is working:
 * its last report came through and is current, or what's wrong (the reason on hover, and on the
 * site's page).
 */
function Watched({ site, now }: { site: SiteSummary; now: number }) {
  const care = careState(site, now);
  if (!care) return <>{watched(site)}</>;
  return (
    <span
      title={care.detail || undefined}
      css={{
        color:
          care.tone === 'green' || care.tone === 'neutral' ? 'inherit' : TONE_COLOUR[care.tone],
        whiteSpace: 'nowrap',
      }}
    >
      <Dot css={{ color: TONE_COLOUR[care.tone], verticalAlign: 'middle', marginBottom: 1 }} />{' '}
      {care.text}
    </span>
  );
}

/** How a site is watched, in its meta line: WordPress says how; the rest are what they are. */
const watched = (site: SiteSummary) =>
  site.platform === 'wordpress'
    ? MODES[site.mode]
    : `${PLATFORM_NAMES[site.platform]}, monitoring only`;

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
function FindingList({
  findings,
  reload,
}: {
  findings: SiteSummary['findings'];
  reload: () => void;
}) {
  return (
    <ul
      css={{
        margin: '4px 0 0',
        padding: 0,
        listStyle: 'none',
        display: 'grid',
        gap: 8,
        fontSize: 12,
        maxWidth: 420,
      }}
    >
      {findings.map((x) => (
        <li key={x.id} css={{ display: 'grid', gap: 4 }}>
          <span>{x.summary}</span>
          <IssueStep id={x.id} action={x.action} onDone={reload} />
        </li>
      ))}
    </ul>
  );
}

function SiteCard({ site, now, reload }: { site: SiteSummary; now: number; reload: () => void }) {
  const lines =
    site.setup !== 'done'
      ? []
      : [
          ...(site.tailnetOnly ? [] : [fromOutside(site, now)]),
          certificate(site),
          domain(site, now),
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
      <WithIcon id={site.id}>
        <SiteLink site={site} />
      </WithIcon>
      <Muted>
        <a href={site.url} target="_blank" rel="noreferrer" css={{ color: 'inherit' }}>
          {new URL(site.url).host} ↗
        </a>{' '}
        · {hostNames[site.hostKind]} · <Watched site={site} now={now} />
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
          <dt>Domain</dt>
          <dd>
            <RenewalCell site={site} now={now} />
          </dd>
          <dt>Updates</dt>
          <dd>
            <UpdatesCell site={site} />
          </dd>
          {site.findings.length > 0 && (
            <>
              <dt>Findings</dt>
              <dd>
                <FindingList findings={site.findings} reload={reload} />
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
  groupBy,
  onGroupBy,
}: {
  filters: SiteFilters;
  onChange: (f: SiteFilters) => void;
  sites: SiteSummary[];
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
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
      <label css={label}>
        Group by
        <select value={groupBy} onChange={(e) => onGroupBy(e.target.value as GroupBy)} css={field}>
          {GROUP_BYS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
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
  const reloadSites = () => {
    if (sites.state === 'ready') sites.reload();
  };
  const [filters, setFilters] = useState<SiteFilters>(NO_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const chooseGroupBy = (g: GroupBy) => {
    setGroupBy(g);
    saveGroupBy(g);
  };
  const now = sites.state === 'ready' ? sites.loadedAt : 0;
  return (
    <>
      <PageHeading
        title="Sites"
        purpose="Reachability, maintenance findings and monitoring coverage."
      >
        <div css={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {sites.state === 'ready' && (
            <RecheckAll count={recheckable(sites.data.sites)} reload={sites.reload} />
          )}
          <AddSiteLink />
        </div>
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
            const groups = groupSites(sites, groupBy);
            const connected = sites.filter((s) => s.mode === 'connected').length;
            return (
              <>
                <Toolbar
                  filters={filters}
                  onChange={setFilters}
                  sites={all}
                  groupBy={groupBy}
                  onGroupBy={chooseGroupBy}
                />
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
                    <div css={{ '@media (min-width: 761px)': { display: 'none' } }}>
                      {groups.map((g) => (
                        <section key={g.key} aria-label={g.label ?? 'Sites'}>
                          {g.label && <GroupHeading label={g.label} count={g.sites.length} />}
                          <ul css={{ margin: 0, padding: 0, listStyle: 'none' }}>
                            {g.sites.map((site) => (
                              <SiteCard key={site.id} site={site} now={now} reload={reloadSites} />
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
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
                            <th scope="col">Domain</th>
                            <th scope="col">Updates</th>
                          </tr>
                        </thead>
                        {groups.map((g) => (
                          <tbody key={g.key}>
                            {g.label && (
                              <tr>
                                <th scope="colgroup" colSpan={6} css={{ paddingTop: 14 }}>
                                  <GroupHeading label={g.label} count={g.sites.length} />
                                </th>
                              </tr>
                            )}
                            {g.sites.map((site) => (
                              <tr key={site.id}>
                                <td>
                                  {/* The icon is its own column, as tall as the three lines. */}
                                  <div
                                    css={{
                                      display: 'grid',
                                      gridTemplateColumns: '48px minmax(0, 1fr)',
                                      columnGap: 10,
                                      alignItems: 'start',
                                    }}
                                  >
                                    <SiteIcon id={site.id} size={48} />
                                    <div css={{ minWidth: 0 }}>
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
                                        {hostNames[site.hostKind]} ·{' '}
                                        <Watched site={site} now={now} />
                                        {site.tailnetOnly ? ' · private' : ''}
                                      </Muted>
                                      <Findings site={site} reload={reloadSites} />
                                    </div>
                                  </div>
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
                                  <RenewalCell site={site} now={now} />
                                </td>
                                <td>
                                  <UpdatesCell site={site} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        ))}
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
