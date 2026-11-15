// Add site, step 1: identify. Saved as an unfinished setup straight away, so it can be resumed.
// The platform is guessed from the home page once the address is in, and pre-selected; Tyler's own
// choice wins over a guess that comes after it.
import { DetectPlatformResponse, HostKind, NewSiteRequest, type Platform } from '@kamaji/shared';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { Field, Form, FormError, PrimaryButton } from '../components/forms';
import { PageHeading, Panel, PanelTitle } from '../components/ui';
import { useRoute } from '../router';
import { PLATFORM_NAMES } from '../sitesView';
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
  const [platform, setPlatform] = useState<Platform>('wordpress');
  const [chosen, setChosen] = useState(false);
  const [guess, setGuess] = useState<string | null>(null);

  async function detect(raw: string) {
    const url = raw.trim();
    if (chosen || !/^https?:\/\/\S+$/.test(url)) return;
    setGuess('Looking at the home page…');
    const result = await postJson('/api/sites/detect', { url }, DetectPlatformResponse);
    if (!result.ok) return setGuess(null);
    const { platform: found, problem } = result.data;
    if (found) {
      setPlatform((current) => (chosen ? current : found));
      setGuess(`Guessed from the home page: ${PLATFORM_NAMES[found]}.`);
    } else setGuess(`Couldn’t read the home page (${problem ?? 'no answer'}): choose it.`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const slug = String(form.get('client') ?? '').trim();
    const request = NewSiteRequest.safeParse({
      name: form.get('name'),
      url: String(form.get('url') ?? '').trim(),
      hostKind: form.get('host'),
      clientSlug: slug === '' ? null : slug,
      platform,
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
            hint="The site’s address, with https://. For WordPress, its own address."
          >
            <input
              id="url"
              name="url"
              type="url"
              required
              placeholder="https://example.com"
              aria-describedby="url-hint"
              onBlur={(e) => void detect(e.currentTarget.value)}
            />
          </Field>
          <Field
            id="platform"
            label="Platform"
            hint={
              guess ??
              'A static site or an app is monitoring only: no Craftish Care, backups or updates.'
            }
          >
            <select
              id="platform"
              name="platform"
              value={platform}
              onChange={(e) => {
                setChosen(true);
                setPlatform(e.target.value as Platform);
              }}
              aria-describedby="platform-hint"
            >
              {(Object.entries(PLATFORM_NAMES) as [Platform, string][]).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
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
