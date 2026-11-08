// The home page check from the mini: one GET as a visitor's browser would make it, then a TLS
// handshake to read the certificate. This is all Kamaji ever sends a site from here until
// Craftish Care (M3), and it never sends credentials or anything the site would store.
import tls from 'node:tls';

export const USER_AGENT = 'Kamaji uptime check';

export interface HomePageResult {
  ok: boolean;
  /** Final status after redirects; null when there was no response. */
  status: number | null;
  /** Milliseconds to the response headers. */
  responseMs: number | null;
  finalUrl: string | null;
  /** Whether the expected text was found; null when none is set or there was no body. */
  expectedText: boolean | null;
  /** WordPress's critical error page, a PHP fatal, or the database connection error. */
  phpError: boolean;
  /** Why it failed, in plain words; null when it passed. */
  problem: string | null;
  /** The low-level error code, for the record (never a URL or message). */
  errorCode: string | null;
}

export interface CertificateResult {
  validTo: number | null;
  daysLeft: number | null;
  /** Why the certificate couldn't be read or isn't trusted; null when it's fine. */
  problem: string | null;
}

const PHP_ERRORS = [
  /There has been a critical error on (this|your) website/i,
  /<b>(Fatal|Parse) error<\/b>:/i,
  /Error establishing a database connection/i,
];

const MAX_BODY = 5 * 1024 * 1024;

export interface CheckOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  clock?: () => number;
}

function errorCode(error: unknown): string {
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === 'string') return cause.code;
  if (error instanceof Error && error.name !== 'Error' && error.name !== 'TypeError') {
    return error.name;
  }
  return 'unknown';
}

/** Plain words for a failed connection. */
export function describeError(code: string, timeoutMs: number): string {
  if (code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return `No answer within ${Math.round(timeoutMs / 1000)} seconds`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The domain doesn’t resolve';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'Connection dropped';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'Certificate not valid';
  return 'Couldn’t connect';
}

export async function checkHomePage(
  url: string,
  expectedText: string | null,
  options: CheckOptions = {},
): Promise<HomePageResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? (() => performance.now());
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const started = clock();
  let response: Response;
  try {
    response = await doFetch(url, {
      redirect: 'follow',
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const code = timeout.aborted ? 'TimeoutError' : errorCode(error);
    return {
      ok: false,
      status: null,
      responseMs: null,
      finalUrl: null,
      expectedText: null,
      phpError: false,
      problem: describeError(code, timeoutMs),
      errorCode: code,
    };
  }
  const responseMs = Math.round(clock() - started);

  let body: string | null = null;
  try {
    const text = await response.text();
    body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
  }

  const phpError = body !== null && PHP_ERRORS.some((pattern) => pattern.test(body));
  const found = expectedText && body !== null ? body.includes(expectedText) : null;
  const statusOk = response.status >= 200 && response.status < 300;

  let problem: string | null = null;
  if (!statusOk) problem = `HTTP ${response.status}`;
  else if (body === null) problem = 'The page didn’t finish loading';
  else if (phpError) problem = 'The page shows a PHP error';
  else if (found === false) problem = 'The expected text is missing';

  return {
    ok: problem === null,
    status: response.status,
    responseMs,
    finalUrl: response.url || url,
    expectedText: found,
    phpError,
    problem,
    errorCode: null,
  };
}

/** Reads the certificate the site's host presents, as a browser would see it. */
export function checkCertificate(
  host: string,
  options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {},
): Promise<CertificateResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  return new Promise((resolve, reject) => {
    // Not rejecting an untrusted certificate here, so an expired one can still be read and named.
    // Nothing is sent over this connection; the home page check above is the trusted request.
    const socket = tls.connect({
      host,
      port: 443,
      servername: host,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    });
    const finish = (result: CertificateResult) => {
      options.signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(result);
    };
    const abort = () => {
      socket.destroy();
      reject(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('secureConnect', () => {
      const validTo = Date.parse(socket.getPeerCertificate().valid_to);
      if (Number.isNaN(validTo)) {
        finish({ validTo: null, daysLeft: null, problem: 'No certificate' });
        return;
      }
      finish({
        validTo,
        daysLeft: Math.floor((validTo - now()) / 86_400_000),
        problem: socket.authorized
          ? null
          : String(socket.authorizationError) === 'CERT_HAS_EXPIRED'
            ? 'Certificate expired'
            : 'Certificate not trusted',
      });
    });
    socket.once('timeout', () =>
      finish({ validTo: null, daysLeft: null, problem: describeError('TimeoutError', timeoutMs) }),
    );
    socket.once('error', (error) =>
      finish({
        validTo: null,
        daysLeft: null,
        problem: describeError(String((error as { code?: unknown }).code ?? ''), timeoutMs),
      }),
    );
  });
}
