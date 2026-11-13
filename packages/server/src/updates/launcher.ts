// Starting a separate process: the updater once a batch is approved, the backups process when a
// site's Backups panel asks. On the mini each is its own LaunchAgent (dev.craftish.kamaji-updater,
// dev.craftish.kamaji-backups), run under doppler with its own config, so the app never sees the
// update key or the restic password; each exits when its work is done, and kickstart on one
// already running does nothing. On the laptop (`spawn`) each is a child process with the app's
// own environment. KAMAJI_UPDATER chooses for both; unset, nothing starts.
import { execFile, spawn } from 'node:child_process';

export type UpdaterStart = () => void;

function launcher(
  mode: string | undefined,
  log: (message: string) => void,
  agent: { name: string; label: string; entry: string },
): () => void {
  if (mode === 'launchd') {
    const uid = process.getuid?.() ?? 501;
    return () =>
      execFile('/bin/launchctl', ['kickstart', `gui/${uid}/${agent.label}`], (error) => {
        if (error)
          log(
            `${agent.name}: kickstart failed (exit ${typeof error.code === 'number' ? error.code : '?'})`,
          );
      });
  }
  if (mode === 'spawn') {
    const entry = new URL(agent.entry, import.meta.url).pathname;
    return () => {
      const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
      child.on('error', () => log(`${agent.name}: could not start`));
    };
  }
  return () => log(`${agent.name}: KAMAJI_UPDATER is not set; the work waits`);
}

export function updaterLauncher(
  mode: string | undefined,
  log: (message: string) => void,
): UpdaterStart {
  return launcher(mode, log, {
    name: 'updater',
    label: 'dev.craftish.kamaji-updater',
    entry: '../updater/main.js',
  });
}

export function backupsLauncher(
  mode: string | undefined,
  log: (message: string) => void,
): () => void {
  return launcher(mode, log, {
    name: 'backups',
    label: 'dev.craftish.kamaji-backups',
    entry: '../sitebackups/main.js',
  });
}
