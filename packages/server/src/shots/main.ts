// The screenshots process (ops/screenshots-plan.md, ops/README.md "Screenshots"): started by the
// updater when it asks for a set, by the app for Take screenshots now, and by the app's cycle when
// a set waits. It takes every set that waits, then exits, so a deploy's new code is what the next
// start runs. It holds no keys or secrets, so it runs without Doppler. One at a time: a second
// start while one runs exits at once.
import { fileURLToPath } from 'node:url';
import { openDb } from '../db.js';
import { shotsDir } from '../config.js';
import { realExec } from '../sitebackups/exec.js';
import { writeState } from '../state.js';
import { releaseLock, takeLock } from '../updater/lock.js';
import { ensureImage } from './image.js';
import { failWaiting, orphanedSets, runShots } from './run.js';
import { HEARTBEAT, LOCK } from './sets.js';

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const env = process.env;
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const db = openDb(env.KAMAJI_DB ?? `${repoRoot}data/kamaji.db`);

const other = takeLock(db, process.pid, Date.now(), LOCK);
if (other !== undefined) {
  log(`shots: another run is going (pid ${other}); exiting`);
  process.exit(0);
}

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`shots: ${signal}: stopping after this set`);
    controller.abort();
  });
}

// The updater and the site page read this to tell a process that's working from one that isn't.
const beat = () => writeState(db, HEARTBEAT, { pid: process.pid }, Date.now());
beat();
const heartbeat = setInterval(beat, 15_000);

const docker = env.KAMAJI_DOCKER ?? '/usr/local/bin/docker';
const exec = realExec(controller.signal);
const imageDir = `${repoRoot}shots`;
try {
  log('shots: started');
  orphanedSets(db, Date.now());
  const image = await ensureImage(exec, docker, imageDir, log);
  if (!image.ok) {
    log(`shots: ${image.problem}`);
    failWaiting(db, Date.now(), image.problem);
  } else {
    await runShots(
      {
        db,
        exec,
        docker,
        dir: shotsDir(env),
        seccomp: `${imageDir}/seccomp.json`,
        image: image.tag,
        now: Date.now,
        log,
      },
      controller.signal,
    );
  }
  log('shots: nothing left to shoot; exiting');
} catch (error) {
  log(`shots: stopped: ${error instanceof Error ? error.name : 'error'}`);
  process.exitCode = controller.signal.aborted ? 0 : 1;
} finally {
  clearInterval(heartbeat);
  releaseLock(db, Date.now(), LOCK);
  db.close();
}
