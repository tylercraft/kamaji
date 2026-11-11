// The Worker's entry: a cron pass every 5 minutes, and a small API for Kamaji.
//
//   GET /v1/results   the state: each site's last day of checks
//   PUT /v1/sites     replaces the list of sites to check (JSON: [{id, name, url, expectedText}])
//   POST /v1/check/<id>  checks one listed site now (the updater, straight after a run)
//
// Both need `Authorization: Bearer <KAMAJI_TOKEN>`. Secrets (wrangler secret put):
// KAMAJI_TOKEN, DISCORD_WEBHOOK_URL. Var: KAMAJI_URL. KV binding: KAMAJI.
import {
  applyOne,
  applyResults,
  checkSite,
  emptyState,
  message,
  parseSites,
  tokenMatches,
} from './watch.js';

const KEY = 'state';

async function load(env) {
  return (await env.KAMAJI.get(KEY, 'json')) ?? emptyState();
}

async function post(env, content) {
  if (!content || !env.DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Nothing to do: the next change of state posts again, and Kamaji shows the results.
  }
}

async function pass(env) {
  const state = await load(env);
  const checked = await Promise.all(state.sites.map((site) => checkSite(site)));
  const results = Object.fromEntries(state.sites.map((site, i) => [site.id, checked[i]]));
  const { state: next, lines } = applyResults(state, results, Date.now());
  await env.KAMAJI.put(KEY, JSON.stringify(next));
  await post(env, message(lines, env.KAMAJI_URL));
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pass(env));
  },

  async fetch(request, env) {
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!(await tokenMatches(token, env.KAMAJI_TOKEN))) return json({ error: 'forbidden' }, 403);

    const { pathname } = new URL(request.url);
    if (pathname === '/v1/results' && request.method === 'GET') return json(await load(env));
    if (pathname === '/v1/sites' && request.method === 'PUT') {
      let sites;
      try {
        sites = parseSites(await request.json());
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'bad list' }, 400);
      }
      const state = await load(env);
      await env.KAMAJI.put(KEY, JSON.stringify({ ...state, sites }));
      return json({ sites: sites.length });
    }
    const one = /^\/v1\/check\/([^/]+)$/.exec(pathname);
    if (one && request.method === 'POST') {
      const state = await load(env);
      const site = state.sites.find((s) => s.id === decodeURIComponent(one[1]));
      if (!site) return json({ error: 'not_listed' }, 404);
      const result = await checkSite(site);
      const { state: next, lines } = applyOne(state, site.id, result, Date.now());
      await env.KAMAJI.put(KEY, JSON.stringify(next));
      await post(env, message(lines, env.KAMAJI_URL));
      return json(result);
    }
    return json({ error: 'not_found' }, 404);
  },
};
