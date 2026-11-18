// The site's Rollback, under its latest run (ops/rollback-plan.md): what Roll back would put back
// and from when, or why it isn't offered; the dialog, with the database box and its warning; how
// the latest rollback or undo went; and Undo while the site is as the rollback left it. Each is
// asked for with the passkey; the backups process does it, and the toast says when it's done.
import { SiteRollbackResponse } from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { FormError, PrimaryButton } from '../components/forms';
import { saved } from '../components/toast';
import { Button, Dot, Muted, Pill, Time } from '../components/ui';
import { ago, itemLine, latestWords, rollbackPollMs } from '../rollbackView';
import { useResource } from '../useResource';

const QUEUED = z.object({ queued: z.literal(true) });

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
    saved(done);
  }
  const close = () => {
    setOpen(null);
    setWithDatabase(false);
    setError(null);
  };
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
              onChange={(e) => setWithDatabase(e.target.checked)}
              aria-describedby="rollback-database"
            />
            <span>
              <strong>Also put back the database</strong>
            </span>
          </label>
          <p id="rollback-database" css={withDatabase ? warn : { margin: 0 }}>
            {withDatabase ? (
              <>
                Everything written to the database since <Time iso={offer.databaseAt} /> (
                {ago(offer.databaseAt, now)}) is lost: orders, form entries, new users, comments,
                and any settings changed since. Kamaji counts them before it changes anything, and
                says how many. Leave this off unless the site is broken without it.
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
              disabled={busy}
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
