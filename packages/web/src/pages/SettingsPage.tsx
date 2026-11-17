// Kamaji's own settings. For now one: the weekly update time. Whole-site backups run at 03:00 in
// each site's time zone on the last night before it, and at it Kamaji rechecks every site and
// sends "Ready to update". It approves nothing.
import { SettingsResponse, type UpdateTime } from '@kamaji/shared';
import { useState, type FormEvent } from 'react';
import { postJson } from '../api';
import { Field, Form, FormError, PrimaryButton } from '../components/forms';
import { failed, reason, saved } from '../components/toast';
import { Muted, PageHeading, Panel, PanelTitle, ResourceView } from '../components/ui';
import { useResource } from '../useResource';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    timeZone: 'Pacific/Auckland',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });

function UpdateTimeForm({ data, reload }: { data: SettingsResponse; reload: () => void }) {
  const [time, setTime] = useState<UpdateTime>(data.updateTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await postJson('/api/settings/update-time', time, SettingsResponse);
    setBusy(false);
    if (!result.ok) {
      const why = `Not saved: ${reason(result.error)}.`;
      setError(why);
      failed(why);
      return;
    }
    saved(`Update time: ${WEEKDAYS[time.weekday]} ${hour(time.hour)}`);
    reload();
  }
  return (
    <Form onSubmit={submit}>
      <div css={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Field id="update-day" label="Day">
          <select
            id="update-day"
            value={time.weekday}
            onChange={(e) => setTime({ ...time, weekday: Number(e.target.value) })}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field id="update-hour" label="Time (NZ)">
          <select
            id="update-hour"
            value={time.hour}
            onChange={(e) => setTime({ ...time, hour: Number(e.target.value) })}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hour(h)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Muted>Next: {when(data.nextUpdateAt)}.</Muted>
      {error && <FormError>{error}</FormError>}
      <div>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
    </Form>
  );
}

export function SettingsPage() {
  const settings = useResource('/api/settings', SettingsResponse);
  return (
    <>
      <PageHeading title="Settings" purpose="How Kamaji runs." />
      <Panel aria-labelledby="update-time">
        <PanelTitle id="update-time">Update time</PanelTitle>
        <Muted css={{ marginBottom: 10 }}>
          When you update each week. On the night before, each site with whole-site backups is
          backed up at 03:00 in its own time zone, a quiet hour for its visitors. At this time
          Kamaji rechecks every connected site and sends “Ready to update”: each site’s backup and
          the updates waiting. It approves nothing itself.
        </Muted>
        <ResourceView resource={settings} label="the settings">
          {(data) => (
            <UpdateTimeForm
              key={`${data.updateTime.weekday}-${data.updateTime.hour}`}
              data={data}
              reload={settings.state === 'ready' ? settings.reload : () => {}}
            />
          )}
        </ResourceView>
      </Panel>
    </>
  );
}
