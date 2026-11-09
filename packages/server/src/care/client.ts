// Talking to craftish-care on a site. One signed POST; where a security plugin blocks /wp-json/,
// once more by the ?rest_route= form, freshly signed (docs/protocol.md, "Requests"). Problems come
// back in plain words and never quote the site's response.
import type { SigningKey } from './keys.js';
import { ENDPOINT_ROUTE, signRequest } from './sign.js';

/** The plugin's own refusal codes: an answer from the plugin, so no retry by the other URL form. */
const PLUGIN_CODES = new Set([
  'malformed',
  'unknown_key',
  'wrong_key',
  'stale',
  'bad_signature',
  'replay',
  'wrong_host',
  'https_required',
  'rate_limited',
  'disconnected',
  'not_found',
  'bad_body',
  'unknown_job',
]);

const WORDS: Record<string, string> = {
  malformed: 'The plugin said the request was malformed',
  unknown_key: 'The plugin doesn’t know this key: it may be a copy made for another Kamaji',
  wrong_key: 'The plugin refused this key for that request',
  stale: 'The plugin said the request was too old: check the site’s clock',
  bad_signature:
    'The plugin couldn’t verify the signature: the request may have been changed on the way',
  replay: 'The plugin had already seen this request',
  wrong_host: 'The site’s address in WordPress doesn’t match this URL',
  https_required: 'The plugin answers only over HTTPS',
  rate_limited: 'The plugin is refusing everything for 10 minutes after too many bad requests',
  disconnected: 'The plugin has been disconnected and has forgotten its keys',
  not_found: 'The plugin doesn’t offer that request',
  bad_body: 'The plugin couldn’t read the request',
  unknown_job: 'The plugin doesn’t know that job',
};

export type CareResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; code: string | null; problem: string };

export interface CareRequestOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

function urls(home: URL, endpoint: string): URL[] {
  const base = home.href.endsWith('/') ? home.href : `${home.href}/`;
  const pretty = new URL(`wp-json${ENDPOINT_ROUTE(endpoint)}`, base);
  const plain = new URL(base);
  plain.searchParams.set('rest_route', ENDPOINT_ROUTE(endpoint));
  return [pretty, plain];
}

/** Sends one signed request to the site whose WordPress address is `home`. */
export async function careRequest(
  home: URL,
  key: SigningKey,
  endpoint: string,
  body: Record<string, unknown>,
  options: CareRequestOptions = {},
): Promise<CareResult> {
  const doFetch = options.fetch ?? fetch;
  const json = JSON.stringify(body);
  let last: CareResult = { ok: false, status: null, code: null, problem: 'No answer' };
  for (const url of urls(home, endpoint)) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...signRequest(key, home, endpoint, json, options.now ? { now: options.now() } : {}),
    };
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: json,
        redirect: 'manual',
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(options.timeoutMs ?? 30_000),
        ]),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        status: null,
        code: null,
        problem: timedOut ? 'The site didn’t answer in time' : 'Couldn’t reach the site',
      };
    }
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        code: null,
        problem: `The site redirects plugin requests (HTTP ${response.status}): check the URL matches WordPress’s own address`,
      };
    }
    const data: unknown = await response.json().catch(() => null);
    const code =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : null;
    if (response.ok && data !== null && code === null) {
      return { ok: true, status: response.status, data };
    }
    if (code !== null && PLUGIN_CODES.has(code)) {
      return {
        ok: false,
        status: response.status,
        code,
        problem: `${WORDS[code] ?? code} (HTTP ${response.status})`,
      };
    }
    // Not the plugin talking: WordPress's own 404, a security plugin, or a page.
    last = {
      ok: false,
      status: response.status,
      code: null,
      problem:
        response.status === 404
          ? 'Craftish Care isn’t answering: is it installed and activated?'
          : `Something on the site blocked the request before Craftish Care saw it (HTTP ${response.status})`,
    };
  }
  return last;
}
