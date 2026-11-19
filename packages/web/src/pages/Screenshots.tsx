// Screenshot checks (ops/screenshots-plan.md, "The UI"): on a run's record, a line and a strip of
// before | after pairs, the changed first, each opening a comparison (before, after and the
// differences side by side, stacked on a phone); on the site's page, the latest set, Take
// screenshots now (no passkey: it changes nothing on the site) and what's hidden or masked.
import {
  comparisonChanged,
  SiteScreenshotsResponse,
  type ComparisonView,
  type RunScreenshots,
  type ShotView,
} from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { FormError, inputStyle, PrimaryButton } from '../components/forms';
import { saved } from '../components/toast';
import { Button, Dot, Muted, Panel, PanelHead, Pill, ResourceView, Time } from '../components/ui';
import { altText, ordered, pageLabel, runSummary, setWords, tileWords } from '../screenshotsView';
import { useResource } from '../useResource';

const QUEUED = z.object({ queued: z.literal(true), id: z.string() });
const SAVED = z.object({ ok: z.literal(true) });
const key = (c: ComparisonView) => `${c.pageUrl} ${c.viewport}`;

const Thumb = ({ shot, when }: { shot: ShotView | null; when: string }) =>
  shot?.thumb ? (
    <img
      src={shot.thumb}
      alt={altText(shot, when)}
      loading="lazy"
      css={{
        width: '100%',
        aspectRatio: shot.viewport === 'mobile' ? '390 / 844' : '1440 / 900',
        objectFit: 'cover',
        objectPosition: 'top',
        border: '1px solid var(--line)',
        borderRadius: 3,
        background: 'var(--soft)',
      }}
    />
  ) : (
    <div
      css={{
        aspectRatio: '1440 / 900',
        border: '1px dashed var(--line)',
        borderRadius: 3,
        display: 'grid',
        placeItems: 'center',
        color: 'var(--muted)',
        fontSize: 11,
      }}
    >
      {shot?.blocked ? 'bot check' : 'no shot'}
    </div>
  );

/** One page and size: its pair of thumbnails and what changed. */
function Tile({ c, open, toggle }: { c: ComparisonView; open: boolean; toggle: () => void }) {
  const changed = comparisonChanged(c);
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={toggle}
      css={{
        display: 'grid',
        gap: 4,
        alignContent: 'start',
        padding: 6,
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        background: 'var(--bg)',
        border: `1px solid ${open ? 'var(--copper)' : 'var(--line)'}`,
        borderRadius: 4,
        cursor: 'pointer',
      }}
    >
      <span css={{ fontSize: 12, fontWeight: 600 }}>
        {pageLabel(c.pageUrl)} <span css={{ color: 'var(--muted)' }}>{c.viewport}</span>
      </span>
      <span css={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <Thumb shot={c.before} when="before" />
        <Thumb shot={c.after} when="after" />
      </span>
      <span css={{ fontSize: 11, color: changed ? 'var(--amber)' : 'var(--muted)' }}>
        {tileWords(c)}
      </span>
    </button>
  );
}

const Column = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <figure css={{ margin: 0, display: 'grid', gap: 4, minWidth: 0 }}>
    <figcaption css={{ fontSize: 12, fontWeight: 600 }}>{title}</figcaption>
    <div
      css={{
        maxHeight: '70vh',
        overflow: 'auto',
        border: '1px solid var(--line)',
        borderRadius: 3,
        background: 'var(--soft)',
      }}
    >
      {children}
    </div>
  </figure>
);

const Full = ({ src, alt }: { src: string | null; alt: string }) =>
  src ? (
    <img src={src} alt={alt} css={{ display: 'block', width: '100%' }} />
  ) : (
    <Muted css={{ padding: 8 }}>None.</Muted>
  );

/** Before, after and the differences side by side; the other size a tab away. */
function Comparison({
  c,
  sizes,
  pick,
  close,
}: {
  c: ComparisonView;
  sizes: ComparisonView[];
  pick: (c: ComparisonView) => void;
  close: () => void;
}) {
  const label = pageLabel(c.pageUrl);
  const heights =
    c.heightBefore !== null && c.heightAfter !== null && c.heightBefore !== c.heightAfter
      ? ` The page went from ${c.heightBefore} to ${c.heightAfter} px tall, so only the first screen was compared.`
      : '';
  return (
    <section
      aria-label={`Comparison of ${label}, ${c.viewport}`}
      css={{ display: 'grid', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}
    >
      <div css={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{label}</strong>
        <div role="group" aria-label="Size" css={{ display: 'flex', gap: 4 }}>
          {sizes.map((s) => (
            <Button
              key={s.viewport}
              type="button"
              aria-pressed={s.viewport === c.viewport}
              onClick={() => pick(s)}
            >
              {s.viewport === 'desktop' ? 'Desktop' : 'Mobile'}
            </Button>
          ))}
        </div>
        <Button type="button" onClick={close} css={{ marginLeft: 'auto' }}>
          Close
        </Button>
      </div>
      <Muted>
        {c.problem
          ? `Not compared: ${c.problem}.`
          : `${tileWords(c)}${c.maskedPct ? `, with ${c.maskedPct}% masked (blue)` : ''}.${heights}`}
        {(c.after?.jsErrors ?? 0) > 0 || (c.after?.failedRequests ?? 0) > 0
          ? ` After: ${c.after?.jsErrors ?? 0} JavaScript errors and ${c.after?.failedRequests ?? 0} failed requests in all.`
          : ''}
        {c.after?.cut ? ' The page is taller than 15,000 px, so it was cut there.' : ''}
        {(c.after?.blockedRequests ?? 0) > 0
          ? ` ${c.after?.blockedRequests} ${c.after?.blockedRequests === 1 ? 'request' : 'requests'} to the mini, the LAN or the tailnet blocked.`
          : ''}
      </Muted>
      <div
        css={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
        }}
      >
        <Column title="Before">
          <Full src={c.before?.image ?? null} alt={c.before ? altText(c.before, 'before') : ''} />
        </Column>
        <Column title="After">
          <Full src={c.after?.image ?? null} alt={c.after ? altText(c.after, 'after') : ''} />
        </Column>
        <Column title="Differences">
          <Full src={c.diff} alt={`Differences: ${label}, ${c.viewport}, changes in red`} />
        </Column>
      </div>
    </section>
  );
}

/** The strip of pairs, and the comparison of the one opened. */
function Comparisons({ comparisons }: { comparisons: ComparisonView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = ordered(comparisons);
  const current = shown.find((c) => key(c) === open) ?? null;
  return (
    <>
      <div
        css={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        }}
      >
        {shown.map((c) => (
          <Tile
            key={key(c)}
            c={c}
            open={key(c) === open}
            toggle={() => setOpen(key(c) === open ? null : key(c))}
          />
        ))}
      </div>
      {current && (
        <Comparison
          c={current}
          sizes={comparisons.filter((c) => c.pageUrl === current.pageUrl)}
          pick={(c) => setOpen(key(c))}
          close={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** On a run's record, under the site's items. */
export function RunScreenshotsView({ shots }: { shots: RunScreenshots }) {
  const summary = runSummary(shots);
  return (
    <div css={{ display: 'grid', gap: 6 }}>
      <p css={{ margin: 0, fontSize: 12 }}>
        <strong>Screenshots:</strong>{' '}
        <span css={{ color: summary.changed ? 'var(--amber)' : 'var(--muted)' }}>
          {summary.words}
        </span>
      </p>
      {shots.comparisons.length > 0 && <Comparisons comparisons={shots.comparisons} />}
    </div>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** What's hidden before each shot and left out of each comparison: a selector a line. */
function Settings({
  siteId,
  settings,
  reload,
}: {
  siteId: string;
  settings: { hide: string[]; mask: string[] };
  reload: () => void;
}) {
  const [hide, setHide] = useState(settings.hide.join('\n'));
  const [mask, setMask] = useState(settings.mask.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    const result = await postJson(
      `/api/sites/${encodeURIComponent(siteId)}/screenshots/settings`,
      { hide: lines(hide), mask: lines(mask) },
      SAVED,
    );
    setBusy(false);
    if (!result.ok) {
      setError(
        result.error === 'bad_request'
          ? 'Up to 20 selectors each, one a line, without { } < or >.'
          : `Kamaji couldn’t save them (${result.error}).`,
      );
      return;
    }
    saved('Screenshot settings saved');
    reload();
  }
  const area = { ...inputStyle, fontFamily: 'var(--mono)', fontSize: 12, width: '100%' };
  return (
    <details>
      <summary css={{ cursor: 'pointer', fontSize: 12 }}>Hidden and masked</summary>
      <div css={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <label css={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Hide before each shot (cookie banners, chat bubbles, popups)
          <textarea rows={3} value={hide} onChange={(e) => setHide(e.target.value)} css={area} />
        </label>
        <label css={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 600 }}>
          Leave out of comparisons (a cart count, a date)
          <textarea rows={3} value={mask} onChange={(e) => setMask(e.target.value)} css={area} />
        </label>
        <Muted>
          CSS selectors, one a line, for every page. Video and frames from other sites are always
          left out, and so is whatever moves on its own between the two “before” rounds.
        </Muted>
        {error && <FormError>{error}</FormError>}
        <div>
          <PrimaryButton type="button" disabled={busy} onClick={save}>
            Save with passkey
          </PrimaryButton>
        </div>
      </div>
    </details>
  );
}

/** On the site's page. */
export function ScreenshotsPanel({ siteId }: { siteId: string }) {
  const path = `/api/sites/${encodeURIComponent(siteId)}/screenshots`;
  const resource = useResource(path, SiteScreenshotsResponse, {
    pollMs: (last) => (last?.pending ? 3_000 : 60_000),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function take() {
    setBusy(true);
    setError(null);
    const result = await postJson(path, {}, QUEUED);
    setBusy(false);
    if (!result.ok) setError(`Kamaji couldn’t ask for them (${result.error}).`);
    if (resource.state === 'ready') resource.reload();
  }
  return (
    <Panel aria-labelledby="screenshots">
      <PanelHead id="screenshots" title="Screenshots">
        <Button
          type="button"
          disabled={busy || (resource.state === 'ready' && resource.data.pending !== null)}
          onClick={take}
        >
          Take screenshots now
        </Button>
      </PanelHead>
      <ResourceView resource={resource} label="screenshots">
        {(data) => (
          <div css={{ display: 'grid', gap: 8 }}>
            {error && <FormError>{error}</FormError>}
            {data.pending && (
              <p role="status" css={{ margin: 0 }}>
                <Pill tone="neutral">
                  <Dot /> {setWords(data.pending)}
                </Pill>
              </p>
            )}
            {data.latest ? (
              <>
                <Muted>
                  {setWords(data.latest)}{' '}
                  <Time iso={data.latest.finishedAt ?? data.latest.requestedAt} />
                  {data.latest.comparisons.length > 0 ? ', compared with the set before it.' : ''}
                </Muted>
                {data.latest.comparisons.length > 0 ? (
                  <Comparisons comparisons={data.latest.comparisons} />
                ) : (
                  <div
                    css={{
                      display: 'grid',
                      gap: 8,
                      gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                    }}
                  >
                    {data.latest.shots.map((s) => (
                      <a
                        key={`${s.pageUrl} ${s.viewport}`}
                        href={s.image ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        css={{ display: 'grid', gap: 4, fontSize: 12, color: 'inherit' }}
                      >
                        <Thumb shot={s} when="taken" />
                        <span>
                          {pageLabel(s.pageUrl)}{' '}
                          <span css={{ color: 'var(--muted)' }}>{s.viewport}</span>
                          {s.problem ? <Muted>{s.problem}</Muted> : null}
                        </span>
                      </a>
                    ))}
                  </div>
                )}
              </>
            ) : (
              !data.pending && (
                <Muted>
                  None yet. A run shoots{' '}
                  {data.pages.length === 1 ? 'the home page' : `these ${data.pages.length} pages`}{' '}
                  just before its first update and just after its last, at 1440 and 390 wide.
                </Muted>
              )
            )}
            <Settings
              key={JSON.stringify(data.settings)}
              siteId={siteId}
              settings={data.settings}
              reload={resource.state === 'ready' ? resource.reload : () => {}}
            />
          </div>
        )}
      </ResourceView>
    </Panel>
  );
}
