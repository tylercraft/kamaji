import { ServersResponse } from '@kamaji/shared';
import { Empty, Muted, PageHeading, Panel, Pill, ResourceView, Table } from '../components/ui';
import { useResource } from '../useResource';

export function ServersPage() {
  const servers = useResource('/api/servers', ServersResponse, { pollMs: 60_000 });
  return (
    <>
      <PageHeading
        title="Servers"
        purpose="Resolve infrastructure issues and plan server maintenance."
      />
      <Panel>
        <ResourceView resource={servers} label="servers">
          {({ servers }) =>
            servers.length === 0 ? (
              <Empty title="No servers yet">
                craftish, molcajete and Calcifer’s own jobs join with monitoring: security packages,
                restarts, failed services and job errors, and disk. Kamaji recommends; patching and
                restarts stay yours.
              </Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th scope="col">Server</th>
                    <th scope="col">Read through</th>
                    <th scope="col">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((server) => (
                    <tr key={server.id}>
                      <td>
                        <strong css={{ fontWeight: 600 }}>{server.name}</strong>
                        <Muted>{server.address}</Muted>
                      </td>
                      <td>{server.kind === 'linux-ssh' ? 'Report over SSH' : 'This Mac'}</td>
                      <td>
                        <Pill>Not checked yet</Pill>
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
