// An issue's next step, wherever an issue is listed: no warning without something to do. A
// recheck is a button that reruns the check (the server clears the issue if it passes); anything
// Kamaji can't check again says what to look at, and Dismiss hides it until something new
// happens. Dismiss takes a passkey (postJson asks for one when the server wants it), then none for
// ten minutes in this browser (app.ts, DISMISS_STEP); Undo never does.
import type { IssueAction } from '@kamaji/shared';
import { useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { useLink } from '../router';
import { failed, reason, saved } from './toast';
import { Button } from './ui';

const ANY = z.unknown();

function InternalLink({ href, label }: { href: string; label: string }) {
  const link = useLink(href);
  return <a {...link}>{label}</a>;
}

/** Runs one write: busy while it goes, a toast after, then `onDone` so the list reloads. */
function useWrite(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  async function write(path: string, body: unknown, done: string, words: string) {
    setBusy(true);
    const result = await postJson(path, body, ANY);
    setBusy(false);
    if (result.ok) saved(done);
    else failed(`${words}: ${reason(result.error)}`);
    onDone();
  }
  return { busy, write };
}

export function IssueStep({
  id,
  action,
  onDone,
}: {
  id: string;
  action: IssueAction;
  onDone: () => void;
}) {
  const { busy, write } = useWrite(onDone);
  if (action.type === 'recheck') {
    return (
      <div>
        <Button
          type="button"
          disabled={busy}
          onClick={() =>
            write(action.path, action.body, action.asked, `${action.label} didn’t run`)
          }
        >
          {busy ? 'Asking…' : action.label}
        </Button>
      </div>
    );
  }
  return (
    <div css={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span css={{ fontSize: 12 }}>
        {action.href ? <InternalLink href={action.href} label={action.text} /> : action.text}
      </span>
      <Button
        type="button"
        disabled={busy}
        title="Hides it until something new happens. Needs a passkey, then none for 10 minutes on this device."
        onClick={() =>
          write(`/api/issues/${encodeURIComponent(id)}/dismiss`, {}, 'Dismissed', 'Not dismissed')
        }
      >
        {busy ? 'Dismissing…' : 'Dismiss'}
      </Button>
    </div>
  );
}

/** Undo, on a dismissed issue: it shows again. */
export function UndoDismiss({ id, onDone }: { id: string; onDone: () => void }) {
  const { busy, write } = useWrite(onDone);
  return (
    <Button
      type="button"
      disabled={busy}
      onClick={() =>
        write(`/api/issues/${encodeURIComponent(id)}/undismiss`, {}, 'Shown again', 'Not undone')
      }
    >
      {busy ? 'Undoing…' : 'Undo'}
    </Button>
  );
}
