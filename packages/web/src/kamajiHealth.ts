// Turns /api/status into what the header and Overview say about Kamaji itself.
import type { StatusResponse } from '@kamaji/shared';
import type { Tone } from './components/ui';

export interface HealthLine {
  tone: Tone;
  label: string;
  detail: string;
}

/** A cycle is late once two intervals pass without one starting. */
export function cycleHealth(
  status: StatusResponse,
  now: number = Date.parse(status.now),
): HealthLine {
  const { last, intervalSeconds } = status.cycle;
  const age = (now - Date.parse(last?.startedAt ?? status.startedAt)) / 1000;
  if (age > intervalSeconds * 2)
    return {
      tone: 'red',
      label: 'Cycle late',
      detail: `No cycle has started for ${Math.round(age / 60)} min.`,
    };
  if (!last)
    return { tone: 'neutral', label: 'First cycle pending', detail: 'No check cycle has run yet.' };
  if (last.state === 'failed')
    return { tone: 'red', label: 'Last cycle failed', detail: 'See Activity for the error.' };
  if (last.state === 'interrupted')
    return {
      tone: 'amber',
      label: 'Last cycle interrupted',
      detail: 'It stopped part way and was not retried.',
    };
  if (last.state === 'running')
    return { tone: 'green', label: 'Cycle running', detail: 'A check cycle is running now.' };
  return {
    tone: 'green',
    label: 'Cycle on time',
    detail: `Every ${Math.round(intervalSeconds / 60)} min.`,
  };
}

export function heartbeatHealth(status: StatusResponse): HealthLine {
  const beat = status.heartbeat;
  if (!beat.configured)
    return {
      tone: 'amber',
      label: 'Heartbeat off',
      detail: 'No healthchecks.io ping URL, so nobody notices if Kamaji stops.',
    };
  if (beat.lastOk === null)
    return { tone: 'neutral', label: 'Heartbeat pending', detail: 'No ping sent yet.' };
  if (!beat.lastOk)
    return {
      tone: 'red',
      label: 'Heartbeat failing',
      detail: "The last ping didn't reach healthchecks.io; it will alert if this continues.",
    };
  return {
    tone: 'green',
    label: 'Heartbeat ok',
    detail: 'healthchecks.io is hearing from Kamaji.',
  };
}
