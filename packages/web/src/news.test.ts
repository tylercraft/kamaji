import type { FinishedRunView } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { runsToToast, runToast } from './news';

const run = (id: string, approvedBy = 'tylercraft@github'): FinishedRunView => ({
  id,
  approvedBy,
  finishedAt: '2026-11-18T07:00:00.000Z',
  lines: [
    '✅ Updated Aleya Hoerlein: Admin Menu Editor 1.15.2 → 1.15.3, checks passed (database export first)',
    '⚠️ **Needs you:** Photogravure is held: no backup evidence.',
  ],
  anchor: `run-${id}-aleyahoerlein-com`,
});

describe('run toasts', () => {
  it('only runs this viewer started, and only ones not already known', () => {
    const known = new Set(['old']);
    expect(
      runsToToast(
        [run('old'), run('mine'), run('theirs', 'someone@else')],
        'tylercraft@github',
        known,
      ).map((r) => r.id),
    ).toEqual(['mine']);
  });

  it('the run’s lines by name, without Discord’s bold', () => {
    expect(runToast(run('x'))).toEqual([
      '✅ Updated Aleya Hoerlein: Admin Menu Editor 1.15.2 → 1.15.3, checks passed (database export first)',
      '⚠️ Needs you: Photogravure is held: no backup evidence.',
    ]);
  });
});
