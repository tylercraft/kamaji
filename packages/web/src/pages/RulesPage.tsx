// Rules (ops/rules-plan.md): standing approvals for routine updates, each signed with the passkey.
// A rule as a sentence, what it would take at its next run and what it wouldn't with why, its
// warnings, and WordPress's own auto-updates it overlaps (read only). New, edit, pause, sign again
// to resume, delete.
import type { RuleCandidate, RuleSiteOption, RulesResponse, RuleView } from '@kamaji/shared';
import { RulePreview, RuleSaved, RulesResponse as RulesSchema } from '@kamaji/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { postJson } from '../api';
import { Choices, Field, Form, FormError, inputStyle, PrimaryButton } from '../components/forms';
import { saved } from '../components/toast';
import {
  Button,
  Dot,
  Empty,
  Muted,
  PageHeading,
  Panel,
  PanelHead,
  Pill,
  ResourceView,
  Time,
  When,
} from '../components/ui';
import { bodyOf, formOf, NEW_RULE, stateWords, type RuleForm } from '../rulesView';
import { useResource } from '../useResource';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const Ok = z.object({ ok: z.boolean() });

export function RulesPage() {
  const rules = useResource('/api/rules', RulesSchema);
  const [editing, setEditing] = useState<{ rule: RuleView | null } | null>(null);
  return (
    <>
      <PageHeading
        title="Rules"
        purpose="Routine updates Kamaji approves on its own, the way you signed them. Everything else waits for you under Updates."
      />
      <ResourceView resource={rules} label="rules">
        {(data) => {
          const reload = rules.state === 'ready' ? rules.reload : () => {};
          return (
            <>
              {editing ? (
                <RuleEditor
                  data={data}
                  rule={editing.rule}
                  done={() => {
                    setEditing(null);
                    reload();
                  }}
                />
              ) : (
                <Button
                  type="button"
                  onClick={() => setEditing({ rule: null })}
                  css={{ justifySelf: 'start' }}
                >
                  New rule
                </Button>
              )}
              {data.rules.length === 0 && !editing && (
                <Panel>
                  <Empty title="No rules: every update waits for you">
                    A rule approves what it matches at the update time, an hour after “Ready to
                    update” so you can pause it, with the usual backup, checks, screenshots and one
                    site first.
                  </Empty>
                </Panel>
              )}
              {data.rules.map((r) => (
                <RulePanel
                  key={r.id}
                  rule={r}
                  edit={() => setEditing({ rule: r })}
                  reload={reload}
                />
              ))}
              {data.notAllowed.length > 0 && (
                <Panel aria-labelledby="not-allowed">
                  <PanelHead id="not-allowed" title="Sites no rule can name" />
                  <ul css={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                    {data.notAllowed.map((s) => (
                      <li key={s.id}>
                        {s.name}: <Muted as="span">{s.why}</Muted>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function RulePanel({
  rule,
  edit,
  reload,
}: {
  rule: RuleView;
  edit: () => void;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = stateWords(rule);
  const act = async (path: string, done: string) => {
    setBusy(true);
    setError(null);
    const result = await postJson(path, {}, Ok);
    setBusy(false);
    if (result.ok) saved(done);
    else setError('That didn’t go through. Try again.');
    reload();
  };
  const resume = async () => {
    setBusy(true);
    setError(null);
    // Resuming is signing the same rule again, as its next version.
    const result = await postJson('/api/rules', { ...rule.body, ruleId: rule.id }, RuleSaved);
    setBusy(false);
    if (result.ok) saved(`Signed again: ${rule.body.name}`);
    else
      setError(
        result.error === 'invalid'
          ? 'It can’t be signed as it is: edit it, then save.'
          : 'It wasn’t signed.',
      );
    reload();
  };
  return (
    <Panel aria-labelledby={`rule-${rule.id}`}>
      <PanelHead id={`rule-${rule.id}`} title={rule.body.name}>
        <Pill tone={state.tone}>
          <Dot /> {state.words}
        </Pill>
      </PanelHead>
      <p css={{ margin: '4px 0' }}>{rule.words}</p>
      <Muted>
        Version {rule.version}, signed <Time iso={rule.signedAt} /> by {rule.signedBy}.
        {rule.nextAt && (
          <>
            {' '}
            Next run <When iso={rule.nextAt} />.
          </>
        )}
      </Muted>
      {rule.paused && (
        <p role="status" css={{ color: rule.paused.by === 'kamaji' ? 'var(--red)' : undefined }}>
          Paused <Time iso={rule.paused.at} />
          {rule.paused.by === 'kamaji' ? ' by Kamaji' : ''}: {rule.paused.reason}. Sign it again to
          resume.
        </p>
      )}
      {rule.warnings.map((w) => (
        <p key={w} css={{ color: 'var(--amber)', margin: '2px 0', fontSize: 13 }}>
          {w}
        </p>
      ))}
      {rule.lastRun && (
        <Muted>
          Last run <Time iso={rule.lastRun.at} />: {rule.lastRun.words}.
        </Muted>
      )}
      <h3 css={{ fontSize: 12, margin: '10px 0 4px' }}>
        What it would take at its next run, going by what Kamaji knows now
      </h3>
      <WouldTake takes={rule.takes} misses={rule.misses} />
      {rule.autoUpdates.length > 0 && (
        <p css={{ color: 'var(--amber)', fontSize: 13 }}>
          WordPress auto-updates these on its own as well, without Kamaji’s backup or checks:{' '}
          {rule.autoUpdates.map((a) => `${a.name} on ${a.siteName}`).join('; ')}. Turn them off in
          wp-admin to leave it to the rule.
        </p>
      )}
      <div css={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        {rule.paused ? (
          <Button type="button" disabled={busy} onClick={resume}>
            Sign again and resume
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy}
            onClick={() => act(`/api/rules/${rule.id}/pause`, `Paused: ${rule.body.name}`)}
          >
            Pause
          </Button>
        )}
        <Button type="button" disabled={busy} onClick={edit}>
          Edit
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete “${rule.body.name}”? It won’t run again.`))
              void act(`/api/rules/${rule.id}/delete`, `Deleted: ${rule.body.name}`);
          }}
        >
          Delete
        </Button>
      </div>
      {error && <FormError>{error}</FormError>}
    </Panel>
  );
}

/** What a rule takes and what it wouldn't, with why: a signed rule's panel and the editor's preview. */
function WouldTake({ takes, misses }: { takes: RuleCandidate[]; misses: RuleCandidate[] }) {
  return (
    <>
      {takes.length === 0 ? (
        <Muted>Nothing.</Muted>
      ) : (
        <ul css={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {takes.map((t) => (
            <li key={`${t.siteId}-${t.name}`}>
              {t.siteName}: {t.name} {t.from} → {t.to}
            </li>
          ))}
        </ul>
      )}
      {misses.length > 0 && (
        <details css={{ marginTop: 6 }}>
          <summary css={{ fontSize: 12 }}>{misses.length} it wouldn’t take, with why</summary>
          <ul css={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {misses.map((m) => (
              <li key={`${m.siteId}-${m.name}`}>
                {m.siteName}: {m.name} {m.from} → {m.to}: <Muted as="span">{m.why}</Muted>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The editor's preview, asked again a moment after each change: what the rule as written would
 * take at its next run, by the same matcher a signed rule's panel uses. Nothing is saved.
 */
function usePreview(body: unknown): RulePreview | 'asking' | 'failed' | null {
  const [answer, setAnswer] = useState<{ key: string; value: RulePreview | 'failed' } | null>(null);
  const latest = useRef('');
  const key = body === null ? '' : JSON.stringify(body);
  useEffect(() => {
    latest.current = key;
    if (key === '') return;
    const timer = window.setTimeout(() => {
      void postJson('/api/rules/preview', JSON.parse(key), RulePreview).then((result) => {
        if (latest.current === key) setAnswer({ key, value: result.ok ? result.data : 'failed' });
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [key]);
  if (key === '') return null;
  return answer?.key === key ? answer.value : 'asking';
}

function RuleEditor({
  data,
  rule,
  done,
}: {
  data: RulesResponse;
  rule: RuleView | null;
  done: () => void;
}) {
  const [form, setForm] = useState<RuleForm>(rule ? formOf(rule.body) : NEW_RULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }));
  const t = data.updateTime;
  const draft = bodyOf(form, rule?.id ?? null, data.sites, t);
  const preview = usePreview(draft.ok ? draft.body : null);
  const save = async () => {
    const built = bodyOf(form, rule?.id ?? null, data.sites, t);
    if (!built.ok) return setError(built.why);
    setBusy(true);
    setError(null);
    const result = await postJson('/api/rules', built.body, RuleSaved);
    setBusy(false);
    if (result.ok) {
      saved(`Signed: ${built.body.name}`);
      done();
    } else
      setError(
        result.error === 'invalid'
          ? 'Kamaji refused it: reload and look again.'
          : 'It wasn’t signed.',
      );
  };
  const number = (id: keyof RuleForm, label: string, min: number, max: number, hint?: string) => (
    <Field id={`rule-${id}`} label={label} hint={hint}>
      <input
        id={`rule-${id}`}
        type="number"
        min={min}
        max={max}
        value={form[id] as number}
        onChange={(e) =>
          set({ [id]: Math.min(max, Math.max(min, Math.round(Number(e.target.value) || 0))) })
        }
        css={{ ...inputStyle, width: 90 }}
      />
    </Field>
  );
  return (
    <Panel aria-labelledby="rule-editor">
      <PanelHead id="rule-editor" title={rule ? `Edit “${rule.body.name}”` : 'New rule'} />
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field id="rule-name" label="Name">
          <input
            id="rule-name"
            value={form.name}
            maxLength={80}
            onChange={(e) => set({ name: e.target.value })}
            css={inputStyle}
          />
        </Field>
        <Choices>
          <legend>Sites, each named in the rule as it is now</legend>
          {data.sites.length === 0 && <Muted>No site can be in a rule yet.</Muted>}
          {data.sites.map((s: RuleSiteOption) => (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={form.siteIds.includes(s.id)}
                onChange={(e) =>
                  set({
                    siteIds: e.target.checked
                      ? [...form.siteIds, s.id]
                      : form.siteIds.filter((x) => x !== s.id),
                  })
                }
              />
              <span>
                {s.name}{' '}
                <Muted as="span">
                  {s.backup === 'kamaji' ? 'Kamaji’s whole-site backups' : 'the host’s backups'}
                </Muted>
              </span>
            </label>
          ))}
        </Choices>
        <Choices>
          <legend>Covers</legend>
          <label>
            <input
              type="checkbox"
              checked={form.plugins}
              onChange={(e) => set({ plugins: e.target.checked })}
            />
            Plugins
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.themes}
              onChange={(e) => set({ themes: e.target.checked })}
            />
            Themes
          </label>
        </Choices>
        <Choices>
          <legend>Kind of change (never a major version, never WordPress itself)</legend>
          {(
            [
              ['patch', 'Patch only: 1.2.3 → 1.2.4'],
              ['minor', 'Patch or minor: 1.2.3 → 1.3.0'],
              ['security', 'Security fixes only'],
            ] as const
          ).map(([value, words]) => (
            <label key={value}>
              <input
                type="radio"
                name="rule-change"
                checked={form.change === value}
                onChange={() => set({ change: value })}
              />
              {words}
            </label>
          ))}
        </Choices>
        <Field
          id="rule-only"
          label="Only these (slugs; empty for any)"
          hint="As WordPress names them, like wordpress-seo."
        >
          <input
            id="rule-only"
            value={form.only}
            onChange={(e) => set({ only: e.target.value })}
            css={inputStyle}
          />
        </Field>
        <Field id="rule-leave-out" label="Leave out (slugs)">
          <input
            id="rule-leave-out"
            value={form.leaveOut}
            onChange={(e) => set({ leaveOut: e.target.value })}
            css={inputStyle}
          />
        </Field>
        {number('waitDays', 'Days after wordpress.org releases it', 0, 30)}
        {number('securityWaitDays', 'Days, for a security fix', 0, 30)}
        {number('perSite', 'Most updates a site', 1, 20)}
        {number('sites', 'Most sites a run', 1, 20)}
        <section aria-labelledby="rule-preview" aria-live="polite">
          <h3 id="rule-preview" css={{ fontSize: 12, margin: '6px 0 4px' }}>
            What it would take at its next run, going by what Kamaji knows now
          </h3>
          {preview === null ? (
            <Muted>{!draft.ok && draft.why}</Muted>
          ) : preview === 'asking' ? (
            <Muted>Looking…</Muted>
          ) : preview === 'failed' ? (
            <Muted>Kamaji couldn’t say just now.</Muted>
          ) : (
            <>
              {preview.problem && (
                <p css={{ color: 'var(--amber)', margin: '2px 0', fontSize: 13 }}>
                  It can’t be signed as it is: {preview.problem}.
                </p>
              )}
              <Muted>
                Its next run: <When iso={preview.at} />.
              </Muted>
              <WouldTake takes={preview.takes} misses={preview.misses} />
            </>
          )}
        </section>
        <Muted>
          It runs at the update time, {WEEKDAYS[t.weekday]} {String(t.hour).padStart(2, '0')}:00,
          set out with “Ready to update” and started an hour later. Saving signs it with your
          passkey; the updater checks that signature before every run.
        </Muted>
        <div css={{ display: 'flex', gap: 10 }}>
          <PrimaryButton type="submit" disabled={busy}>
            {busy ? 'Signing…' : 'Sign and save'}
          </PrimaryButton>
          <Button type="button" onClick={done} disabled={busy}>
            Cancel
          </Button>
        </div>
        {error && <FormError>{error}</FormError>}
      </Form>
    </Panel>
  );
}
