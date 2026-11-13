// For the tests: kamaji-report's own apt parsing, run with bash on a given `apt list --upgradable`,
// and craftish's real one from 2026-11-13 (fixtures/apt-upgradable.craftish.txt).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = readFileSync(
  new URL('../../../../server-report/kamaji-report', import.meta.url),
  'utf8',
);
export const fixture = readFileSync(
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

export interface Upgradable {
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

export function run(input: string, max?: number): Upgradable {
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
