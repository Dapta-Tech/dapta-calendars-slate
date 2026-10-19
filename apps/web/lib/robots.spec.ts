/**
 * What a deployment tells search engines: `robots.txt`, the `X-Robots-Tag`
 * header and the root `<meta name="robots">`, all from one runtime switch
 * (`NOINDEX`), off by default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { deploymentNoindex } from './indexing';
import { robotsPolicy } from './robots';
import { PRODUCT_PREFIXES } from './theme';
import { middleware } from '@/middleware';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Google's matching for one robots rule: a prefix, with `$` anchoring the end. */
function ruleMatches(rule: string, path: string): boolean {
  return rule.endsWith('$') ? path === rule.slice(0, -1) : path.startsWith(rule);
}

function disallowed(path: string): boolean {
  const { rules } = robotsPolicy(false);
  const disallow = [(Array.isArray(rules) ? rules[0]! : rules).disallow ?? []].flat();
  return disallow.some((rule) => ruleMatches(rule, path));
}

describe('deploymentNoindex', () => {
  it('is off unless the switch says yes', () => {
    vi.stubEnv('NOINDEX', '');
    expect(deploymentNoindex()).toBe(false);
    for (const no of ['0', 'false', 'no', 'off']) {
      vi.stubEnv('NOINDEX', no);
      expect(deploymentNoindex()).toBe(false);
    }
    for (const yes of ['1', 'true', 'TRUE', ' yes ']) {
      vi.stubEnv('NOINDEX', yes);
      expect(deploymentNoindex()).toBe(true);
    }
  });
});

describe('robotsPolicy', () => {
  it('closes the whole site on a noindexed deployment', () => {
    expect(robotsPolicy(true)).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });

  it('keeps booking pages open and the product closed otherwise', () => {
    for (const open of ['/', '/acme/alex-rivera', '/acme/alex-rivera/intro-call', '/acme/team/sales']) {
      expect(disallowed(open), open).toBe(false);
    }
    for (const closed of [
      '/admin',
      '/admin/event-types',
      '/admin?tab=1',
      '/login',
      '/login?next=%2Fadmin',
      '/onboarding',
      '/api/auth/login',
      '/api/auth/callback?code=x',
      '/api/availability',
    ]) {
      expect(disallowed(closed), closed).toBe(true);
    }
  });

  it('never closes a vanity slug that only starts like a product path', () => {
    expect(disallowed('/login-labs/ana')).toBe(false);
    expect(disallowed('/adminco/ana/intro')).toBe(false);
    expect(disallowed('/apiary/bee')).toBe(false);
  });

  it('closes every product path the theme and framing policy know', () => {
    for (const prefix of PRODUCT_PREFIXES) expect(disallowed(`${prefix}/x`), prefix).toBe(true);
  });
});

describe('X-Robots-Tag', () => {
  const visit = (path: string) => middleware(new NextRequest(new URL(path, 'http://localhost:3000')));

  it('is absent by default', () => {
    expect(visit('/acme/alex-rivera/intro-call').headers.get('x-robots-tag')).toBeNull();
  });

  it('marks every response of a noindexed deployment', () => {
    vi.stubEnv('NOINDEX', 'true');
    for (const path of ['/acme/alex-rivera/intro-call', '/admin', '/robots.txt', '/acme/alex-rivera/opengraph-image']) {
      expect(visit(path).headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
    }
  });
});
