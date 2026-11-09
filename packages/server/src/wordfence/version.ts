// Version comparison as PHP's version_compare() does it, since that's how WordPress and plugin
// authors compare versions: "1.0rc1" < "1.0" < "1.0.0" < "1.0.1", and "5.10" > "5.9".

const SPECIAL: Record<string, number> = {
  dev: 0,
  alpha: 1,
  a: 1,
  beta: 2,
  b: 2,
  rc: 3,
  '#': 4, // stands for a number, when one side has run out
  pl: 5,
  p: 5,
};

function canonical(version: string): string[] {
  return version
    .trim()
    .replace(/[-_+]/g, '.')
    .replace(/(\d)(\D)/g, '$1.$2')
    .replace(/(\D)(\d)/g, '$1.$2')
    .split('.')
    .filter((p) => p !== '');
}

const isNumber = (p: string) => /^\d+$/.test(p);
const rank = (p: string) => SPECIAL[p.toLowerCase()] ?? -1;

function comparePart(a: string, b: string): number {
  if (isNumber(a) && isNumber(b)) return Math.sign(Number(a) - Number(b));
  if (isNumber(a)) return Math.sign(SPECIAL['#']! - rank(b));
  if (isNumber(b)) return Math.sign(rank(a) - SPECIAL['#']!);
  return Math.sign(rank(a) - rank(b));
}

export function compareVersions(a: string, b: string): number {
  const pa = canonical(a);
  const pb = canonical(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return isNumber(y!) ? -1 : comparePart('#', y!);
    if (y === undefined) return isNumber(x) ? 1 : comparePart(x, '#');
    const c = comparePart(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

/** One of the feed's affected ranges; "*" is open-ended. */
export interface VersionRange {
  from_version: string;
  from_inclusive: boolean;
  to_version: string;
  to_inclusive: boolean;
}

export function inRange(version: string, r: VersionRange): boolean {
  const from = r.from_version === '*' ? 1 : compareVersions(version, r.from_version);
  const to = r.to_version === '*' ? -1 : compareVersions(version, r.to_version);
  const aboveFrom = from > 0 || (from === 0 && (r.from_inclusive || r.from_version === '*'));
  const belowTo = to < 0 || (to === 0 && (r.to_inclusive || r.to_version === '*'));
  return aboveFrom && belowTo;
}
