import { describe, expect, it } from 'vitest';
import { checkHomePage, describeError, USER_AGENT } from './http.js';

const respond =
  (body: string, init: ResponseInit = {}, url = 'https://example.com/') =>
  async (_input: string | URL | Request, request?: RequestInit) => {
    expect(new Headers(request?.headers).get('User-Agent')).toBe(USER_AGENT);
    const response = new Response(body, init);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };

const fail = (code: string) => async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
};

let t = 0;
const clock = () => (t += 120);

describe('checkHomePage', () => {
  it('passes a 200 with the expected text', async () => {
    const r = await checkHomePage('https://example.com/', 'Hello', {
      fetch: respond('<h1>Hello</h1>') as typeof fetch,
      clock,
    });
    expect(r).toMatchObject({ ok: true, status: 200, expectedText: true, problem: null });
    expect(r.responseMs).toBe(120);
  });

  it('fails a page without the expected text', async () => {
    const r = await checkHomePage('https://example.com/', 'Hello', {
      fetch: respond('<h1>Parked domain</h1>') as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, expectedText: false });
    expect(r.problem).toBe('The expected text is missing');
  });

  it('fails WordPress’s critical error page even with a 200', async () => {
    const r = await checkHomePage('https://example.com/', null, {
      fetch: respond('<p>There has been a critical error on this website.</p>') as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, phpError: true, problem: 'The page shows a PHP error' });
  });

  it('fails on a server error status', async () => {
    const r = await checkHomePage('https://example.com/', 'Hello', {
      fetch: respond('Hello', { status: 503 }) as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, status: 503, problem: 'HTTP 503' });
  });

  it('says why a connection failed, without the error message', async () => {
    const r = await checkHomePage('https://example.com/', null, {
      fetch: fail('ENOTFOUND') as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, status: null, errorCode: 'ENOTFOUND' });
    expect(r.problem).toBe('The domain doesn’t resolve');
  });

  it('times out', async () => {
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    const r = await checkHomePage('https://example.com/', null, {
      fetch: hang as typeof fetch,
      timeoutMs: 20,
    });
    expect(r.problem).toBe('No answer within 0 seconds');
    expect(r.errorCode).toBe('TimeoutError');
  });

  it('rethrows when the cycle is stopped', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    await expect(
      checkHomePage('https://example.com/', null, {
        fetch: fail('ECONNRESET') as typeof fetch,
        signal: controller.signal,
      }),
    ).rejects.toThrow('shutdown');
  });

  it('names certificate errors', () => {
    expect(describeError('CERT_HAS_EXPIRED', 1000)).toBe('Certificate not valid');
    expect(describeError('ERR_TLS_CERT_ALTNAME_INVALID', 1000)).toBe('Certificate not valid');
  });
});
