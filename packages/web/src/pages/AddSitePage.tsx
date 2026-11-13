// Add site, step 1: identify. Saved as an unfinished setup straight away, so it can be resumed.
import { HostKind, NewSiteRequest } from '@kamaji/shared';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { Field, Form, FormError, PrimaryButton } from '../components/forms';
import { PageHeading, Panel, PanelTitle } from '../components/ui';
import { useRoute } from '../router';
import { Steps } from './SiteSetup';

const hostOptions: [HostKind, string][] = [
  ['craftish', 'craftish (Linode)'],
  ['kinsta', 'Kinsta'],
  ['wpengine', 'WP Engine'],
  ['other', 'Another host'],
];

const ERRORS: Record<string, string> = {
  exists: 'A site at this address is already in Kamaji, or was removed from it.',
  bad_request: 'Check the name and address: the address needs https:// in front.',
  unreachable: 'Couldn’t reach Kamaji. Nothing was saved.',
};

export function AddSitePage() {
  const { navigate } = useRoute();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const slug = String(form.get('client') ?? '').trim();
    const request = NewSiteRequest.safeParse({
      name: form.get('name'),
      url: String(form.get('url') ?? '').trim(),
      hostKind: form.get('host'),
      clientSlug: slug === '' ? null : slug,
    });
    if (!request.success) {
      setError(ERRORS.bad_request!);
      return;
    }
    setBusy(true);
    const result = await postJson('/api/sites', request.data, z.object({ id: z.string() }));
    setBusy(false);
    if (result.ok) navigate(`/sites/${result.data.id}`);
    else setError(ERRORS[result.error] ?? `Kamaji couldn’t save it (${result.error}).`);
  }

  return (
    <>
      <PageHeading
        title="Add site"
        purpose="Name it, connect it or just watch it, then say what to check."
      />
      <Steps current="identify" />
      <Panel aria-labelledby="identify" css={{ maxWidth: 640, width: '100%' }}>
        <PanelTitle id="identify">Identify</PanelTitle>
        <Form onSubmit={submit} noValidate>
          <Field id="name" label="Name">
            <input id="name" name="name" type="text" required maxLength={80} autoComplete="off" />
          </Field>
          <Field
            id="url"
            label="Address"
            hint="WordPress’s own address for the site, with https://."
          >
            <input
              id="url"
              name="url"
              type="url"
              required
              placeholder="https://example.com"
              aria-describedby="url-hint"
            />
          </Field>
          <Field id="host" label="Host">
            <select id="host" name="host" defaultValue="other">
              {hostOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id="client"
            label="Client record (optional)"
            hint="The client’s folder name in calcifer’s clients/, like minton-homes."
          >
            <input id="client" name="client" type="text" aria-describedby="client-hint" />
          </Field>
          {error && <FormError>{error}</FormError>}
          <PrimaryButton type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save and continue'}
          </PrimaryButton>
        </Form>
      </Panel>
    </>
  );
}
