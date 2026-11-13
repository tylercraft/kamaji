// One site: its unfinished setup to resume, or once done, one page. At the top, what's true now
// and what needs a look; then Updates and Backups side by side, Connection and the plugin's zip,
// Software, and Configure and Remove closed at the bottom. Evidence, history and diagnostics are
// one click down; a problem always shows in a section's open part and in "Needs a look".
import { Handshake, SiteBackupsResponse, SiteDetailResponse, type CareHello } from '@kamaji/shared';
import { useState } from 'react';
import { postJson } from '../api';
import { failed, reason, saved } from '../components/toast';
import {
  Button,
  Dot,
  Grid,
  Muted,
  PageHeading,
  Panel,
  PanelHead,
  PanelTitle,
  Pill,
  ResourceView,
  Time,
} from '../components/ui';
import { useLink } from '../router';
import {
  backups,
  certificate,
  CURRENT_FOR,
  fromOutside,
  homePage,
  isOutOfDate,
  security,
  updates,
  type StatusLine,
} from '../siteStatus';
import { useResource, type Resource } from '../useResource';
import { InventoryPanel } from './InventoryPanel';
import { SiteBackupsPanel } from './SiteBackupsPanel';
import { Attention, HealthTiles, needsLook } from './SiteHealth';
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
    >
      {busy ? 'Checking…' : 'Check connection'}
    </Button>
  );
}

/** What in a good handshake deserves a look: the diagnostics open when there's any. */
function capabilityProblems(hello: CareHello): string[] {
  const c = hello.capabilities;
  return [
    !c.can_update && 'Kamaji can’t update this site',
    c.maintenance.present && 'A .maintenance file is present',
    !c.loopback.ok && 'Loopback blocked',
    hello.multisite && 'Multisite isn’t supported',
  ].filter((p): p is string => typeof p === 'string');
}

function Connection({ detail, reload }: { detail: SiteDetailResponse; reload: () => void }) {
  const { site, handshake } = detail;
  if (site.mode !== 'connected' || !handshake)
    return (
      <Panel aria-labelledby="connection">
        <PanelHead id="connection" title="Connection">
          <Pill>Monitoring only</Pill>
        </PanelHead>
        <Muted>Uptime and certificate from outside. Nothing installed on the site.</Muted>
        {detail.canConnect && (
          <details>
            <summary>Connect with Craftish Care</summary>
            <div css={{ display: 'grid', gap: 10, marginTop: 8 }}>
              <InstallSteps detail={detail} reload={reload} />
            </div>
          </details>
        )}
      </Panel>
    );
  const { result } = handshake;
  if (!result.ok)
    return (
      <Panel aria-labelledby="connection">
        <PanelTitle id="connection">Connection</PanelTitle>
        <Capabilities handshake={handshake} detail={detail} />
        <div>
          <Recheck id={site.id} reload={reload} />
        </div>
      </Panel>
    );
  const problems = capabilityProblems(result.hello);
  const inventory = detail.inventory.known ? detail.inventory.value : null;
  const older = inventory !== null && Date.parse(handshake.at) < Date.parse(inventory.reportedAt);
  return (
    <Panel aria-labelledby="connection">
      <PanelHead id="connection" title="Connection">
        <span css={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 550 }}>
          <span css={{ color: 'var(--green)' }}>
            <Dot />
          </span>
          Connected
        </span>
      </PanelHead>
      <Muted>
        {result.hello.capabilities.can_report ? 'Reporting' : 'Not reporting'} ·{' '}
        {result.hello.capabilities.can_update ? 'Updates only as approved' : 'Can’t update'}
      </Muted>
      {problems.length > 0 && (
        <p css={{ margin: 0, color: 'var(--amber)' }}>{problems.join('. ')}.</p>
      )}
      <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Recheck id={site.id} reload={reload} />
        <Muted>
          Last tested <Time iso={handshake.at} />
        </Muted>
      </div>
      <details open={problems.length > 0}>
        <summary>Capabilities and diagnostics</summary>
        <div css={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <Capabilities handshake={handshake} detail={detail} />
          {older && (
            <Muted>
              This test is older than the latest inventory: it saw Craftish Care{' '}
              {result.hello.plugin}, WordPress {result.hello.wordpress}.
            </Muted>
          )}
        </div>
      </details>
    </Panel>
  );
}

/** This site's own copy of the plugin, with Kamaji's public keys built in. */
function PluginZip({ siteId }: { siteId: string }) {
  return (
    <Panel aria-labelledby="plugin-zip">
      <PanelHead id="plugin-zip" title="Craftish Care plugin">
        <Pill>Site-specific zip</Pill>
      </PanelHead>
      <Muted>This site’s copy, with Kamaji’s public keys built in. Nothing in it is secret.</Muted>
      <div>
        <a
          href={`/api/sites/${siteId}/craftish-care.zip`}
          download="craftish-care.zip"
          css={{
            display: 'inline-flex',
            padding: '7px 11px',
            border: '1px solid var(--line)',
            borderRadius: 3,
            background: 'var(--panel)',
            color: 'var(--ink)',
            fontSize: 12,
            fontWeight: 550,
            textDecoration: 'none',
            '&:hover': { borderColor: 'var(--copper)' },
          }}
        >
          Download plugin
        </a>
      </div>
      <details>
        <summary>Installation instructions</summary>
        <Muted css={{ marginTop: 6 }}>
          In wp-admin: Plugins → Add New Plugin → Upload Plugin. Upload the zip, then choose
          “Replace current with uploaded”.
        </Muted>
      </details>
    </Panel>
  );
}

const RANK = { red: 0, amber: 1, copper: 2, neutral: 3, green: 4 } as const;

/** The backups tile: the line that most needs a look, else the first. */
function backupTile(resource: Resource<SiteBackupsResponse>, now: number): StatusLine {
  if (resource.state !== 'ready')
    return {
      label: 'Backups',
      tone: 'neutral',
      state: resource.state === 'error' ? 'Couldn’t load' : 'Loading',
      detail: '',
      at: null,
      outOfDate: false,
    };
  const lines = backups(resource.data, now);
  const worst = [...lines].sort(
    (a, b) => RANK[a.tone] - RANK[b.tone] || Number(b.outOfDate) - Number(a.outOfDate),
  )[0];
  if (!worst)
    return {
      label: 'Backups',
      tone: 'neutral',
      state: 'Nothing recorded',
      detail: '',
      at: null,
      outOfDate: false,
    };
  const look = lines.filter((l) => l.tone === 'red' || l.tone === 'amber');
  if (look.length > 1)
    return {
      ...worst,
      label: 'Backups',
      state: `${look.length} need a look`,
      at: null,
      outOfDate: false,
    };
  return {
    ...worst,
    label: 'Backups',
    state: worst.label === 'Backups' ? worst.state : `${worst.label}: ${worst.state}`,
  };
}

/** Where each line's evidence is on the page. */
const WHERE: Record<string, [string, string]> = {
  Security: ['software', 'See Software'],
  Updates: ['updates', 'See Updates'],
  Backups: ['backups', 'See Backups'],
  'Database export': ['backups', 'See Backups'],
  'Whole-site backup': ['backups', 'See Backups'],
  'Restore check': ['backups', 'See Backups'],
};

function Freshness({ detail, now }: { detail: SiteDetailResponse; now: number }) {
  if (detail.site.mode !== 'connected') return null;
  if (!detail.inventory.known) return <Muted>{detail.inventory.reason}</Muted>;
  const at = detail.inventory.value.reportedAt;
  return (
    <Muted>
      Inventory received <Time iso={at} />
      {isOutOfDate(at, CURRENT_FOR.report, now) && (
        <span css={{ color: 'var(--amber)' }}> · out of date</span>
      )}
    </Muted>
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
        const now = detail.state === 'ready' ? detail.loadedAt : 0;
        const { site } = d;
        const connected = site.mode === 'connected';
        const siteLines = [
          homePage(site, now),
          fromOutside(site, now),
          certificate(site),
          security(d, now),
          updates(site),
        ];
        const backupNow = backupsResource.state === 'ready' ? backupsResource.loadedAt : now;
        const backupAll =
          backupsResource.state === 'ready' ? backups(backupsResource.data, backupNow) : [];
        return (
          <>
            <nav aria-label="Breadcrumb" css={{ fontSize: 12, color: 'var(--muted)' }}>
              <a {...back}>Sites</a> / {site.name}
            </nav>
            <PageHeading
              title={site.name}
              purpose={
                site.setup === 'done' ? (
                  <a href={site.url} target="_blank" rel="noreferrer">
                    {new URL(site.url).host} ↗
                  </a>
                ) : (
                  'Setup unfinished: pick up where you left off.'
                )
              }
            >
              {site.setup === 'done' && (
                <div css={{ display: 'grid', gap: 2, justifyItems: 'end', textAlign: 'right' }}>
                  <span css={{ fontSize: 12, fontWeight: 550 }}>
                    {connected ? 'Craftish Care connected' : 'Monitoring only'}
                  </span>
                  <Freshness detail={d} now={now} />
                </div>
              )}
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
              <>
                <HealthTiles lines={[...siteLines, backupTile(backupsResource, backupNow)]} />
                <Attention lines={needsLook([...siteLines, ...backupAll])} where={WHERE} />
                <Grid columns="repeat(2, minmax(0, 1fr))">
                  <SiteUpdatesPanel siteId={site.id} />
                  <SiteBackupsPanel siteId={site.id} backups={backupsResource} />
                </Grid>
                <Grid columns="repeat(2, minmax(0, 1fr))">
                  <Connection detail={d} reload={reload} />
                  {connected && <PluginZip siteId={site.id} />}
                </Grid>
                {connected && <InventoryPanel detail={d} now={now} reload={reload} />}
                <ConfigureStep detail={d} reload={reload} section />
                <RemovePanel detail={d} closed />
              </>
            )}
          </>
        );
      }}
    </ResourceView>
  );
}
