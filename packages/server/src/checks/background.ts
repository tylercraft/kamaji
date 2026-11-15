// Work the cycle or a route starts and never waits for: it returns at once, so slow sites can't
// hold anything up, and does nothing while a run is still going. A run that throws (a bug: the
// runs don't) logs that it happened, nothing more. Domains' renewal dates use it (checks/domains.ts).
export function inBackground(
  run: () => Promise<unknown>,
  log: (message: string) => void,
  what: string,
) {
  let running = false;
  return (): void => {
    if (running) return;
    running = true;
    run()
      .catch(() => log(`${what}: the refresh failed`))
      .finally(() => {
        running = false;
      });
  };
}
