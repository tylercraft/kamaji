// Runs kamaji-report's own apt parsing (between its BEGIN/END upgradable markers) with bash, on
// craftish's real `apt list --upgradable` from 2026-11-13, so the script and Kamaji's parser are
// tested against the same output.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../../../../server-report/kamaji-report', import.meta.url),
  'utf8',
);
const fixture = readFileSync(
  new URL('fixtures/apt-upgradable.craftish.txt', import.meta.url),
  'utf8',
);

function functions(): string {
  const fn = (name: string) =>
    new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}\\n`, 'm').exec(script)![0];
  const block = script.slice(
    script.indexOf('# BEGIN upgradable'),
    script.indexOf('# END upgradable'),
  );
  return fn('js') + fn('lines') + block;
}

interface Upgradable {
  upgradable: {
    name: string;
    from: string;
    to: string;
    suites: string[];
    security: boolean;
    esm: boolean;
  }[];
  upgradableTotal: number;
  truncated: boolean;
}

function run(input: string, max?: number): Upgradable {
  const out = execFileSync(
    '/bin/bash',
    [
      '-c',
      `${functions()}\n${max ? `UPGRADABLE_MAX=${max}\n` : ''}printf '{%s}' "$(upgradable_json)"`,
    ],
    { input, encoding: 'utf8' },
  );
  return JSON.parse(out) as Upgradable;
}

describe('kamaji-report’s upgradable packages', () => {
  it('reads craftish’s real list: every package, versions and origin, security first', () => {
    const r = run(fixture);
    expect(r.upgradableTotal).toBe(34);
    expect(r.truncated).toBe(false);
    expect(r.upgradable.filter((p) => p.security).map((p) => p.name)).toEqual([
      'apache2-bin',
      'libc-bin',
      'libc-dev-bin',
      'libc-devtools',
      'libc6',
      'libc6-dev',
      'linux-firmware-amd-graphics',
      'locales',
    ]);
    expect(r.upgradable.slice(0, 8).every((p) => p.security)).toBe(true);
    expect(r.upgradable.find((p) => p.name === 'docker-ce')).toEqual({
      name: 'docker-ce',
      from: '5:29.9.2-1~ubuntu.24.04~noble',
      to: '5:29.9.3-1~ubuntu.24.04~noble',
      suites: ['noble'],
      security: false,
      esm: false,
    });
    expect(r.upgradable.find((p) => p.name === 'kernelcare')?.suites).toEqual(['unknown']);
  });

  it('counts a package in several suites as security, ESM never, and caps the list', () => {
    // Made-up lines in the real format: two suites, and Ubuntu Pro's ESM pockets.
    const r = run(
      [
        'Listing...',
        'openssl/noble-updates,noble-security 3.0.13-0ubuntu3.7 amd64 [upgradable from: 3.0.13-0ubuntu3.6]',
        'libxml2/noble-apps-security 2.9.14-1 amd64 [upgradable from: 2.9.14-0]',
        'tmux/noble-updates 3.4-1ubuntu0.2 amd64 [upgradable from: 3.4-1ubuntu0.1]',
        'not a package line',
      ].join('\n'),
    );
    expect(r.upgradable.map((p) => [p.name, p.security, p.esm])).toEqual([
      ['openssl', true, false],
      ['libxml2', false, true],
      ['tmux', false, false],
    ]);
    expect(r.upgradable[0]!.suites).toEqual(['noble-updates', 'noble-security']);
    const capped = run(fixture, 5);
    expect(capped.upgradable).toHaveLength(5);
    expect(capped).toMatchObject({ upgradableTotal: 34, truncated: true });
    expect(run('Listing...\n')).toEqual({ upgradable: [], upgradableTotal: 0, truncated: false });
  });
});
