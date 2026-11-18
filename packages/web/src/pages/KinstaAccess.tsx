// A Kinsta site's SSH access for whole-site backups, in Configure → Backups (server
// sitebackups/kinsta.ts): Kinsta's host, port and user for the site, from MyKinsta's Info page.
// Saving takes a passkey; Test connection doesn't (it only reads), and the backups process, which
// holds the key, answers it within a minute or so. Over 20 GB, the first pull waits for an okay.
// Inside Configure's form, so its own buttons are plain buttons, not a nested form.
import type { KinstaAccess as Access, SiteDetailResponse } from '@kamaji/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { size } from '../bytes';
import { Choices, Field, FormError } from '../components/forms';
import { failed, reason, saved } from '../components/toast';
import { Button, Dot, Muted, Pill, Time } from '../components/ui';

const OK = z.object({ ok: z.literal(true) });
const QUEUED = z.object({ queued: z.literal(true) });
/** How often the page asks again while a test waits for the backups process. */
const POLL_MS = 5_000;

const WORDS: Record<string, string> = {
  bad_request:
    'The host, port or user isn’t one SSH would take: copy them from MyKinsta’s Info page',
  already_requested: 'A test is already waiting for the backups process',
  not_found: 'Save the SSH access first',
};

function TestResult({ access }: { access: Access }) {
  const { test, testPending } = access;
  if (testPending)
    return (
      <Muted role="status">
        Testing: asked <Time iso={testPending} />. The backups process answers within a minute or
        so.
      </Muted>
    );
  if (!test) return <Muted>Not tested yet.</Muted>;
  if (!test.ok)
    return (
      <div css={{ display: 'grid', gap: 4 }}>
        <Pill tone="red" css={{ justifySelf: 'start' }}>
          <Dot /> Test failed
        </Pill>
        <Muted>
          {test.problem}. Tried <Time iso={test.at} />.
        </Muted>
      </div>
    );
  return (
    <div css={{ display: 'grid', gap: 4 }}>
      <Pill tone="green" css={{ justifySelf: 'start' }}>
        <Dot /> Connected
      </Pill>
      <Muted>
        WordPress {test.wordpress} at <code>{test.path}</code>, wp-cli {test.wpCli}. wp-content{' '}
        {size(test.wpContentBytes)}, database {size(test.databaseBytes)}. Tested{' '}
        <Time iso={test.at} />.
      </Muted>
    </div>
  );
}

export function KinstaAccessFields({
  detail,
  reload,
}: {
  detail: SiteDetailResponse;
  reload: () => void;
}) {
  const { site, kinsta } = detail;
  const [host, setHost] = useState(kinsta?.host ?? '');
  const [port, setPort] = useState(kinsta ? String(kinsta.port) : '');
  const [user, setUser] = useState(kinsta?.user ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = kinsta?.testPending ?? null;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, reload]);
  // When a test asked for here comes back, say how it went.
  const waiting = useRef(false);
  const result = kinsta?.test ?? null;
  useEffect(() => {
    if (!waiting.current || pending || !result) return;
    waiting.current = false;
    if (result.ok) saved(`Connected to ${site.name} on Kinsta`);
    else failed(`Kinsta test failed: ${result.problem}`);
  }, [pending, result, site.name]);
  const changed =
    !kinsta || kinsta.host !== host.trim() || String(kinsta.port) !== port || kinsta.user !== user;

  async function act(path: string, body: unknown, schema: z.ZodType, done: string | null) {
    setBusy(true);
    setError(null);
    const result = await postJson(
      `/api/sites/${encodeURIComponent(site.id)}/${path}`,
      body,
      schema,
    );
    setBusy(false);
    if (!result.ok) {
      setError(WORDS[result.error] ?? `Kamaji couldn’t do that (${reason(result.error)}).`);
      return false;
    }
    if (done) saved(done);
    reload();
    return true;
  }
  const save = () =>
    act('kinsta', { host, port: Number(port), user }, OK, `Saved ${site.name}’s Kinsta access`);
  async function test() {
    waiting.current = true;
    if (!(await act('kinsta/test', {}, QUEUED, null))) waiting.current = false;
  }
  const okay = () =>
    act('kinsta/size-ok', {}, OK, `Okayed whole-site backups of ${site.name} at that size`);
  const total = kinsta?.test?.ok ? kinsta.test.wpContentBytes + kinsta.test.databaseBytes : 0;

  return (
    <Choices>
      <legend>Kinsta SSH access</legend>
      <Muted>
        From MyKinsta, the site’s Info page, under SFTP/SSH: the host, port and username. Kamaji
        connects with its own key, added to your MyKinsta profile; there’s no password to give it.
      </Muted>
      <div
        css={{
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          '@media (max-width: 520px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
        }}
      >
        <Field id="kinsta-host" label="Host">
          <input
            id="kinsta-host"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field id="kinsta-port" label="Port">
          <input
            id="kinsta-port"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      </div>
      <Field id="kinsta-user" label="Username">
        <input
          id="kinsta-user"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
      </Field>
      <div css={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          type="button"
          disabled={busy || !changed || !host || !port || !user}
          onClick={() => void save()}
        >
          Save access
        </Button>
        <Button
          type="button"
          disabled={busy || !kinsta || changed || pending !== null}
          onClick={() => void test()}
        >
          {pending ? 'Testing…' : 'Test connection'}
        </Button>
      </div>
      {error && <FormError>{error}</FormError>}
      {kinsta && <TestResult access={kinsta} />}
      {kinsta?.test?.ok && kinsta.blocked?.includes('20 GB') && (
        <div css={{ display: 'grid', gap: 6 }}>
          <Muted>
            That’s {size(total)}, over 20 GB. A pull that size takes a while and fills the
            repository Arq copies off-site. Okay it to let the first pull go.
          </Muted>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void okay()}
            css={{ justifySelf: 'start' }}
          >
            Okay {size(total)}
          </Button>
        </div>
      )}
      {kinsta?.sizeOk && (
        <Muted>
          Okayed at {size(kinsta.sizeOk.bytes)} by {kinsta.sizeOk.by}{' '}
          <Time iso={kinsta.sizeOk.at} />.
        </Muted>
      )}
    </Choices>
  );
}
