import { SitesResponse, type Site } from '@kamaji/shared';
import { Dot, Empty, Muted, PageHeading, Panel, Pill, ResourceView, Table } from '../components/ui';
import { useResource } from '../useResource';

const hostNames: Record<Site['hostKind'], string> = {
  craftish: 'craftish',
  kinsta: 'Kinsta',
  wpengine: 'WP Engine',
  other: 'Other host',
};

function SiteState({ site }: { site: Site }) {
  if (site.setup !== 'done') return <Pill tone="amber">Setup unfinished</Pill>;
  if (site.pausedAt) return <Pill>Paused</Pill>;
  // Availability arrives with the checks (M2). Until then it's unknown, never "up".
  return <Pill>Not checked yet</Pill>;
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
              <Table>
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Host</th>
                    <th scope="col">Connection</th>
                    <th scope="col">Availability</th>
                    <th scope="col">Updates</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map((site) => (
                    <tr key={site.id}>
                      <td>
                        <strong css={{ fontWeight: 600 }}>{site.name}</strong>
                        <Muted>{new URL(site.url).host}</Muted>
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
                        <SiteState site={site} />
                      </td>
                      <td>
                        <Muted>
                          {site.mode === 'connected' ? 'Unknown: no inventory yet' : 'Not managed'}
                        </Muted>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </ResourceView>
      </Panel>
    </>
  );
}
