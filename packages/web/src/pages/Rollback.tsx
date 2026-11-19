// The site's Rollback, under its latest run (ops/rollback-plan.md): what Roll back would put back
// and from when, or why it isn't offered; the dialog, with the database box and its warning; how
// the latest rollback or undo went; and Undo while the site is as the rollback left it. Each is
// signed with the passkey every time; the backups process does it, and the toast says when it's
// done. Ticking the database box first asks for a count of what it would lose, read only, and
// Roll back waits for the numbers (or for the count to fail, which leaves the kinds only).
import { RollbackCountView, SiteRollbackResponse } from '@kamaji/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { getJson, postJson } from '../api';
import { FormError, PrimaryButton } from '../components/forms';
import { saved } from '../components/toast';
import { Button, Dot, Muted, Pill, Time } from '../components/ui';
import { ago, countsWords, itemLine, latestWords, rollbackPollMs } from '../rollbackView';
import { useResource } from '../useResource';

const QUEUED = z.object({ queued: z.literal(true) });
const COUNT_QUEUED = z.object({ queued: z.literal(true), id: z.string() });
/** The backups process may be part way through a site's backup before it gets to the count. */
const COUNT_WAIT_MS = 3 * 60_000;
const COUNT_POLL_MS = 2_000;

type Counting =
  | { state: 'counting' }
  | { state: 'done'; view: RollbackCountView }
  | { state: 'failed'; problem: string | null };

/** The database box's count: asked for when it's ticked, followed until it's in. */
function useCount(path: string) {
  const [counting, setCounting] = useState<Counting | null>(null);
  // Each start or stop moves this on, so an answer to an earlier one is dropped.
  const run = useRef({ n: 0 });
  useEffect(() => {
    const box = run.current;
    return () => {
      box.n++;
    };
  }, []);

  async function start(batchId: string) {
    const n = ++run.current.n;
    const current = () => run.current.n === n;
    setCounting({ state: 'counting' });
    const asked = await postJson(`${path}/count`, { batchId }, COUNT_QUEUED);
    if (!current()) return;
    if (!asked.ok) {
      setCounting({ state: 'failed', problem: WORDS[asked.error] ?? null });
      return;
    }
    const until = Date.now() + COUNT_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, COUNT_POLL_MS));
      if (!current()) return;
      let view: RollbackCountView;
      try {
        view = await getJson(
          `${path}/count/${encodeURIComponent(asked.data.id)}`,
          RollbackCountView,
        );
      } catch {
        continue;
      }
      if (!current()) return;
      if (view.state === 'done') return setCounting({ state: 'done', view });
      if (view.state === 'failed') return setCounting({ state: 'failed', problem: view.problem });
    }
    if (current()) setCounting({ state: 'failed', problem: 'it didn’t come back in time' });
  }
  function stop() {
    run.current.n++;
    setCounting(null);
  }
  return { counting, start, stop };
}

const WORDS: Record<string, string> = {
  not_offered: 'It isn’t offered any more; the reason is below',
  stale: 'The site changed since this loaded; look again',
};

const Section = ({ children }: { children: React.ReactNode }) => (
  <section
    aria-labelledby="rollback"
    css={{ display: 'grid', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}
  >
    <h3 id="rollback" css={{ fontSize: 13 }}>
      Rollback
    </h3>
    {children}
  </section>
);

const warn = { margin: 0, color: 'var(--amber)' } as const;

export function RollbackSection({ siteId }: { siteId: string }) {
  const path = `/api/sites/${encodeURIComponent(siteId)}/rollback`;
  const resource = useResource(path, SiteRollbackResponse, { pollMs: rollbackPollMs });
  const [open, setOpen] = useState<'rollback' | 'undo' | null>(null);
  const [withDatabase, setWithDatabase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = useCount(path);
  if (resource.state !== 'ready') return null;
  const { offer, why, latest, undo, undoWhy } = resource.data;
  const now = resource.loadedAt;

  async function ask(to: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);
    const result = await postJson(to, body, QUEUED);
    setBusy(false);
    if (resource.state === 'ready') resource.reload();
    if (!result.ok) {
      setError(WORDS[result.error] ?? `Kamaji couldn’t ask for it (${result.error}).`);
      return;
    }
    setOpen(null);
    setWithDatabase(false);
    count.stop();
    saved(done);
  }
  const close = () => {
    setOpen(null);
    setWithDatabase(false);
    count.stop();
    setError(null);
  };
  const counting = withDatabase ? count.counting : null;
  const status = latest ? latestWords(latest) : null;

  return (
    <Section>
      {latest && status && (
        <div css={{ display: 'grid', gap: 4 }}>
          <div css={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill tone={status.tone}>
              <Dot /> {status.label}
            </Pill>
            <Time iso={latest.finishedAt ?? latest.requestedAt} />
          </div>
          <Muted>{status.detail}</Muted>
          {latest.warnings.map((w) => (
            <p key={w} css={warn}>
              {w}.
            </p>
          ))}
        </div>
      )}

      {open === 'rollback' && offer ? (
        <div role="group" aria-labelledby="rollback-dialog" css={{ display: 'grid', gap: 8 }}>
          <h4 id="rollback-dialog" css={{ fontSize: 13, margin: 0 }}>
            Roll back to before the run on <Time iso={offer.runApprovedAt} />
          </h4>
          <div>
            Puts back:
            <ul css={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {offer.items.map((i) => (
                <li key={`${i.type}:${i.name}`}>{itemLine(i)}</li>
              ))}
            </ul>
          </div>
          <Muted>
            From the whole-site backup of <Time iso={offer.snapshotAt} />,{' '}
            {ago(offer.snapshotAt, now)}.
          </Muted>
          <label css={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={withDatabase}
              onChange={(e) => {
                setWithDatabase(e.target.checked);
                if (e.target.checked) void count.start(offer.batchId);
                else count.stop();
              }}
              aria-describedby="rollback-database"
            />
            <span>
              <strong>Also put back the database</strong>
            </span>
          </label>
          <p id="rollback-database" css={withDatabase ? warn : { margin: 0 }} aria-live="polite">
            {withDatabase ? (
              <>
                Everything written to the database since <Time iso={offer.databaseAt} /> (
                {ago(offer.databaseAt, now)}) is lost
                {counting?.state === 'done' ? (
                  <>
                    : <strong>{countsWords(counting.view.counts!)}</strong>, along with form entries
                    and any settings changed since.
                  </>
                ) : (
                  <>: orders, form entries, new users, comments, and any settings changed since.</>
                )}{' '}
                {counting?.state === 'counting' && 'Counting them on the site… '}
                {counting?.state === 'failed' &&
                  `Kamaji couldn’t count them${counting.problem ? ` (${counting.problem})` : ''}. `}
                Leave this off unless the site is broken without it.
              </>
            ) : (
              <>
                The database is left as it is. An update that changed a plugin’s tables may not run
                cleanly on the older version; the checks afterwards will say.
              </>
            )}{' '}
            {withDatabase &&
              (offer.databaseFrom === 'export'
                ? 'It comes from the database export taken just before the update.'
                : 'It comes from the whole-site backup.')}
          </p>
          {offer.majorCore && !withDatabase && (
            <p css={warn}>
              This puts WordPress back a major version, and the update may have upgraded the
              database. Older WordPress usually runs on it, but not always.
            </p>
          )}
          <Muted>
            Before changing anything, Kamaji saves the site’s database as it is now and moves the
            current files aside, so this can be undone for 14 days. The site shows WordPress’s
            maintenance page for about a minute.
          </Muted>
          {error && <FormError>{error}</FormError>}
          <div css={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PrimaryButton
              type="button"
              disabled={busy || counting?.state === 'counting'}
              onClick={() =>
                void ask(
                  path,
                  { batchId: offer.batchId, withDatabase },
                  'Rollback asked for: the backups process takes it within a minute or so',
                )
              }
            >
              Roll back with passkey
            </PrimaryButton>
            <Button type="button" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : open === 'undo' && undo ? (
        <div role="group" aria-labelledby="undo-dialog" css={{ display: 'grid', gap: 8 }}>
          <h4 id="undo-dialog" css={{ fontSize: 13, margin: 0 }}>
            Undo the rollback
          </h4>
          <Muted>
            Puts back the files the rollback replaced, as the run left them: the copies kept on the
            server until <Time iso={undo.until} />.
          </Muted>
          {undo.canDatabase && (
            <>
              <label css={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={withDatabase}
                  onChange={(e) => setWithDatabase(e.target.checked)}
                  aria-describedby="undo-database"
                />
                <span>
                  <strong>Also put back the database as it was before the rollback</strong>
                </span>
              </label>
              {withDatabase && (
                <p id="undo-database" css={warn}>
                  Everything written to the database since the rollback is lost.
                </p>
              )}
            </>
          )}
          {error && <FormError>{error}</FormError>}
          <div css={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PrimaryButton
              type="button"
              disabled={busy}
              onClick={() =>
                void ask(
                  `${path}/undo`,
                  { rollbackId: undo.rollbackId, withDatabase },
                  'Undo asked for: the backups process takes it within a minute or so',
                )
              }
            >
              Undo with passkey
            </PrimaryButton>
            <Button type="button" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {offer ? (
            <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {offer.prominent ? (
                <PrimaryButton type="button" onClick={() => setOpen('rollback')}>
                  Roll back…
                </PrimaryButton>
              ) : (
                <Button type="button" onClick={() => setOpen('rollback')}>
                  Roll back…
                </Button>
              )}
              <Muted>
                Restore point: whole-site backup, <Time iso={offer.snapshotAt} /> (
                {ago(offer.snapshotAt, now)}).
              </Muted>
            </div>
          ) : (
            why && <Muted>{why}.</Muted>
          )}
          {undo ? (
            <div>
              <Button type="button" onClick={() => setOpen('undo')}>
                Undo rollback…
              </Button>
            </div>
          ) : (
            undoWhy && latest?.kind === 'rollback' && <Muted>Undo: {undoWhy}.</Muted>
          )}
        </>
      )}
    </Section>
  );
}
