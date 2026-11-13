import { describe, expect, it } from 'vitest';
import { readExport } from '../updater/backup.js';
import { exportTime } from './exportTime.js';

describe('the export’s time', () => {
  it('reads db-export’s basic format and extended ISO, as UTC', () => {
    expect(exportTime('20261113T004147Z')).toBe('2026-11-13T00:41:47.000Z');
    expect(exportTime('2026-11-13T00:41:47Z')).toBe('2026-11-13T00:41:47.000Z');
    expect(exportTime('2026-11-13T13:41:47+13:00')).toBe('2026-11-13T00:41:47.000Z');
  });

  it('is null for anything else, never a rolled-over date', () => {
    for (const raw of ['', 'not a time', '20261131T000000Z', '20261113T246000Z', '20261113'])
      expect(exportTime(raw)).toBeNull();
  });
});

describe('the export’s answer', () => {
  // The line db-export prints (server-export/db-export), with its basic-format time.
  const line = `{"format":1,"ok":true,"site":"one.test","at":"20261113T004147Z","bytes":52817,"sha256":"${'c'.repeat(64)}"}\n`;

  it('says the time in ISO and keeps what the export answered', () => {
    expect(readExport(line, 0, 'one.test')).toEqual({
      ok: true,
      words:
        'Kamaji exported the database on craftish at 2026-11-13T00:41:47.000Z (52817 bytes, SHA-256 cccccccccccc…)',
      answer: { at: '20261113T004147Z', bytes: 52817, sha256: 'c'.repeat(64) },
    });
  });

  it('refuses another site’s answer and a line that isn’t one', () => {
    expect(readExport(line, 0, 'two.test').ok).toBe(false);
    expect(readExport('Permission denied\n', 255, 'one.test')).toEqual({
      ok: false,
      words: 'The export on craftish didn’t answer as expected (exit 255)',
    });
  });
});
