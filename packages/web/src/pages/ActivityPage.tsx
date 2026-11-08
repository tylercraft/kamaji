import { ActivityResponse, type ActivityEvent } from '@kamaji/shared';
import { useState } from 'react';
import { getJson } from '../api';
import {
  Button,
  Empty,
  Muted,
  PageHeading,
  Panel,
  ResourceView,
  Table,
  Time,
} from '../components/ui';
import { useResource } from '../useResource';

export function ActivityPage() {
  const latest = useResource('/api/activity?limit=50', ActivityResponse, { pollMs: 30_000 });
  const [olderPages, setOlder] = useState<{
    firstId: number | undefined;
    events: ActivityEvent[];
    nextBefore: number | null;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState<'idle' | 'loading' | 'failed'>('idle');

  // Older pages continue from the first page they were loaded under. When new events shift the
  // first page, they're dropped, so the list never shows a gap.
  const firstId = latest.state === 'ready' ? latest.data.events[0]?.id : undefined;
  const older = olderPages?.firstId === firstId ? olderPages : null;

  const loadOlder = async (before: number) => {
    setLoadingOlder('loading');
    try {
      const page = await getJson(`/api/activity?limit=50&before=${before}`, ActivityResponse);
      setOlder({
        firstId,
        events: [...(older?.events ?? []), ...page.events],
        nextBefore: page.nextBefore,
      });
      setLoadingOlder('idle');
    } catch {
      setLoadingOlder('failed');
    }
  };

  return (
    <>
      <PageHeading
        title="Activity"
        purpose="Confirm outcomes or trace what changed before a problem."
      />
      <Panel>
        <ResourceView resource={latest} label="activity">
          {(page) => {
            const events = [...page.events, ...(older?.events ?? [])];
            const nextBefore = older ? older.nextBefore : page.nextBefore;
            if (events.length === 0)
              return (
                <Empty title="Nothing has happened yet">
                  Approvals, runs, check results and restarts are recorded here.
                </Empty>
              );
            return (
              <>
                <Table>
                  <thead>
                    <tr>
                      <th scope="col" css={{ width: 130 }}>
                        When
                      </th>
                      <th scope="col">What happened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id}>
                        <td>
                          <Time iso={event.at} />
                        </td>
                        <td>{event.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {nextBefore !== null && (
                  <div css={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Button
                      type="button"
                      disabled={loadingOlder === 'loading'}
                      onClick={() => void loadOlder(nextBefore)}
                    >
                      {loadingOlder === 'loading' ? 'Loading…' : 'Older'}
                    </Button>
                    {loadingOlder === 'failed' && (
                      <Muted role="alert">Couldn’t load older activity.</Muted>
                    )}
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
