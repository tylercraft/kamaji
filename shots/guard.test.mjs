// The browser's guard (guard.mjs): which names and addresses it refuses, the site's own origins
// let through, and the proxy refusing before it connects, redirects included.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destination, originOf, privateAddress, privateName, startGuard } from './guard.mjs';

describe('what’s private', () => {
  it('IPv4: loopback, RFC 1918, the tailnet’s 100.64/10, link-local, 0/8', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.0.9',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '100.106.213.63',
      '100.127.255.255',
      '169.254.169.254',
      '0.0.0.0',
    ])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1', '104.21.3.4'])
      expect(privateAddress(ip), ip).toBe(false);
  });

  it('IPv6: ::1, ::, fe80::/10, fc00::/7, and private IPv4 mapped or translated', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'febf::1',
      'fc00::1',
      'fd7a:115c:a1e0::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:192.168.1.1',
      '64:ff9b::a00:1',
    ])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700::1111', '::ffff:8.8.8.8', '2001:db8::1'])
      expect(privateAddress(ip), ip).toBe(false);
  });

  it('names: Docker Desktop’s, localhost, mDNS, .internal, the tailnet, no dot, private literals', () => {
    for (const host of [
      'host.docker.internal',
      'gateway.docker.internal',
      'metadata.google.internal',
      'localhost',
      'app.localhost',
      'molcajete.local',
      'molcajete.tailb3044a.ts.net',
      'molcajete',
      'localhost.',
      '127.0.0.1',
      '[::1]',
      '192.168.1.1',
    ])
      expect(privateName(host), host).toBe(true);
    for (const host of ['briardalewealth.com', 'js.hsforms.net', '8.8.8.8'])
      expect(privateName(host), host).toBe(false);
  });
});

describe('where a connection may go', () => {
  const own = new Set([originOf('https://accounting.firstandlastrecords.com/')]);
  const resolves = (map) => async (host) => {
    if (!(host in map)) throw new Error('ENOTFOUND');
    return map[host].map((address) => ({ address }));
  };

  it('a public name to its address; one that resolves anywhere private is refused', async () => {
    const r = resolves({
      'example.com': ['93.184.215.14'],
      'sneaky.example': ['8.8.8.8', '10.0.0.5'],
    });
    expect(await destination('example.com', '443', own, r)).toEqual({ address: '93.184.215.14' });
    expect(await destination('sneaky.example', '443', own, r)).toBeNull();
  });

  it('the site’s own origin, though it’s a tailnet host, and nothing else on the tailnet', async () => {
    const r = resolves({ 'accounting.firstandlastrecords.com': ['100.77.122.31'] });
    expect(await destination('accounting.firstandlastrecords.com', '443', own, r)).toEqual({
      address: '100.77.122.31',
    });
    // Its own host on another port isn't its origin.
    expect(await destination('accounting.firstandlastrecords.com', '8080', own, r)).toBeNull();
    expect(await destination('molcajete.tailb3044a.ts.net', '443', own, r)).toBeNull();
  });
});

describe('the proxy', () => {
  let hits = [];
  let target;
  let site;
  let guard;
  let refused = [];
  beforeAll(async () => {
    // A server that must never be reached, and the "site", which redirects to it.
    target = createServer((req, res) => {
      hits.push(req.url);
      res.end('secret');
    });
    await new Promise((r) => target.listen(0, '127.0.0.1', r));
    site = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/secret` });
        return res.end();
      }
      res.end('the site');
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    guard = await startGuard({
      own: new Set([originOf(`http://127.0.0.1:${site.address().port}/`)]),
      blocked: (where) => refused.push(where),
    });
  });
  afterAll(() => {
    guard.close();
    target.close();
    site.close();
  });

  const viaProxy = (url) =>
    new Promise((resolve, reject) => {
      const proxy = new URL(guard.server);
      const req = request(
        { host: proxy.hostname, port: proxy.port, path: url, headers: { host: new URL(url).host } },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('lets the site through, and refuses what it redirects to when that’s private', async () => {
    const s = site.address().port;
    expect(await viaProxy(`http://127.0.0.1:${s}/`)).toMatchObject({
      status: 200,
      body: 'the site',
    });
    const hop = await viaProxy(`http://127.0.0.1:${s}/redirect`);
    expect(hop.status).toBe(302);
    // The browser's next hop comes back through the proxy, which refuses it.
    const next = await viaProxy(hop.headers.location);
    expect(next).toMatchObject({ status: 403, headers: { 'x-kamaji-blocked': 'private' } });
    expect(hits).toEqual([]);
    expect(refused).toEqual([`127.0.0.1:${target.address().port}`]);
  });

  it('refuses a tunnel to a private address before it opens one', async () => {
    const proxy = new URL(guard.server);
    const answer = await new Promise((resolve) => {
      const sock = connect(Number(proxy.port), proxy.hostname, () =>
        sock.write(`CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: 192.168.1.1:443\r\n\r\n`),
      );
      let got = '';
      sock.on('data', (d) => (got += d));
      sock.on('close', () => resolve(got));
    });
    expect(answer.startsWith('HTTP/1.1 403')).toBe(true);
    expect(refused).toContain('192.168.1.1:443');
  });
});
