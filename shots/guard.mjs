// The browser's only way out (Tyler, 2026-11-19): a forward proxy in the kamaji-shots container
// that Chromium is made to use for every connection, so a page can't reach the mini, the LAN or
// the tailnet. Playwright's route handler isn't enough: it never sees a redirect's next hop
// (tested 2026-11-19), and a public page could redirect to http://127.0.0.1. Here each HTTP
// request and each CONNECT tunnel (HTTPS, WebSockets) is checked as it's made, redirects
// included: the name first, then every address it resolves to, and the connection goes to the
// exact address that was checked. The site's own origins are let through whatever they are
// (the accounting sites are tailnet hosts); nothing else private is.
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect, isIP } from 'node:net';

const v4 = (ip) => ip.split('.').map(Number);

/** IPv4 loopback, RFC 1918, CGNAT and the tailnet (100.64/10), link-local, and 0/8. */
export function privateV4(ip) {
  const [a, b] = v4(ip);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Expands an IPv6 address to its eight groups, as numbers. */
function groups(ip) {
  let s = ip.toLowerCase();
  // An embedded IPv4 tail (::ffff:127.0.0.1) as two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = v4(tail[1]);
    s =
      s.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array(8 - h.length - r.length).fill('0');
  return [...h, ...fill, ...r].map((g) => parseInt(g, 16));
}

/** ::1, ::, fe80::/10, fc00::/7, and IPv4 mapped or translated into IPv6 that's private. */
export function privateV6(ip) {
  const g = groups(ip);
  if (g.length !== 8 || g.some((n) => Number.isNaN(n))) return true;
  if (g.every((n) => n === 0)) return true;
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  const mapped = g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0);
  if (mapped || nat64) return privateV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return false;
}

export function privateAddress(ip) {
  const kind = isIP(ip);
  return kind === 4 ? privateV4(ip) : kind === 6 ? privateV6(ip) : true;
}

/**
 * A name that's never the open internet: Docker Desktop's way to the Mac, localhost, mDNS,
 * .internal, the tailnet, a name without a dot (a search domain could make it a tailnet host),
 * or an address that's private.
 */
export function privateName(host) {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIP(h)) return privateAddress(h);
  return !h.includes('.') || h === 'localhost' || /\.(localhost|local|internal|ts\.net)$/.test(h);
}

const DEFAULT_PORT = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };
/** "host:port", the form a site's own origins are kept in. */
export const hostPort = (host, port) => `${host.toLowerCase().replace(/^\[|\]$/g, '')}:${port}`;
export const originOf = (url) => {
  const u = new URL(url);
  return hostPort(u.hostname, u.port || DEFAULT_PORT[u.protocol] || '80');
};

/**
 * Where a connection may go: the address to connect to, or null when it's blocked. The site's
 * own origins go to whatever they resolve to; anything else must be a public name whose every
 * address is public.
 */
export async function destination(host, port, own, resolve = lookup) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const mine = own.has(hostPort(h, port));
  if (!mine && privateName(h)) return null;
  let addresses;
  try {
    addresses = isIP(h) ? [{ address: h }] : await resolve(h, { all: true });
  } catch {
    return { address: null };
  }
  if (addresses.length === 0) return { address: null };
  if (!mine && addresses.some((a) => privateAddress(a.address))) return null;
  return { address: addresses[0].address };
}

const HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'];

/**
 * Starts the proxy on 127.0.0.1. `blocked(hostPort)` is told of each connection it refused.
 * Returns its address for Chromium's --proxy-server.
 */
export async function startGuard({ own, blocked }) {
  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = url.port || DEFAULT_PORT[url.protocol] || '80';
    const to = await destination(url.hostname, port, own);
    if (!to) {
      blocked(hostPort(url.hostname, port));
      res.writeHead(403, { 'x-kamaji-blocked': 'private' }).end();
      return;
    }
    if (!to.address) {
      res.writeHead(502).end();
      return;
    }
    const headers = { ...req.headers };
    for (const h of HOP) delete headers[h];
    const upstream = httpRequest(
      {
        host: to.address,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        setHost: false,
        timeout: 30_000,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  // HTTPS and WebSockets: a tunnel, checked before it's opened.
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    if (!m) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    const [, host, port] = m;
    const to = await destination(host, port, own);
    if (!to) {
      blocked(hostPort(host, port));
      return client.end('HTTP/1.1 403 Forbidden\r\nx-kamaji-blocked: private\r\n\r\n');
    }
    if (!to.address) return client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const upstream = connect(Number(port), to.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.setTimeout(60_000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  // A plain ws:// upgrade sent to the proxy instead of a tunnel: never let through.
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
