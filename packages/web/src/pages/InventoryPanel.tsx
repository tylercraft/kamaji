// A connected site's inventory: core, plugins and themes (inactive ones too), what WordPress
// offers for each, and what wordpress.org says about each plugin. Old data always says how old.
import type {
  Inventory,
  InventoryPlugin,
  Offer,
  SiteDetailResponse,
  VulnerabilityMatch,
} from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { FormError } from '../components/forms';
import { Button, Dot, Muted, Panel, PanelTitle, Pill, Table, Time } from '../components/ui';

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function OfferCell({ offer }: { offer: Offer | null }) {
  if (!offer) return <Muted>–</Muted>;
  return (
    <div css={{ display: 'grid', gap: 2, justifyItems: 'start' }}>
      <Pill tone="amber">
        <Dot /> {offer.version}
      </Pill>
      {!offer.hasPackage && <Muted>No download: a licence may be missing</Muted>}
    </div>
  );
}

function DirectoryCell({ plugin }: { plugin: InventoryPlugin }) {
  const d = plugin.directory;
  if (!d) return <Muted>Not asked yet</Muted>;
  if (d.status === 'not-listed') return <Muted>Not on wordpress.org</Muted>;
  if (d.status === 'closed')
    return (
      <Pill tone="red">
        <Dot /> Closed{d.closedDate ? ` ${d.closedDate}` : ''}
        {d.reason ? `: ${d.reason}` : ''}
      </Pill>
    );
  if (!d.lastUpdated) return <Muted>Listed</Muted>;
  // Measured from when wordpress.org was asked, so the page doesn't depend on the clock.
  const old = Date.parse(d.checkedAt) - Date.parse(d.lastUpdated) > TWO_YEARS_MS;
  return old ? (
    <Pill tone="amber">
      <Dot /> Not updated since {d.lastUpdated.slice(0, 4)}
    </Pill>
  ) : (
    <Muted>
      Updated <Time iso={d.lastUpdated} />
    </Muted>
  );
}

const yesNo = (v: boolean) => (v ? 'On' : 'Off');

/** Known vulnerabilities for one component. Empty reads as "none known" only when the feed is. */
function SecurityCell({
  vulnerabilities,
  data,
}: {
  vulnerabilities: VulnerabilityMatch[];
  data: Inventory['vulnerabilityData'];
}) {
  if (!data.known) return <Muted>Unknown</Muted>;
  if (vulnerabilities.length === 0)
    return <Muted>{data.value.stale ? 'None known (data stale)' : 'None known'}</Muted>;
  return (
    <div css={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
      {vulnerabilities.map((v) => (
        <div key={v.id} css={{ display: 'grid', gap: 2, justifyItems: 'start' }}>
          <Pill tone={v.informational ? 'neutral' : v.fixedIn ? 'red' : 'amber'}>
            <Dot />{' '}
            {v.informational ? 'Informational' : v.fixedIn ? `Fixed in ${v.fixedIn}` : 'No fix yet'}
            {/* An informational record's CVSS isn't a risk to this site: no severity shown. */}
            {v.cvssRating && !v.informational ? ` · ${v.cvssRating}` : ''}
          </Pill>
          <span css={{ whiteSpace: 'normal', maxWidth: 360 }}>
            {v.reference ? (
              <a href={v.reference} target="_blank" rel="noreferrer">
                {v.title}
              </a>
            ) : (
              v.title
            )}
          </span>
          {!v.fixedIn && !v.informational && v.remediation && (
            <Muted css={{ whiteSpace: 'normal', maxWidth: 360 }}>{v.remediation}</Muted>
          )}
        </div>
      ))}
    </div>
  );
}

/** Listed only: WordPress never updates them, and Kamaji doesn't look them up or match them. */
function MuPlugins({ muPlugins }: { muPlugins: Inventory['muPlugins'] }) {
  const caption = (n?: number) => (
    <caption css={{ textAlign: 'left', fontWeight: 600, padding: '4px 0 8px' }}>
      Must-use plugins{n === undefined ? '' : ` (${n})`}
    </caption>
  );
  if (!muPlugins.known) return <Muted>{muPlugins.reason}</Muted>;
  if (muPlugins.value.length === 0) return null;
  return (
    <div css={{ overflowX: 'auto' }}>
      <Table>
        {caption(muPlugins.value.length)}
        <thead>
          <tr>
            <th scope="col">Plugin</th>
            <th scope="col">Version</th>
            <th scope="col">Security</th>
          </tr>
        </thead>
        <tbody>
          {muPlugins.value.map((p) => (
            <tr key={p.file}>
              <td>
                {p.name}
                <Muted>{p.file}</Muted>
              </td>
              <td>{p.version || <Muted>None given</Muted>}</td>
              <td>
                <Muted>Not checked</Muted>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

export function InventoryPanel({
  detail,
  reload,
}: {
  detail: SiteDetailResponse;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inventory = detail.inventory;

  async function refresh() {
    setBusy(true);
    setError(null);
    const result = await postJson(
      `/api/sites/${detail.site.id}/report`,
      {},
      z.object({ ok: z.boolean() }),
    );
    setBusy(false);
    if (!result.ok || !result.data.ok) setError('The report failed: see the line above.');
    reload();
  }

  return (
    <Panel aria-labelledby="inventory">
      <PanelTitle id="inventory">Inventory</PanelTitle>
      <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button type="button" disabled={busy} onClick={refresh}>
          {busy ? 'Asking the site…' : 'Refresh now'}
        </Button>
        <Muted>Has WordPress check for updates first, then reports.</Muted>
      </div>
      {error && <FormError>{error}</FormError>}
      {!inventory.known ? (
        <Muted>{inventory.reason}</Muted>
      ) : (
        <>
          {inventory.value.lastFailure && (
            <p role="status" css={{ color: 'var(--amber)', fontSize: 12 }}>
              The latest report failed <Time iso={inventory.value.lastFailure.at} />:{' '}
              {inventory.value.lastFailure.problem}. Showing the report from{' '}
              <Time iso={inventory.value.reportedAt} />.
            </p>
          )}
          <dl
            css={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: 'max-content minmax(0, 1fr)',
              gap: '6px 16px',
              fontSize: 12,
              dt: { color: 'var(--muted)' },
              dd: { margin: 0 },
            }}
          >
            <dt>WordPress</dt>
            <dd>
              {inventory.value.core.version}{' '}
              {inventory.value.core.offer && (
                <Pill tone="amber">
                  <Dot /> {inventory.value.core.offer.version} offered
                </Pill>
              )}
            </dd>
            {inventory.value.core.vulnerabilities.length > 0 && (
              <>
                <dt>WordPress security</dt>
                <dd>
                  <SecurityCell
                    vulnerabilities={inventory.value.core.vulnerabilities}
                    data={inventory.value.vulnerabilityData}
                  />
                </dd>
              </>
            )}
            <dt>Vulnerabilities</dt>
            <dd>
              {inventory.value.vulnerabilityData.known ? (
                <>
                  Wordfence Intelligence, downloaded{' '}
                  <Time iso={inventory.value.vulnerabilityData.value.fetchedAt} />
                  {inventory.value.vulnerabilityData.value.stale && (
                    <span css={{ color: 'var(--amber)' }}>
                      {' '}
                      · stale
                      {inventory.value.vulnerabilityData.value.problem
                        ? `: ${inventory.value.vulnerabilityData.value.problem}`
                        : ''}
                    </span>
                  )}
                </>
              ) : (
                <span css={{ color: 'var(--amber)' }}>
                  {inventory.value.vulnerabilityData.reason}
                </span>
              )}
            </dd>
            <dt>PHP</dt>
            <dd>{inventory.value.php}</dd>
            <dt>Database</dt>
            <dd>{inventory.value.database}</dd>
            <dt>Reported</dt>
            <dd>
              <Time iso={inventory.value.reportedAt} />
            </dd>
            <dt>WordPress checked</dt>
            <dd>
              {inventory.value.wordpressCheckedAt.plugins ? (
                <Time iso={inventory.value.wordpressCheckedAt.plugins} />
              ) : (
                'Never'
              )}
            </dd>
            {inventory.value.siteHealth.length > 0 && (
              <>
                <dt>Site Health</dt>
                <dd css={{ display: 'grid', gap: 3 }}>
                  {inventory.value.siteHealth.map((h) => (
                    <span key={h.test} css={{ color: 'var(--red)' }}>
                      {h.label}
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <div css={{ overflowX: 'auto' }}>
            <Table>
              <caption css={{ textAlign: 'left', fontWeight: 600, padding: '4px 0 8px' }}>
                Plugins ({inventory.value.plugins.length})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Plugin</th>
                  <th scope="col">Version</th>
                  <th scope="col">Update</th>
                  <th scope="col">Active</th>
                  <th scope="col">Auto-update</th>
                  <th scope="col">wordpress.org</th>
                  <th scope="col">Security</th>
                </tr>
              </thead>
              <tbody>
                {inventory.value.plugins.map((p) => (
                  <tr key={p.file}>
                    <td>
                      {p.name}
                      <Muted>{p.file}</Muted>
                    </td>
                    <td>{p.version || <Muted>None given</Muted>}</td>
                    <td>
                      <OfferCell offer={p.offer} />
                    </td>
                    <td>{p.active ? 'Active' : <Muted>Inactive</Muted>}</td>
                    <td>{yesNo(p.autoUpdate)}</td>
                    <td>
                      <DirectoryCell plugin={p} />
                    </td>
                    <td>
                      <SecurityCell
                        vulnerabilities={p.vulnerabilities}
                        data={inventory.value.vulnerabilityData}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <MuPlugins muPlugins={inventory.value.muPlugins} />
          <div css={{ overflowX: 'auto' }}>
            <Table>
              <caption css={{ textAlign: 'left', fontWeight: 600, padding: '4px 0 8px' }}>
                Themes ({inventory.value.themes.length})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Theme</th>
                  <th scope="col">Version</th>
                  <th scope="col">Update</th>
                  <th scope="col">Active</th>
                  <th scope="col">Auto-update</th>
                  <th scope="col">Security</th>
                </tr>
              </thead>
              <tbody>
                {inventory.value.themes.map((t) => (
                  <tr key={t.stylesheet}>
                    <td>
                      {t.name}
                      <Muted>
                        {t.stylesheet}
                        {t.parent ? ` · child of ${t.parent}` : ''}
                      </Muted>
                    </td>
                    <td>{t.version || <Muted>None given</Muted>}</td>
                    <td>
                      <OfferCell offer={t.offer} />
                    </td>
                    <td>{t.active ? 'Active' : <Muted>Inactive</Muted>}</td>
                    <td>{yesNo(t.autoUpdate)}</td>
                    <td>
                      <SecurityCell
                        vulnerabilities={t.vulnerabilities}
                        data={inventory.value.vulnerabilityData}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </Panel>
  );
}
