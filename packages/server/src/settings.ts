// Kamaji's own settings, set on the Settings page. A setting never saved reads as its default.
import type { Db } from './db.js';
import { DEFAULT_UPDATE_TIME, type UpdateTime } from './sitebackups/schedule.js';

const UPDATE_TIME = 'update-time';

export function readUpdateTime(db: Db): UpdateTime {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(UPDATE_TIME);
  if (!row) return DEFAULT_UPDATE_TIME;
  const value = JSON.parse(String(row.value)) as Partial<UpdateTime>;
  return Number.isInteger(value.weekday) && Number.isInteger(value.hour)
    ? { weekday: Number(value.weekday), hour: Number(value.hour) }
    : DEFAULT_UPDATE_TIME;
}

export function writeUpdateTime(db: Db, time: UpdateTime, at: number, by: string | null): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(UPDATE_TIME, JSON.stringify(time), at, by);
}
