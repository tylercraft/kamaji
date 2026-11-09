// One job's text for the Servers page: its log tail and its latest crash, read from the files on
// the mini when asked, never stored. Only allowlisted jobs (./jobs.ts) get either text; for the
// rest the log is never opened and the crash shows where it happened, without its message.
import type { JobDetailResponse, MacHealth } from '@kamaji/shared';
import type { Db } from '../db.js';
import { readState } from '../state.js';
import { HEALTH_STATE } from './check.js';
import { latestCrash, type CrashFiles } from './crashes.js';
import { fullText, KAMAJI_LABEL } from './jobs.js';
import { files, type Files } from './read.js';

export interface JobFiles {
  crashFiles: CrashFiles;
  /** ~/Library/Logs, where each job logs to calcifer-<name>.log and Kamaji to kamaji.log. */
  logsDir: string;
  tail?: Files['tail'];
}

const TAIL_BYTES = 8 * 1024;
const TAIL_LINES = 60;

/** Null when molcajete has no job by that name. */
export function jobDetail(db: Db, name: string, jobFiles: JobFiles): JobDetailResponse | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  const job = readState<MacHealth>(db, HEALTH_STATE)?.jobs.find((j) => j.name === name);
  if (!job) return null;
  const tail = jobFiles.tail ?? files.tail;

  let log: JobDetailResponse['log'];
  if (!fullText(job.label)) {
    log = { known: false, reason: `Not shown: ${name} reads mail or untrusted text` };
  } else {
    const path =
      job.label === KAMAJI_LABEL
        ? `${jobFiles.logsDir}/kamaji.log`
        : `${jobFiles.logsDir}/calcifer-${name}.log`;
    const text = tail(path, TAIL_BYTES);
    log =
      text === null
        ? { known: false, reason: 'Its log couldn’t be read' }
        : { known: true, value: text.split('\n').slice(-TAIL_LINES).join('\n').trimEnd() };
  }

  const c = latestCrash(jobFiles.crashFiles, job.label);
  return {
    name,
    log,
    crash: {
      known: true,
      value: c
        ? {
            at: new Date(Date.parse(c.at)).toISOString(),
            type: c.type,
            where: c.where ?? null,
            line: c.line ?? null,
            message: c.message ?? null,
            traceback: c.traceback ?? null,
          }
        : null,
    },
  };
}
