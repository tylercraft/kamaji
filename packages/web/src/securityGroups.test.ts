import type { VulnerabilityMatch } from '@kamaji/shared';
import { describe, expect, it } from 'vitest';
import { remedy } from './securityGroups';

const v = (fixedIn: string | null): VulnerabilityMatch => ({
  id: Math.random().toString(),
  title: 't',
  informational: false,
  cvssScore: null,
  cvssRating: null,
  cve: null,
  fixedIn,
  remediation: null,
  reference: null,
  published: null,
});

describe('what an update fixes', () => {
  it('says when the offered version fixes only some findings', () => {
    expect(
      remedy({ name: 'Elementor', offer: '3.25.0', items: [v('3.1.4'), v('3.25.0'), v('4.3.5')] }),
    ).toBe('The offered 3.25.0 fixes 2 of 3; 1 needs 4.3.5 or later');
  });

  it('compares versions as WordPress does, not as text', () => {
    expect(remedy({ name: 'X', offer: '3.10.0', items: [v('3.9.2'), v('3.10.0')] })).toBe(
      'The offered 3.10.0 fixes all 2',
    );
  });

  it('counts findings with no fix, and components with no offer', () => {
    expect(remedy({ name: 'X', offer: '2.0', items: [v('2.0'), v(null)] })).toBe(
      'The offered 2.0 fixes 1 of 2; 1 has no fix yet',
    );
    expect(remedy({ name: 'X', offer: null, items: [v('1.2'), v('1.10')] })).toBe(
      'Fixed by 1.10, which WordPress isn’t offering here yet',
    );
    expect(remedy({ name: 'X', offer: null, items: [v(null)] })).toBe('No fix yet');
  });
});
