// Passkeys (TY-170): which ones Kamaji accepts for approvals and other changes to sites, and how
// to add one. Kamaji never stores a passkey itself: the page makes the line, and Tyler adds it to
// a file only root can change on the mini, so nothing else running there can add its own.
import { PasskeysResponse } from '@kamaji/shared';
import { useState } from 'react';
import { Field, FormError, PrimaryButton } from '../components/forms';
import { Muted, PageHeading, Panel, PanelTitle, ResourceView, Table } from '../components/ui';
import { createPasskey } from '../passkey';
import { useResource } from '../useResource';

const FILE = '/etc/kamaji/passkeys';

const Command = ({ n, children }: { n: number; children: string }) => (
  <li css={{ display: 'grid', gap: 4 }}>
    <span>Step {n}, on the mini:</span>
    <pre
      css={{
        margin: 0,
        padding: '8px 10px',
        background: 'var(--sunken, var(--panel))',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        overflowX: 'auto',
        fontSize: 12,
      }}
    >
      <code>{children}</code>
    </pre>
  </li>
);

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function Create({ rpId, here }: { rpId: string; here: boolean }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  // The button stays live with no name: a disabled one looks live on iOS, and a tap that does
  // nothing says nothing. Asking for the name, and moving to it, does.
  async function create() {
    if (label.trim() === '') {
      setError('Name it first.');
      document.getElementById('passkey-label')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const made = await createPasskey(rpId, label.trim());
    setBusy(false);
    if (made.ok) setLine(made.line);
    else setError(made.problem);
  }
  return (
    <Panel aria-labelledby="passkey-new">
      <PanelTitle id="passkey-new">Add a passkey</PanelTitle>
      {!here ? (
        <Muted>
          Open Kamaji at its own address to make one: a passkey belongs to {rpId}, so it can’t be
          made from here.
        </Muted>
      ) : (
        <>
          <Muted>
            On this phone or computer. It’s kept by the device (and iCloud Keychain, if that’s on),
            and asks for Touch ID or Face ID each time it’s used. Kamaji only accepts it once you’ve
            added the line below on the mini, which takes your password there.
          </Muted>
          <Field
            id="passkey-label"
            label="Name it"
            hint="Which device, so you can tell them apart."
          >
            <input
              id="passkey-label"
              value={label}
              maxLength={60}
              onChange={(e) => {
                setLabel(e.target.value);
                if (error === 'Name it first.') setError(null);
              }}
              aria-describedby={error ? 'passkey-error' : 'passkey-label-hint'}
              placeholder="Tyler’s iPhone"
            />
          </Field>
          <PrimaryButton
            type="button"
            disabled={busy}
            onClick={create}
            css={{ justifySelf: 'start' }}
          >
            Create a passkey on this device
          </PrimaryButton>
          {error && (
            <span id="passkey-error">
              <FormError>{error}</FormError>
            </span>
          )}
        </>
      )}
      {line && (
        <ol css={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 10 }} aria-label="Install it">
          <Command n={1}>
            /usr/bin/sudo /usr/bin/install -d -m 755 -o root -g wheel /etc/kamaji
          </Command>
          <Command n={2}>
            {`echo ${shellQuote(line)} | /usr/bin/sudo /usr/bin/tee -a ${FILE} > /dev/null`}
          </Command>
          <li>Reload this page: the passkey shows above once Kamaji reads it.</li>
        </ol>
      )}
    </Panel>
  );
}

export function PasskeysPage() {
  const passkeys = useResource('/api/passkeys', PasskeysResponse);
  return (
    <>
      <PageHeading
        title="Passkeys"
        purpose="Approving updates, carrying on, backups and changes to a site's setup each need one."
      />
      <ResourceView resource={passkeys} label="passkeys">
        {(data) => {
          const here = window.location.hostname === data.rpId;
          return (
            <>
              <Panel aria-labelledby="passkeys-installed">
                <PanelTitle id="passkeys-installed">Accepted</PanelTitle>
                {data.installed.length === 0 ? (
                  <Muted role="status" css={{ color: 'var(--amber)', overflowWrap: 'anywhere' }}>
                    None yet ({data.problem ?? 'no passkeys'}), so approvals and other changes to
                    sites wait until one is added.
                  </Muted>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <th scope="col">Passkey</th>
                        <th scope="col">To take it out, on the mini</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.installed.map((p) => (
                        <tr key={p.id}>
                          <td>
                            {p.label}
                            <Muted>
                              <code>{p.id.slice(0, 12)}…</code>
                            </Muted>
                          </td>
                          <td>
                            <code css={{ fontSize: 12, wordBreak: 'break-all' }}>
                              {`/usr/bin/sudo /usr/bin/sed -i '' '/"id":"${p.id}"/d' ${FILE}`}
                            </code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                <Muted>
                  Kamaji reads them from {FILE} on the mini, a file only root can change, so nothing
                  else running there can add one. Lost a device? Add a passkey from another one,
                  then take the lost one out.
                </Muted>
              </Panel>
              <Create rpId={data.rpId} here={here} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
