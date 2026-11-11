// Starting the updater once a batch is approved. On the mini it's its own LaunchAgent,
// dev.craftish.kamaji-updater, which runs under doppler with the `updater` config (the app never
// sees the update key) and exits when the work is done; kickstart on one already running does
// nothing. On the laptop (`spawn`) it's a child process with the app's own environment, which
// there holds the dev keys. KAMAJI_UPDATER chooses; unset, nothing starts.
import { execFile, spawn } from 'node:child_process';

export type UpdaterStart = () => void;

export function updaterLauncher(
  mode: string | undefined,
  log: (message: string) => void,
): UpdaterStart {
  if (mode === 'launchd') {
    const uid = process.getuid?.() ?? 501;
    return () =>
      execFile(
        '/bin/launchctl',
        ['kickstart', `gui/${uid}/dev.craftish.kamaji-updater`],
        (error) => {
          if (error)
            log(
              `updater: kickstart failed (exit ${typeof error.code === 'number' ? error.code : '?'})`,
            );
        },
      );
  }
  if (mode === 'spawn') {
    const entry = new URL('../updater/main.js', import.meta.url).pathname;
    return () => {
      const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
      child.on('error', () => log('updater: could not start'));
    };
  }
  return () => log('updater: KAMAJI_UPDATER is not set; the batch waits');
}
