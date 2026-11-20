// The updater's own record of the rule versions it has seen signed (Tyler, 2026-11-20), kept in
// its home (~/.kamaji-updater), not the database. Without it, an edit to the database could bring
// back an older version of a rule: by deleting the newer versions' rows, or by moving an older
// version's signed approval into a newer version's place, or into another rule (version 1 is
// signed before the rule has an id). So for each rule, the highest version whose signature held,
// and for each signature, the rule and version it was first seen as. A run of an older version, or
// of a signature seen in another place, doesn't run.
//
// It only knows what it has seen: the updater notes every signed version each time it starts and
// before each run, and the app starts it after each rule is signed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { RuleApproval } from './check.js';

const Seen = z.object({
  /** Rule id → the highest version the updater has seen signed. */
  highest: z.record(z.string(), z.number().int().min(1)),
  /** An approval's fingerprint → "<rule id> <version>", where it was first seen. */
  slots: z.record(z.string(), z.string()),
});
export type Seen = z.infer<typeof Seen>;

export interface RuleVersions {
  read: () => Seen | { problem: string };
  write: (seen: Seen) => void;
}

const EMPTY: Seen = { highest: {}, slots: {} };

/** The record in a file of its own: read fresh each time, written whole and renamed into place. */
export function fileVersions(path: string): RuleVersions {
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
        return { problem: 'the updater’s record of rule versions can’t be read' };
      }
      try {
        return Seen.parse(JSON.parse(text));
      } catch {
        return { problem: 'the updater’s record of rule versions is unreadable' };
      }
    },
    write: (seen) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(seen, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

/** For tests: the same record, in memory. */
export function memoryVersions(start: Seen = EMPTY): RuleVersions & { seen: () => Seen } {
  let seen = structuredClone(start);
  return {
    read: () => structuredClone(seen),
    write: (next) => (seen = structuredClone(next)),
    seen: () => structuredClone(seen),
  };
}

const fingerprint = (approval: string) => createHash('sha256').update(approval).digest('base64url');
const slot = (ruleId: string, version: number) => `${ruleId} ${version}`;

/**
 * Notes every version in the database whose signature holds and that the record doesn't know
 * yet. A signature already seen in another place is left out: the run check refuses it.
 */
export function noteVersions(db: Db, approval: RuleApproval, record: RuleVersions): void {
  const seen = record.read();
  if ('problem' in seen) return;
  let changed = false;
  const rows = db.prepare('SELECT rule_id, version, approval FROM rule_versions').all();
  for (const row of rows) {
    const ruleId = String(row.rule_id);
    const version = Number(row.version);
    const print = fingerprint(String(row.approval));
    if (seen.slots[print] !== undefined) continue;
    if (!approval(ruleId, version).ok) continue;
    seen.slots[print] = slot(ruleId, version);
    seen.highest[ruleId] = Math.max(seen.highest[ruleId] ?? 0, version);
    changed = true;
  }
  if (changed) record.write(seen);
}

/**
 * Why this version of the rule mustn't run, going by the updater's own record, or null; then the
 * record has it. Called after its signature was checked (rules/check.ts, ruleRunProblem).
 */
export function versionProblem(
  db: Db,
  record: RuleVersions,
  ruleId: string,
  version: number,
): string | null {
  const seen = record.read();
  if ('problem' in seen) return seen.problem;
  const row = db
    .prepare('SELECT approval FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, version);
  if (!row) return 'no such rule version';
  const print = fingerprint(String(row.approval));
  const was = seen.slots[print];
  if (was !== undefined && was !== slot(ruleId, version))
    return 'its signature was first seen as another version or rule';
  const highest = seen.highest[ruleId] ?? 0;
  if (version < highest)
    return `version ${version} is older than version ${highest}, which the updater has seen signed`;
  if (was === undefined || version > highest) {
    seen.slots[print] = slot(ruleId, version);
    seen.highest[ruleId] = Math.max(highest, version);
    record.write(seen);
  }
  return null;
}
