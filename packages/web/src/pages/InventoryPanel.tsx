// A connected site's Software card: versions, security findings, then core, plugins and themes
// (inactive ones too), what WordPress offers for each, and what wordpress.org says about each
// plugin. Old data always says how old.
import type {
  EndOfLife,
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
import styled from '@emotion/styled';
import { Button, Dot, Muted, Panel, PanelHead, Pill, Table, Time } from '../components/ui';
import { saved } from '../components/toast';
import { remedy, securityGroups } from '../securityGroups';
import { CURRENT_FOR, isOutOfDate, security } from '../siteStatus';

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

/** Findings as a table: what it is, how severe, what fixes it. Stacks on a phone. */
const Findings = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 6px;
  th {
    text-align: left;
    font: 500 11px/1.4 var(--mono);
    color: var(--muted);
    padding: 5px 8px;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  td.n {
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    thead {
      display: none;
    }
    tr,
    td {
      display: block;
    }
    tr {
      border-bottom: 1px solid var(--line);
      padding: 6px 0;
    }
    td {
      border: 0;
      padding: 1px 0;
    }
    td[data-label]::before {
      content: attr(data-label) ': ';
      color: var(--muted);
    }
  }
`;

function FindingsTable({ items }: { items: VulnerabilityMatch[] }) {
  return (
    <Findings>
      <thead>
        <tr>
          <th scope="col">Finding</th>
          <th scope="col">Severity</th>
          <th scope="col">Fixed in</th>
        </tr>
      </thead>
      <tbody>
        {items.map((v) => (
          <tr key={v.id}>
            <td>
              {v.reference ? (
                <a href={v.reference} target="_blank" rel="noreferrer">
                  {v.title}
                </a>
              ) : (
                v.title
              )}
              {v.cve && <Muted>{v.cve}</Muted>}
              {!v.fixedIn && !v.informational && v.remediation && <Muted>{v.remediation}</Muted>}
            </td>
            <td className="n" data-label="Severity">
              {v.informational ? 'Informational' : (v.cvssRating ?? 'Not rated')}
              {v.cvssScore !== null && !v.informational ? ` (${v.cvssScore})` : ''}
            </td>
            <td className="n" data-label="Fixed in">
              {v.fixedIn ?? 'No fix yet'}
            </td>
          </tr>
        ))}
      </tbody>
    </Findings>
  );
}

/** In a table row: a long list of findings is a count; the list itself is under Security. */
function TableSecurity({
  vulnerabilities,
  data,
}: {
  vulnerabilities: VulnerabilityMatch[];
  data: Inventory['vulnerabilityData'];
}) {
  const n = actionable(vulnerabilities);
  if (n <= 2) return <SecurityCell vulnerabilities={vulnerabilities} data={data} />;
  return (
    <div css={{ display: 'grid', gap: 2, justifyItems: 'start' }}>
      <Pill tone="red">
        <Dot /> {n} known
      </Pill>
      <Muted>Listed under Security</Muted>
    </div>
  );
}

/** Where the release line's security support stands, from Kamaji's end-of-life list. */
function SupportNote({ e }: { e: EndOfLife }) {
  const line = `${e.product} ${e.line ?? ''}`.trim();
  if (e.state === 'unknown')
    return <Muted>{line}: not on Kamaji’s end-of-life list, so unknown</Muted>;
  if (e.state === 'supported') return <Muted>Security support until {e.endsOn}</Muted>;
  return (
    <Pill tone={e.state === 'ended' ? 'red' : 'amber'}>
      <Dot />{' '}
      {e.state === 'ended'
        ? `${line} past end of support (${e.endsOn})`
        : `${line} support ends ${e.endsOn}`}
    </Pill>
  );
}

/** Listed only: WordPress never updates them, and Kamaji doesn't look them up or match them. */
function MuPlugins({ muPlugins }: { muPlugins: Inventory['muPlugins'] }) {
  if (!muPlugins.known) return <Muted>{muPlugins.reason}</Muted>;
  if (muPlugins.value.length === 0) return null;
  return (
    <div css={{ overflowX: 'auto' }}>
      <Table>
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

/** A closed inventory list: its name and count, and a line with what's in it and any exception. */
const Row = styled.details`
  border-top: 1px solid var(--line);
  & > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    gap: 4px 12px;
    align-items: baseline;
    flex-wrap: wrap;
    padding: 10px 0;
  }
  & > summary::-webkit-details-marker {
    display: none;
  }
  & > summary::before {
    content: '▸';
    color: var(--muted);
    transition: transform 0.1s;
  }
  &[open] > summary::before {
    transform: rotate(90deg);
  }
  & > summary strong {
    font-weight: 600;
  }
  .count {
    font: 500 12px/1.4 var(--mono);
    color: var(--muted);
  }
  .note {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
  }
  .note .flag {
    color: var(--amber);
  }
  .note .bad {
    color: var(--red);
  }
  & > div {
    padding-bottom: 12px;
  }
`;

const Environment = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 18px;
  div {
    display: grid;
    gap: 2px;
    align-content: start;
    justify-items: start;
  }
  dt {
    font-size: 12px;
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-weight: 600;
  }
  @media (max-width: 640px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a list holds, in its closed line: counts, updates offered, findings. */
function Note({ parts, offers, findings }: { parts: string[]; offers: number; findings: number }) {
  return (
    <span className="note">
      {parts.join(' · ')}
      {' · '}
      {offers > 0 ? (
        <span className="flag">{plural(offers, 'update')} offered</span>
      ) : (
        'No updates offered'
      )}
      {findings > 0 && (
        <>
          {' · '}
          <span className="bad">
            {plural(findings, 'known vulnerability', 'known vulnerabilities')}
          </span>
        </>
      )}
    </span>
  );
}

const actionable = (vs: VulnerabilityMatch[]) => vs.filter((v) => !v.informational).length;

/**
 * A connected site's software: versions and support first, then security findings (actionable
 * ones in full, informational notes one click down), then the plugin, must-use plugin and theme
 * lists, closed, each saying what it holds and any exception.
 */
export function InventoryPanel({
  detail,
  now,
  reload,
}: {
  detail: SiteDetailResponse;
  /** When the detail loaded: the report is aged against it. */
  now: number;
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
    else saved('Report refreshed');
    reload();
  }

  const head = (
    <PanelHead id="software-title" title="Software">
      <Button
        type="button"
        disabled={busy}
        onClick={refresh}
        title="Has WordPress check for updates first, then reports"
      >
        {busy ? 'Asking the site…' : 'Refresh inventory'}
      </Button>
    </PanelHead>
  );
  if (!inventory.known)
    return (
      <Panel aria-labelledby="software-title" id="software">
        {head}
        {error && <FormError>{error}</FormError>}
        <Muted>{inventory.reason}</Muted>
      </Panel>
    );
  const inv = inventory.value;
  const line = security(detail, now);
  const all = [
    ...inv.core.vulnerabilities.map((v) => ({ name: 'WordPress', v })),
    ...inv.plugins.flatMap((p) => p.vulnerabilities.map((v) => ({ name: p.name, v }))),
    ...inv.themes.flatMap((t) => t.vulnerabilities.map((v) => ({ name: t.name, v }))),
  ];
  const groups = securityGroups(inv);
  const notes = all.filter((f) => f.v.informational);
  const pluginFindings = inv.plugins.reduce((n, p) => n + actionable(p.vulnerabilities), 0);
  const themeFindings = inv.themes.reduce((n, t) => n + actionable(t.vulnerabilities), 0);
  const activeTheme = inv.themes.find((t) => t.active);
  const activePlugins = inv.plugins.filter((p) => p.active).length;
  const vd = inv.vulnerabilityData;

  return (
    <Panel aria-labelledby="software-title" id="software">
      {head}
      {inv.lastFailure && (
        <p role="status" css={{ color: 'var(--amber)', fontSize: 12 }}>
          The latest report failed <Time iso={inv.lastFailure.at} />: {inv.lastFailure.problem}.
          Showing the report from <Time iso={inv.reportedAt} />.
        </p>
      )}
      {error && <FormError>{error}</FormError>}
      <Environment>
        <div>
          <dt>WordPress</dt>
          <dd>{inv.core.version}</dd>
          {inv.core.offer && (
            <Pill tone="amber">
              <Dot /> {inv.core.offer.version} offered
            </Pill>
          )}
          <Muted>
            Reported <Time iso={inv.reportedAt} />
            {isOutOfDate(inv.reportedAt, CURRENT_FOR.report, now) && (
              <span css={{ color: 'var(--amber)' }}> · out of date</span>
            )}
          </Muted>
          <Muted>
            Updates checked{' '}
            {inv.wordpressCheckedAt.plugins ? (
              <Time iso={inv.wordpressCheckedAt.plugins} />
            ) : (
              'never'
            )}
          </Muted>
        </div>
        <div>
          <dt>PHP</dt>
          <dd>{inv.php}</dd>
          <SupportNote e={inv.endOfLife.php} />
        </div>
        <div>
          <dt>Database</dt>
          <dd>{inv.database}</dd>
          <SupportNote e={inv.endOfLife.database} />
        </div>
      </Environment>

      <section
        id="security"
        aria-labelledby="security-title"
        css={{
          background: 'var(--soft)',
          borderRadius: 4,
          padding: '10px 12px',
          display: 'grid',
          gap: 6,
        }}
      >
        <h3
          id="security-title"
          css={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        >
          Security
          <Pill tone={line.tone}>
            <Dot /> {line.state}
          </Pill>
        </h3>
        {groups.map((g) => (
          <div key={g.name} css={{ display: 'grid', gap: 2 }}>
            <p css={{ margin: 0 }}>
              <strong>{g.name}</strong>:{' '}
              {plural(g.items.length, 'known vulnerability', 'known vulnerabilities')}
            </p>
            <Muted>{remedy(g)}.</Muted>
            <details open={g.items.length <= 2}>
              <summary>
                {g.items.length <= 2 ? 'Findings' : `All ${g.items.length} findings`}
              </summary>
              <FindingsTable items={g.items} />
            </details>
          </div>
        ))}
        {notes.length > 0 && (
          <details>
            <summary>
              {plural(notes.length, 'informational note')}:{' '}
              {[...new Set(notes.map((n) => n.name))].join(', ')}
            </summary>
            <FindingsTable items={notes.map((n) => n.v)} />
          </details>
        )}
        <Muted>
          {vd.known ? (
            <>
              Wordfence Intelligence, downloaded <Time iso={vd.value.fetchedAt} />
              {vd.value.stale && (
                <span css={{ color: 'var(--amber)' }}>
                  {' '}
                  · stale{vd.value.problem ? `: ${vd.value.problem}` : ''}
                </span>
              )}
              . Must-use plugins aren’t checked.
            </>
          ) : (
            <span css={{ color: 'var(--amber)' }}>{vd.reason}</span>
          )}
        </Muted>
      </section>

      {inv.siteHealth.length > 0 && (
        <div id="site-health" css={{ display: 'grid', gap: 3 }}>
          <h3 css={{ fontSize: 13 }}>Site Health</h3>
          {inv.siteHealth.map((h) => (
            <span key={h.test} css={{ color: 'var(--red)' }}>
              {h.label}
            </span>
          ))}
        </div>
      )}

      <div>
        <Row>
          <summary>
            <strong>Plugins</strong>
            <span className="count">{inv.plugins.length}</span>
            <Note
              parts={[`${activePlugins} active`, `${inv.plugins.length - activePlugins} inactive`]}
              offers={inv.plugins.filter((p) => p.offer).length}
              findings={pluginFindings}
            />
          </summary>
          <div css={{ overflowX: 'auto' }}>
            <Table>
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
                {inv.plugins.map((p) => (
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
                      <TableSecurity vulnerabilities={p.vulnerabilities} data={vd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Row>
        {inv.muPlugins.known ? (
          inv.muPlugins.value.length === 0 ? (
            <Muted css={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
              <strong>Must-use plugins</strong> · None installed
            </Muted>
          ) : (
            <Row>
              <summary>
                <strong>Must-use plugins</strong>
                <span className="count">{inv.muPlugins.value.length}</span>
                <span className="note">Security not checked</span>
              </summary>
              <MuPlugins muPlugins={inv.muPlugins} />
            </Row>
          )
        ) : (
          <Muted css={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
            <strong>Must-use plugins</strong> · {inv.muPlugins.reason}
          </Muted>
        )}
        <Row>
          <summary>
            <strong>Themes</strong>
            <span className="count">{inv.themes.length}</span>
            <Note
              parts={[activeTheme ? `${activeTheme.name} active` : 'None active']}
              offers={inv.themes.filter((t) => t.offer).length}
              findings={themeFindings}
            />
          </summary>
          <div css={{ overflowX: 'auto' }}>
            <Table>
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
                {inv.themes.map((t) => (
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
                      <TableSecurity vulnerabilities={t.vulnerabilities} data={vd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Row>
      </div>
    </Panel>
  );
}
