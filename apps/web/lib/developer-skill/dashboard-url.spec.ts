import { describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { dashboardUrl } from './dashboard-url';

/** A request as the route sees it; only its URL and headers are read. */
const req = (url = 'http://internal.example.test:3000/api/developers/skill') =>
  ({ url, nextUrl: new URL(url), headers: new Headers() }) as unknown as NextRequest;

describe('dashboardUrl', () => {
  it('uses PUBLIC_APP_URL, trailing slashes trimmed', () => {
    expect(dashboardUrl(req(), { PUBLIC_APP_URL: 'https://app.example.test/' })).toBe('https://app.example.test');
  });

  it('keeps a path prefix, so the skill links land under it', () => {
    expect(dashboardUrl(req(), { PUBLIC_APP_URL: 'https://example.test/calendars/' })).toBe('https://example.test/calendars');
  });

  it('falls back to the request when PUBLIC_APP_URL is unset or unusable', () => {
    for (const env of [{}, { PUBLIC_APP_URL: '' }, { PUBLIC_APP_URL: 'not a url' }, { PUBLIC_APP_URL: 'ftp://x.test' }]) {
      expect(dashboardUrl(req(), env)).toBe('http://internal.example.test:3000');
    }
  });
});
