import { OverviewResponse } from '@kamaji/shared';
import { Empty, PageHeading, Panel, ResourceView } from '../components/ui';
import { useResource } from '../useResource';

export function UpdatesPage() {
  const overview = useResource('/api/overview', OverviewResponse, { pollMs: 60_000 });
  return (
    <>
      <PageHeading
        title="Updates"
        purpose="Review changes and their evidence, then approve maintenance."
      />
      <Panel>
        <ResourceView resource={overview} label="updates">
          {({ updatesWaiting, sites }) =>
            updatesWaiting.known ? null : (
              <Empty title={`Unknown: ${updatesWaiting.reason.toLowerCase()}`}>
                {sites.connected === 0
                  ? 'Updates come from what a site running Craftish Care reports. No site does yet, so Kamaji can’t say what’s waiting. That isn’t the same as nothing.'
                  : 'A connected site hasn’t reported its inventory yet. Until it does, what’s waiting is unknown.'}
              </Empty>
            )
          }
        </ResourceView>
      </Panel>
    </>
  );
}
