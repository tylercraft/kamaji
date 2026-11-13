// One site: its unfinished setup to resume, or once done, tabs. Status says what's true now and
// what needs doing (updates to approve); Backups, Inventory and Settings hold the detail.
import { Handshake, SiteBackupsResponse, SiteDetailResponse } from '@kamaji/shared';
import { useState } from 'react';
import { postJson } from '../api';
import { StatusList } from '../components/statusList';
import { Tabs } from '../components/tabs';
import { failed, reason, saved } from '../components/toast';
import {
  Button,
  Grid,
  Muted,
  PageHeading,
  Panel,
  PanelTitle,
  ResourceView,
} from '../components/ui';
import { useLink } from '../router';
import { backups, certificate, fromOutside, homePage, security, updates } from '../siteStatus';
import { useResource, type Resource } from '../useResource';
import { InventoryPanel } from './InventoryPanel';
import { SiteBackupsPanel } from './SiteBackupsPanel';
import {
  Capabilities,
  ConfigureStep,
  ConnectStep,
  InstallSteps,
  RemovePanel,
  Steps,
} from './SiteSetup';
import { SiteUpdatesPanel } from './SiteUpdatesPanel';

function Recheck({ id, reload }: { id: string; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const answer = await postJson(`/api/sites/${id}/handshake`, {}, Handshake);
        setBusy(false);
        if (!answer.ok) failed(`The check didn’t run: ${reason(answer.error)}.`);
        else if (answer.data.result.ok)
          saved(`Connected: Craftish Care ${answer.data.result.hello.plugin} answered`);
        else failed(`Not connected: ${answer.data.result.problem}.`);
        reload();
      }}
      css={{ justifySelf: 'start' }}
    >
      {busy ? 'Checking…' : 'Check the connection again'}
    </Button>
  );
}

/** What's true now: the site's checks, then its backups. */
function Status({
  detail,
  now,
  backupsResource,
}: {
  detail: SiteDetailResponse;
  /** When the detail loaded: checks are aged against it. */
  now: number;
  backupsResource: Resource<SiteBackupsResponse>;
}) {
  const { site } = detail;
  return (
    <Grid columns="repeat(2, minmax(0, 1fr))">
      <Panel aria-labelledby="site-now">
        <PanelTitle id="site-now">Site</PanelTitle>
        <StatusList
          lines={[
            homePage(site, now),
            fromOutside(site, now),
            certificate(site),
            security(detail, now),
            updates(site),
          ]}
        />
        <Muted>Reachable only means the home page answered. Health is all of these together.</Muted>
      </Panel>
      <Panel aria-labelledby="backups-now">
        <PanelTitle id="backups-now">Backups</PanelTitle>
        <ResourceView resource={backupsResource} label="this site’s backups">
          {(b) => (
            <StatusList
              lines={backups(b, backupsResource.state === 'ready' ? backupsResource.loadedAt : now)}
            />
          )}
        </ResourceView>
      </Panel>
    </Grid>
  );
}

function Connection({ detail, reload }: { detail: SiteDetailResponse; reload: () => void }) {
  const { site } = detail;
  return (
    <Panel aria-labelledby="connection">
      <PanelTitle id="connection">Connection</PanelTitle>
      {site.mode === 'connected' && detail.handshake ? (
        <>
          <Capabilities handshake={detail.handshake} detail={detail} />
          <Recheck id={site.id} reload={reload} />
          <Muted>
            <a href={`/api/sites/${site.id}/craftish-care.zip`} download="craftish-care.zip">
              Download this site’s copy of Craftish Care
            </a>
            , with its keys built in, to upload over the installed one (Plugins → Add New Plugin →
            Upload Plugin, then “Replace current with uploaded”).
          </Muted>
        </>
      ) : (
        <>
          <Muted>Monitoring only: uptime and certificate, nothing installed.</Muted>
          {detail.canConnect && (
            <details>
              <summary>Connect with Craftish Care</summary>
              <InstallSteps detail={detail} reload={reload} />
            </details>
          )}
        </>
      )}
    </Panel>
  );
}

export function SitePage({ id }: { id: string }) {
  const detail = useResource(`/api/sites/${id}`, SiteDetailResponse, { pollMs: 60_000 });
  const backupsResource = useResource(
    `/api/sites/${encodeURIComponent(id)}/backups`,
    SiteBackupsResponse,
    { pollMs: 15_000 },
  );
  const back = useLink('/sites');
  return (
    <ResourceView resource={detail} label="the site">
      {(d) => {
        const reload = detail.state === 'ready' ? detail.reload : () => {};
        const { site } = d;
        const connected = site.mode === 'connected';
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
            {site.setup !== 'done' && <RemovePanel detail={d} />}
            {site.setup === 'done' && (
              <Tabs
                label={site.name}
                tabs={[
                  {
                    id: 'status',
                    label: 'Status',
                    panel: () => (
                      <>
                        <Status
                          detail={d}
                          now={detail.state === 'ready' ? detail.loadedAt : 0}
                          backupsResource={backupsResource}
                        />
                        {connected && <SiteUpdatesPanel siteId={site.id} />}
                      </>
                    ),
                  },
                  {
                    id: 'backups',
                    label: 'Backups',
                    panel: () => <SiteBackupsPanel siteId={site.id} backups={backupsResource} />,
                  },
                  ...(connected
                    ? [
                        {
                          id: 'inventory',
                          label: 'Inventory',
                          panel: () => (
                            <InventoryPanel
                              detail={d}
                              now={detail.state === 'ready' ? detail.loadedAt : 0}
                              reload={reload}
                            />
                          ),
                        },
                      ]
                    : []),
                  {
                    id: 'settings',
                    label: 'Settings',
                    panel: () => (
                      <>
                        {/* Connection and Configure side by side, stacked on narrow screens. */}
                        <Grid columns="repeat(2, minmax(0, 1fr))">
                          <Connection detail={d} reload={reload} />
                          <ConfigureStep detail={d} reload={reload} />
                        </Grid>
                        <RemovePanel detail={d} />
                      </>
                    ),
                  },
                ]}
              />
            )}
          </>
        );
      }}
    </ResourceView>
  );
}
