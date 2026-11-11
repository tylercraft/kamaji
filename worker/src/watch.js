// Kamaji's outside watch: the same home page check the mini makes, from Cloudflare's network
// every 5 minutes, so a site going down is noticed even when the mini is dark. It alerts
// #kamaji itself after two failures running, and once more when the site is back. Kamaji
// pulls the results to show beside its own.
//
// Plain functions over a state object, so they're tested without Cloudflare (watch.test.js).
// The entry point (index.js) loads the state from KV, runs a pass and writes it back once:
// one KV write per pass keeps well inside the free plan's daily writes.

export const HISTORY = 288; // a day of 5-minute checks per site
export const FAILURES_TO_ALERT = 2;
export const REMIND_MS = 24 * 60 * 60 * 1000;
export const MAX_SITES = 50;
export const USER_AGENT = 'Kamaji uptime check (outside)';

const PHP_ERRORS = [
  /There has been a critical error on (this|your) website/i,
  /<b>(Fatal|Parse) error<\/b>:/i,
  /Error establishing a database connection/i,
];

/** An empty state: no sites until Kamaji sends its list. */
export const emptyState = () => ({ sites: [], results: {}, checkedAt: null });

/**
 * Validates the list Kamaji sends: [{id, name, url, expectedText}]. Throws on anything else, so a
 * bad list never replaces a good one.
 */
export function parseSites(input) {
  if (!Array.isArray(input) || input.length > MAX_SITES) throw new Error('sites must be a list');
  return input.map((site) => {
    const { id, name, url, expectedText } = site ?? {};
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) {
      throw new Error('each site needs an id and a name');
    }
    if (typeof url !== 'string' || new URL(url).protocol !== 'https:') {
      throw new Error('each site needs an https url');
    }
    if (expectedText !== null && typeof expectedText !== 'string') {
      throw new Error('expectedText must be text or null');
    }
    return { id, name, url, expectedText };
  });
}

/** One check of one site. Never throws: a failure is a result. */
export async function checkSite(
  site,
  { fetch: doFetch = fetch, timeoutMs = 20_000, now = Date.now } = {},
) {
  const started = now();
  try {
    const response = await doFetch(site.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    const ms = now() - started;
    const body = await response.text();
    let problem = null;
    if (response.status < 200 || response.status > 299) problem = `HTTP ${response.status}`;
    else if (PHP_ERRORS.some((p) => p.test(body))) problem = 'The page shows a PHP error';
    else if (site.expectedText && !body.includes(site.expectedText)) {
      problem = 'The expected text is missing';
    }
    return { t: started, ok: problem === null, status: response.status, ms, problem };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      t: started,
      ok: false,
      status: null,
      ms: null,
      problem: timedOut
        ? `No answer within ${Math.round(timeoutMs / 1000)} seconds`
        : 'Couldn’t connect',
    };
  }
}

function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/**
 * Folds one pass's results into the state. Returns the new state and the lines to post: a site
 * down (two failures running), back up, or still down a day on. Sites no longer in the list
 * are dropped.
 */
export function applyResults(state, results, now) {
  const next = { sites: state.sites, results: {}, checkedAt: now };
  const lines = [];
  for (const site of state.sites) {
    const before = state.results[site.id] ?? {
      history: [],
      failures: 0,
      downSince: null,
      alertedAt: null,
    };
    const result = results[site.id];
    if (!result) {
      next.results[site.id] = before;
      continue;
    }
    const entry = {
      history: [...before.history, result].slice(-HISTORY),
      failures: result.ok ? 0 : before.failures + 1,
      downSince: before.downSince,
      alertedAt: before.alertedAt,
    };
    if (result.ok) {
      if (before.alertedAt !== null) {
        lines.push(`${site.name} is back up (after ${duration(now - before.downSince)})`);
      }
      entry.downSince = null;
      entry.alertedAt = null;
    } else {
      if (entry.downSince === null) entry.downSince = result.t;
      if (entry.failures === FAILURES_TO_ALERT && before.alertedAt === null) {
        lines.push(`${site.name} is down: ${result.problem}`);
        entry.alertedAt = now;
      } else if (entry.alertedAt !== null && now - entry.alertedAt >= REMIND_MS) {
        lines.push(`Still down after ${duration(now - entry.downSince)}: ${site.name}`);
        entry.alertedAt = now;
      }
    }
    next.results[site.id] = entry;
  }
  return { state: next, lines };
}

/**
 * One site's check outside the cron pass (Kamaji's updater, re-checking a site straight after
 * its run): folded in like a pass's result, without claiming a whole pass ran.
 */
export function applyOne(state, id, result, now) {
  const { state: next, lines } = applyResults(state, { [id]: result }, now);
  return { state: { ...next, checkedAt: state.checkedAt }, lines };
}

/** The Discord message for a pass's lines, or null when there's nothing to say. */
export function message(lines, kamajiUrl) {
  if (lines.length === 0) return null;
  return ['**Kamaji (outside check)**', ...lines.map((l) => `- ${l}`), `<${kamajiUrl}>`].join('\n');
}

/** Compares a presented bearer token with the expected one without leaking how much matched. */
export async function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [presented, expected].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))),
  );
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
