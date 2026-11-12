import { SitesResponse, type SiteSummary } from '@kamaji/shared';
import { useState } from 'react';
import {
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
import { matchesSite } from '../sitesView';
import { useResource } from '../useResource';

const hostNames: Record<SiteSummary['hostKind'], string> = {
  craftish: 'craftish',
  kinsta: 'Kinsta',
  wpengine: 'WP Engine',
  other: 'Other host',
};

const stateLabels = {
  up: ['Up', 'green'],
  failing: ['Failed once', 'amber'],
  down: ['Down', 'red'],
} as const satisfies Record<string, [string, Tone]>;

function Availability({ site }: { site: SiteSummary }) {
  if (site.setup !== 'done') return <Pill tone="amber">Setup unfinished</Pill>;
  const a = site.availability;
  // Unknown is never "up": until the first check lands, it says why it doesn't know.
  if (!a.known) return <Muted>{a.reason}</Muted>;
  const [label, tone] = stateLabels[a.value.state];
  return (
    <div css={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
      <Pill tone={tone}>
        <Dot /> {label}
      </Pill>
      <Muted>
        {a.value.problem ?? (a.value.responseMs !== null ? `${a.value.responseMs} ms` : '')}
        {' · '}
        <Time iso={a.value.checkedAt} />
      </Muted>
    </div>
  );
}

function Outside({ site }: { site: SiteSummary }) {
  const o = site.outside;
  if (!o.known) return <Muted>{o.reason}</Muted>;
  return (
    <div css={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
      <Pill tone={o.value.ok ? 'green' : 'red'}>
        <Dot /> {o.value.ok ? 'Up' : 'Failing'}
      </Pill>
      <Muted>
        {o.value.problem ? `${o.value.problem} · ` : ''}
        <Time iso={o.value.checkedAt} />
      </Muted>
    </div>
  );
}

function CertificateCell({ site }: { site: SiteSummary }) {
  const c = site.certificate;
  if (!c.known) return <Muted>{c.reason}</Muted>;
  const days = c.value.daysLeft;
  if (days > 14) return <Muted>{days} days left</Muted>;
  return (
    <Pill tone={days <= 7 ? 'red' : 'amber'}>
      <Dot /> {days < 0 ? 'Expired' : `${days} ${days === 1 ? 'day' : 'days'} left`}
    </Pill>
  );
}

function UpdatesCell({ site }: { site: SiteSummary }) {
  if (site.mode !== 'connected') return <Muted>–</Muted>;
  if (!site.updates.known) return <Muted>{site.updates.reason}</Muted>;
  return site.updates.value === 0 ? (
    <Muted>None offered</Muted>
  ) : (
    <Pill tone="amber">
      <Dot /> {site.updates.value} offered
    </Pill>
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

/** Narrows the list on each keystroke; Escape clears it. */
function Filter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      aria-label="Filter sites by name, domain or client"
      placeholder="Filter by name, domain or client"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onChange('');
        }
      }}
      css={{
        font: 'inherit',
        color: 'var(--ink)',
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 3,
        padding: '7px 9px',
        width: '100%',
        maxWidth: 360,
        '&:focus-visible': { outline: '2px solid var(--copper)', outlineOffset: 1 },
      }}
    />
  );
}

export function SitesPage() {
  const sites = useResource('/api/sites', SitesResponse, { pollMs: 60_000 });
  const [typed, setTyped] = useState('');
  return (
    <>
      <PageHeading title="Sites" purpose="Your sites, their health and their connection to Kamaji.">
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
            const sites = all.filter((site) => matchesSite(site, typed));
            return (
              <>
                <Filter value={typed} onChange={setTyped} />
                {sites.length === 0 ? (
                  <Muted role="status">Nothing matches “{typed.trim()}”.</Muted>
                ) : (
                  <div css={{ overflowX: 'auto' }}>
                    <Table>
                      <thead>
                        <tr>
                          <th scope="col">Site</th>
                          <th scope="col">From the mini</th>
                          <th scope="col">From outside</th>
                          <th scope="col">Certificate</th>
                          <th scope="col">Host</th>
                          <th scope="col">Connection</th>
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
                                  {new URL(site.url).host}
                                </a>
                                {site.tailnetOnly ? ' · tailnet only' : ''}
                              </Muted>
                            </td>
                            <td>
                              <Availability site={site} />
                            </td>
                            <td>
                              <Outside site={site} />
                            </td>
                            <td>
                              <CertificateCell site={site} />
                            </td>
                            <td>{hostNames[site.hostKind]}</td>
                            <td>
                              {site.mode === 'connected' ? (
                                <Pill tone="copper">
                                  <Dot /> Craftish Care
                                </Pill>
                              ) : (
                                <Pill>Monitoring only</Pill>
                              )}
                            </td>
                            <td>
                              <UpdatesCell site={site} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </>
            );
          }}
        </ResourceView>
      </Panel>
    </>
  );
}
