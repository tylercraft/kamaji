// Add site's steps 2 and 3, the handshake's answer, and Remove (calcifer explore/kamaji.md,
// "Adding and managing a site"). Kamaji never installs the plugin: it offers the zip, then makes
// its first signed request.
import styled from '@emotion/styled';
import {
  BackupExpectation,
  ConfigureSiteRequest,
  Handshake,
  RemoveSiteResponse,
  type HostKind,
  type SiteBackupSchedule,
  type SiteDetailResponse,
} from '@kamaji/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { Choices, Field, Form, FormError, PrimaryButton } from '../components/forms';
import { failed, reason, saved } from '../components/toast';
import { Button, Dot, Muted, Panel, PanelTitle, Pill, Time } from '../components/ui';
import { useRoute } from '../router';

const OK = z.object({ ok: z.literal(true) });

const STEPS = [
  ['identify', 'Identify'],
  ['connect', 'Connect'],
  ['configure', 'Configure'],
] as const;

const StepList = styled.ol`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font: 11px/1.4 var(--mono);
  color: var(--muted);
  li[aria-current='step'] {
    color: var(--ink);
    font-weight: 600;
  }
`;

export function Steps({ current }: { current: 'identify' | 'connect' | 'configure' | 'done' }) {
  const at = STEPS.findIndex(([step]) => step === current);
  return (
    <StepList aria-label="Setup steps">
      {STEPS.map(([step, label], i) => (
        <li key={step} aria-current={step === current ? 'step' : undefined}>
          {i + 1}. {label}
          {current === 'done' || i < at ? ' ✓' : ''}
        </li>
      ))}
    </StepList>
  );
}

const BLOCKERS: Record<string, string> = {
  below_floor: 'WordPress or PHP is older than Craftish Care supports (WordPress 6.6, PHP 8.1)',
  file_mods_disallowed: 'the site doesn’t allow file changes (DISALLOW_FILE_MODS)',
  filesystem_not_direct: 'the filesystem needs FTP or SSH details, which the plugin never holds',
  plugins_not_writable: 'the plugins folder isn’t writable',
  themes_not_writable: 'the themes folder isn’t writable',
  core_not_writable: 'WordPress’s own folder isn’t writable',
};

const SSH: Record<HostKind, string> = {
  craftish: 'Yes, Tyler’s own server (used for exports before updates, from M4)',
  kinsta: 'Kinsta offers SSH with wp-cli (not used yet)',
  wpengine: 'WP Engine offers SSH with wp-cli (not used yet)',
  other: 'Unknown for this host',
};

export const BACKUPS: Record<BackupExpectation, string> = {
  kamaji: 'Kamaji exports the database on craftish first',
  host: 'Handled by the host',
  client: 'Handled by the client',
  tyler: 'Tyler confirms before each run',
};

const Facts = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 7px 16px;
  font-size: 12px;
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** What the site supports, from the handshake. A gap is a fact about the site, not a failed setup. */
export function Capabilities({
  handshake,
  detail,
}: {
  handshake: Handshake;
  detail: SiteDetailResponse;
}) {
  const { result } = handshake;
  if (!result.ok)
    return (
      <div css={{ display: 'grid', gap: 6 }}>
        <Pill tone="red" css={{ justifySelf: 'start' }}>
          <Dot /> Not connected
        </Pill>
        <p role="status">{result.problem}.</p>
        <Muted>
          Tried <Time iso={handshake.at} />.
        </Muted>
      </div>
    );
  const { hello } = result;
  const caps = hello.capabilities;
  return (
    <Facts>
      <Fact label="Reporting">
        {caps.can_report ? 'Yes: versions, offered updates and Site Health' : 'No'}
      </Fact>
      <Fact label="Updating">
        {caps.can_update ? (
          'Yes: only what you approve under Updates'
        ) : (
          <span css={{ color: 'var(--amber)' }}>
            No: {caps.update_blockers.map((b) => BLOCKERS[b] ?? b).join('; ')}. The site stays
            monitoring and reporting only.
          </span>
        )}
      </Fact>
      <Fact label="SSH">{SSH[detail.site.hostKind]}</Fact>
      <Fact label="Backups">
        {detail.backupExpectation
          ? BACKUPS[detail.backupExpectation]
          : detail.site.setup === 'done'
            ? 'Not set yet: choose it under Configure'
            : 'Chosen in step 3'}
      </Fact>
      <Fact label="Versions">
        WordPress {hello.wordpress}, PHP {hello.php}, Craftish Care {hello.plugin}
        {hello.multisite && (
          <Muted css={{ color: 'var(--amber)' }}>Multisite: not supported in this version</Muted>
        )}
      </Fact>
      <Fact label="Auto-updates">
        {caps.auto_updates.all_disabled
          ? 'Turned off for the whole site'
          : `Allowed for ${
              [caps.auto_updates.plugins && 'plugins', caps.auto_updates.themes && 'themes']
                .filter(Boolean)
                .join(' and ') || 'neither plugins nor themes'
            }`}
      </Fact>
      {caps.maintenance.present && (
        <Fact label="Maintenance">
          <span css={{ color: 'var(--red)' }}>
            A .maintenance file is present
            {caps.maintenance.age_seconds !== null &&
              `, ${Math.round(caps.maintenance.age_seconds / 60)} min old`}
          </span>
        </Fact>
      )}
      {caps.wp_cron_disabled && <Fact label="WP-Cron">Off on this site</Fact>}
      <Fact label="Loopback">
        {caps.loopback.ok ? 'Works' : 'Blocked: background updates will need a retry'}
      </Fact>
      <Fact label="Checked">
        <Time iso={handshake.at} />
      </Fact>
    </Facts>
  );
}

/**
 * Runs a write and shows how it went. A failure always shows in the panel. With `toasts`, the
 * result is a toast as well (for a save that changes nothing on the page).
 */
function useAction(toasts?: { saved: string; failed: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<{ ok: boolean; error?: string }>,
    words: Record<string, string> = {},
  ) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      if (toasts) saved(toasts.saved);
    } else if (toasts) {
      // In the panel too: a toast fades, and a failure has to stay until it's fixed.
      const why = words[result.error ?? ''] ?? reason(result.error ?? '');
      failed(`${toasts.failed}: ${why}.`);
      setError(`${toasts.failed}: ${why}.`);
    } else {
      setError(words[result.error ?? ''] ?? `Kamaji couldn’t do that (${result.error}).`);
    }
    return result.ok;
  };
  return { busy, error, run };
}

/** Step 2: Craftish Care, or monitoring only. */
export function ConnectStep({
  detail,
  reload,
}: {
  detail: SiteDetailResponse;
  reload: () => void;
}) {
  const { site } = detail;
  const { busy, error, run } = useAction();
  const mode = (m: 'connected' | 'monitoring') =>
    run(() => postJson(`/api/sites/${site.id}/mode`, { mode: m }, OK), {
      not_set_up: 'This Kamaji has no Craftish Care keys, so it can only monitor.',
    }).then((ok) => ok && reload());

  if (site.mode !== 'connected')
    return (
      <Panel aria-labelledby="connect">
        <PanelTitle id="connect">Connect</PanelTitle>
        <p>
          Connect through Craftish Care for versions and updates, or watch the site from outside
          only: uptime and certificate, nothing installed.
        </p>
        <div css={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <PrimaryButton
            type="button"
            disabled={busy || !detail.canConnect}
            onClick={() => mode('connected')}
          >
            Connect with Craftish Care
          </PrimaryButton>
          <Button type="button" disabled={busy} onClick={() => mode('monitoring')}>
            Monitoring only
          </Button>
        </div>
        {!detail.canConnect && (
          <Muted>This Kamaji has no Craftish Care keys yet, so it can only monitor.</Muted>
        )}
        {error && <FormError>{error}</FormError>}
      </Panel>
    );

  return (
    <Panel aria-labelledby="connect">
      <PanelTitle id="connect">Connect with Craftish Care</PanelTitle>
      <InstallSteps detail={detail} reload={reload}>
        <Button type="button" onClick={() => mode('monitoring')}>
          Use monitoring only instead
        </Button>
      </InstallSteps>
      {error && <FormError>{error}</FormError>}
    </Panel>
  );
}

/**
 * The zip, the install, and the first signed request: step 2 for a new site, and the way a site
 * already set up as monitoring only connects (it becomes connected once the handshake succeeds).
 */
export function InstallSteps({
  detail,
  reload,
  children,
}: {
  detail: SiteDetailResponse;
  reload: () => void;
  children?: ReactNode;
}) {
  const { site } = detail;
  const { busy, error, run } = useAction();
  return (
    <>
      <ol css={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
        <li>
          <a href={`/api/sites/${site.id}/craftish-care.zip`} download="craftish-care.zip">
            Download this site’s copy of Craftish Care
          </a>
          . It has Kamaji’s two public keys built in; nothing in it is secret.
        </li>
        <li>
          Install it in wp-admin (Plugins → Add New Plugin → Upload Plugin) and activate it. Or,
          where there’s SSH, upload the zip and run{' '}
          <code>wp plugin install craftish-care.zip --activate</code>.
        </li>
        <li>Check the connection: Kamaji sends its first signed request.</li>
      </ol>
      <div css={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <PrimaryButton
          type="button"
          disabled={busy}
          onClick={() =>
            run(() => postJson(`/api/sites/${site.id}/handshake`, {}, Handshake)).then(reload)
          }
        >
          {busy ? 'Checking…' : 'Check the connection'}
        </PrimaryButton>
        {children}
      </div>
      {error && <FormError>{error}</FormError>}
      {detail.handshake && <Capabilities handshake={detail.handshake} detail={detail} />}
    </>
  );
}

const CONFIGURE_WORDS: Record<string, string> = {
  not_craftish: 'Kamaji’s own backups are on craftish, and this site isn’t hosted there',
  no_consent: 'Tick that the client agreed before turning on whole-site backups of their site',
};

export const SCHEDULES: Record<SiteBackupSchedule, string> = {
  off: 'Off',
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
};

/**
 * Whole-site backups, on craftish sites only: the schedule, whether it's Tyler's own site, and
 * on a client's site the tick that the client agreed (recorded once, with who ticked it and when).
 */
function WholeSiteChoices({
  detail,
  own,
  setOwn,
  schedule,
  setSchedule,
}: {
  detail: SiteDetailResponse;
  own: boolean;
  setOwn: (own: boolean) => void;
  schedule: SiteBackupSchedule;
  setSchedule: (schedule: SiteBackupSchedule) => void;
}) {
  const { consentAt, consentBy } = detail.siteBackups;
  return (
    <Choices>
      <legend>Whole-site backups</legend>
      <Muted>
        Files and a fresh database from craftish, kept encrypted with restic on molcajete: 4 weekly
        and 6 monthly. Arq copies that encrypted repository off-site; Kamaji doesn’t check Arq.
      </Muted>
      {(Object.entries(SCHEDULES) as [SiteBackupSchedule, string][]).map(([value, label]) => (
        <label key={value}>
          <input
            type="radio"
            name="siteBackups"
            value={value}
            checked={schedule === value}
            onChange={() => setSchedule(value)}
          />
          {label}
        </label>
      ))}
      <label>
        <input
          type="checkbox"
          name="own"
          checked={own}
          onChange={(event) => setOwn(event.currentTarget.checked)}
        />
        My own site: there’s no client to ask
      </label>
      {schedule !== 'off' &&
        !own &&
        (consentAt ? (
          <Muted>
            The client agreed: ticked by {consentBy} <Time iso={consentAt} />.
          </Muted>
        ) : (
          <label>
            <input type="checkbox" name="clientAgreed" required />
            The client agreed to whole-site backups of their site
          </label>
        ))}
    </Choices>
  );
}

const POLICY_SHORT: Record<BackupExpectation, string> = {
  kamaji: 'Database exports before updates',
  host: 'The host’s backups before updates',
  client: 'The client’s backups before updates',
  tyler: 'Your confirmation before updates',
};

/** Configure's closed line: the choices as they're saved. */
function configureSummary(detail: SiteDetailResponse): string {
  const policy = detail.backupExpectation
    ? POLICY_SHORT[detail.backupExpectation]
    : 'Backups before updates not decided';
  const whole =
    detail.site.hostKind === 'craftish'
      ? ` · Whole-site backups ${SCHEDULES[detail.siteBackups.schedule].toLowerCase()}`
      : '';
  const notes = detail.notifications === 'digest' ? 'Digest only' : 'Normal notifications';
  return `${policy}${whole} · ${notes}`;
}

const Columns = styled.div`
  display: grid;
  gap: 18px 28px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  & > div {
    display: grid;
    gap: 14px;
    align-content: start;
  }
  h3 {
    font-size: 13px;
  }
  @media (max-width: 760px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

/**
 * Step 3, and later the site page's Configure: the display name (once set up), what to check on
 * the home page, notifications, and both backup choices together: what happens before an update,
 * and scheduled whole-site backups. On the site page it's a closed section, open while the
 * backup choice is still undecided.
 */
export function ConfigureStep({
  detail,
  reload,
  section = false,
}: {
  detail: SiteDetailResponse;
  reload: () => void;
  section?: boolean;
}) {
  const { site } = detail;
  const [own, setOwn] = useState(detail.own);
  const [schedule, setSchedule] = useState(detail.siteBackups.schedule);
  const { busy, error, run } = useAction({
    saved: `Saved ${site.name}’s settings`,
    failed: 'Not saved',
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const backup = String(form.get('backup') ?? '');
    const name = form.get('name');
    const request = ConfigureSiteRequest.parse({
      ...(typeof name === 'string' ? { name } : {}),
      expectedText: String(form.get('expected') ?? '').trim() || null,
      backupExpectation: backup === '' ? null : backup,
      notifications: form.get('notifications') === 'digest' ? 'digest' : 'normal',
      ...(site.hostKind === 'craftish'
        ? { own, siteBackups: schedule, clientAgreed: form.get('clientAgreed') === 'on' }
        : {}),
    });
    if (await run(() => postJson(`/api/sites/${site.id}/configure`, request, OK), CONFIGURE_WORDS))
      reload();
  }
  const fields = (
    <Form onSubmit={submit} css={section ? { maxWidth: 'none' } : undefined}>
      <Columns>
        <div>
          <h3>Site and monitoring</h3>
          {section && (
            <Field
              id="name"
              label="Display name"
              hint="Changes the name in Kamaji only. The domain, connection and history stay as they are."
            >
              <input
                id="name"
                name="name"
                type="text"
                required
                maxLength={80}
                defaultValue={site.name}
                aria-describedby="name-hint"
              />
            </Field>
          )}
          <Field
            id="expected"
            label="Text the home page must contain"
            hint="A word or phrase that’s always there, like the site’s name. Its absence counts as down."
          >
            <input
              id="expected"
              name="expected"
              type="text"
              maxLength={200}
              defaultValue={site.expectedText ?? ''}
              aria-describedby="expected-hint"
            />
          </Field>
          <Choices>
            <legend>Notifications</legend>
            <label>
              <input
                type="radio"
                name="notifications"
                value="normal"
                defaultChecked={detail.notifications === 'normal'}
              />
              Normal: urgent problems at once, the rest in the morning digest
            </label>
            <label>
              <input
                type="radio"
                name="notifications"
                value="digest"
                defaultChecked={detail.notifications === 'digest'}
              />
              Digest only
            </label>
          </Choices>
        </div>
        <div>
          <h3>Backups</h3>
          <Choices>
            <legend>Before each update</legend>
            {(Object.entries(BACKUPS) as [BackupExpectation, string][])
              .filter(([value]) => value !== 'kamaji' || site.hostKind === 'craftish')
              .map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="backup"
                    value={value}
                    defaultChecked={detail.backupExpectation === value}
                  />
                  {label}
                </label>
              ))}
            <label>
              <input
                type="radio"
                name="backup"
                value=""
                defaultChecked={detail.backupExpectation === null}
              />
              Not decided yet: shown as unknown
            </label>
          </Choices>
          {site.hostKind === 'craftish' && (
            <WholeSiteChoices
              detail={detail}
              own={own}
              setOwn={setOwn}
              schedule={schedule}
              setSchedule={setSchedule}
            />
          )}
          {site.hostKind === 'craftish' && (
            <details>
              <summary>What a whole-site backup holds</summary>
              <Muted css={{ marginTop: 6 }}>
                <code>wp-content</code>, <code>.htaccess</code> if there is one, a fresh database
                export and a manifest. Left out: <code>wp-content/cache</code>, <code>upgrade</code>
                , <code>ai1wm-backups</code>, <code>updraft</code>, <code>backups*</code>,{' '}
                <code>wflogs</code> (Wordfence’s live logs) and <code>*.log</code> files.{' '}
                <code>wp-config.php</code> and WordPress’s own files are never read.
              </Muted>
            </details>
          )}
        </div>
      </Columns>
      <Muted>
        {site.setup === 'done'
          ? 'Saving grants no update permission: every update is still approved.'
          : 'Finishing starts the checks. It grants no update permission: every update is still approved.'}
      </Muted>
      {error && <FormError>{error}</FormError>}
      <PrimaryButton type="submit" disabled={busy} css={{ justifySelf: 'start' }}>
        {site.setup === 'done' ? 'Save changes' : 'Finish'}
      </PrimaryButton>
    </Form>
  );
  if (!section)
    return (
      <Panel aria-labelledby="configure">
        <PanelTitle id="configure">Configure</PanelTitle>
        {fields}
      </Panel>
    );
  return (
    <Disclosure id="configure" open={detail.backupExpectation === null}>
      <summary>
        <h2>Configure</h2>
        <span className="note">{configureSummary(detail)}</span>
      </summary>
      <div className="inside">{fields}</div>
    </Disclosure>
  );
}

/** A card that opens: its summary is the heading and a line saying what's inside. */
export const Disclosure = styled.details`
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  & > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    gap: 6px 14px;
    align-items: baseline;
    flex-wrap: wrap;
    padding: 12px 16px;
  }
  & > summary::-webkit-details-marker {
    display: none;
  }
  /* The marker a flex summary loses, turned when open. */
  & > summary::before {
    content: '▸';
    color: var(--muted);
    display: inline-block;
    transition: transform 0.1s;
  }
  &[open] > summary::before {
    transform: rotate(90deg);
  }
  & > summary h2 {
    display: inline;
    font-size: 14px;
    font-weight: 600;
  }
  & > summary .note {
    color: var(--muted);
    font-size: 12px;
    margin-left: auto;
  }
  &[open] > summary {
    border-bottom: 1px solid var(--line);
  }
  .inside {
    padding: 14px 16px 16px;
  }
`;

const REMOVE_WORDS: Record<string, string> = {
  not_confirmed: 'Type the site’s name exactly as shown to remove it.',
};

/**
 * Remove from Kamaji: the live site is untouched; history is kept. On the site page it sits closed
 * at the bottom; the typed name and the plugin forgetting its keys are the same either way.
 */
export function RemovePanel({
  detail,
  closed = false,
}: {
  detail: SiteDetailResponse;
  closed?: boolean;
}) {
  const { site } = detail;
  const { navigate } = useRoute();
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState<RemoveSiteResponse | null>(null);
  const { busy, error, run } = useAction();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let answer: RemoveSiteResponse | null = null;
    const ok = await run(async () => {
      const result = await postJson(
        `/api/sites/${site.id}/remove`,
        { confirm: typed },
        RemoveSiteResponse,
      );
      if (result.ok) answer = result.data;
      return result;
    }, REMOVE_WORDS);
    if (ok) setDone(answer);
  }
  if (done)
    return (
      <Panel aria-labelledby="removed">
        <PanelTitle id="removed">Removed</PanelTitle>
        <p role="status">
          {site.name} is no longer in Kamaji. Its history stays in Activity.
          {done.disconnect === 'done' && ' Craftish Care forgot its keys and answers nothing now.'}
        </p>
        {done.problem && <FormError>Still to do: {done.problem}.</FormError>}
        <Button type="button" onClick={() => navigate('/sites')}>
          Back to Sites
        </Button>
      </Panel>
    );
  const body = (
    <>
      <p>
        Monitoring and maintenance of {site.name} stop. The live site and its content are untouched,
        and its history stays.
        {site.mode === 'connected' && ' Kamaji tells Craftish Care to forget its keys first.'}
      </p>
      <Form onSubmit={submit}>
        <Field id="confirm" label={`Type “${site.name}” to confirm`}>
          <input
            id="confirm"
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </Field>
        {error && <FormError>{error}</FormError>}
        <Button
          type="submit"
          disabled={busy || typed.trim() !== site.name}
          css={{ justifySelf: 'start', borderColor: 'var(--red)', color: 'var(--red)' }}
        >
          {busy ? 'Removing…' : `Remove ${site.name}`}
        </Button>
      </Form>
    </>
  );
  if (closed)
    return (
      <details>
        <summary css={{ color: 'var(--red)', cursor: 'pointer', fontSize: 12, fontWeight: 550 }}>
          Remove site from Kamaji
        </summary>
        <div css={{ display: 'grid', gap: 10, maxWidth: 650, paddingTop: 12 }}>{body}</div>
      </details>
    );
  return (
    <Panel aria-labelledby="remove">
      <PanelTitle id="remove">Remove from Kamaji</PanelTitle>
      {body}
    </Panel>
  );
}
