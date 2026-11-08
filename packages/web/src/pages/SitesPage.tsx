import { SitesResponse, type SiteSummary } from '@kamaji/shared';
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

export function SitesPage() {
  const sites = useResource('/api/sites', SitesResponse, { pollMs: 60_000 });
  return (
    <>
      <PageHeading
        title="Sites"
        purpose="Your sites, their health and their connection to Kamaji."
      />
      <Panel>
        <ResourceView resource={sites} label="sites">
          {({ sites }) =>
            sites.length === 0 ? (
              <Empty title="No sites yet">
                Nothing is being watched. Adding sites comes with monitoring: uptime and
                certificates first, then Craftish Care for inventory and updates.
              </Empty>
            ) : (
              <div css={{ overflowX: 'auto' }}>
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">Site</th>
                      <th scope="col">Availability (from the mini)</th>
                      <th scope="col">Certificate</th>
                      <th scope="col">Host</th>
                      <th scope="col">Connection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sites.map((site) => (
                      <tr key={site.id}>
                        <td>
                          <a
                            href={site.url}
                            target="_blank"
                            rel="noreferrer"
                            css={{ fontWeight: 600, color: 'inherit' }}
                          >
                            {site.name}
                          </a>
                          <Muted>
                            {new URL(site.url).host}
                            {site.tailnetOnly ? ' · tailnet only' : ''}
                          </Muted>
                        </td>
                        <td>
                          <Availability site={site} />
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
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )
          }
        </ResourceView>
      </Panel>
    </>
  );
}
