// One site: its unfinished setup to resume, or once done, its connection and Remove.
import { SiteDetailResponse } from '@kamaji/shared';
import { Button, Muted, PageHeading, Panel, PanelTitle, ResourceView } from '../components/ui';
import { useLink } from '../router';
import { useResource } from '../useResource';
import {
  Capabilities,
  ConfigureStep,
  ConnectStep,
  InstallSteps,
  RemovePanel,
  Steps,
} from './SiteSetup';
import { postJson } from '../api';
import { Handshake } from '@kamaji/shared';
import { useState } from 'react';
import { InventoryPanel } from './InventoryPanel';

function Recheck({ id, reload }: { id: string; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await postJson(`/api/sites/${id}/handshake`, {}, Handshake);
        setBusy(false);
        reload();
      }}
      css={{ justifySelf: 'start' }}
    >
      {busy ? 'Checking…' : 'Check the connection again'}
    </Button>
  );
}

export function SitePage({ id }: { id: string }) {
  const detail = useResource(`/api/sites/${id}`, SiteDetailResponse);
  const back = useLink('/sites');
  return (
    <ResourceView resource={detail} label="the site">
      {(d) => {
        const reload = detail.state === 'ready' ? detail.reload : () => {};
        const { site } = d;
        return (
          <>
            <PageHeading
              title={site.name}
              purpose={
                site.setup === 'done'
                  ? new URL(site.url).host
                  : 'Setup unfinished: pick up where you left off.'
              }
            >
              <a {...back}>← Sites</a>
            </PageHeading>
            {site.setup !== 'done' && <Steps current={site.setup} />}
            {site.setup === 'connect' && <ConnectStep detail={d} reload={reload} />}
            {site.setup === 'configure' && (
              <>
                {d.handshake && (
                  <Panel aria-labelledby="connection">
                    <PanelTitle id="connection">Connection</PanelTitle>
                    <Capabilities handshake={d.handshake} detail={d} />
                  </Panel>
                )}
                <ConfigureStep detail={d} reload={reload} />
              </>
            )}
            {site.setup === 'done' && (
              <>
                <Panel aria-labelledby="connection">
                  <PanelTitle id="connection">Connection</PanelTitle>
                  {site.mode === 'connected' && d.handshake ? (
                    <>
                      <Capabilities handshake={d.handshake} detail={d} />
                      <Recheck id={site.id} reload={reload} />
                    </>
                  ) : (
                    <>
                      <Muted>Monitoring only: uptime and certificate, nothing installed.</Muted>
                      {d.canConnect && (
                        <details>
                          <summary>Connect with Craftish Care</summary>
                          <InstallSteps detail={d} reload={reload} />
                        </details>
                      )}
                    </>
                  )}
                </Panel>
                {site.mode === 'connected' && <InventoryPanel detail={d} reload={reload} />}
                <ConfigureStep detail={d} reload={reload} />
              </>
            )}
            <RemovePanel detail={d} />
          </>
        );
      }}
    </ResourceView>
  );
}
