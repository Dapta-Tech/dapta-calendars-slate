/**
 * Which language a document is in: the admin's saved choice, else English; a
 * public page's `?lang=`, else English. The browser's Accept-Language never
 * decides. The root layout stamps `<html lang>` from the same answer the page
 * renders in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  headers: {} as Record<string, string>,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'slate_locale' && request.cookie !== undefined ? { value: request.cookie } : undefined,
  }),
  headers: async () => ({ get: (name: string) => request.headers[name.toLowerCase()] ?? null }),
}));

import { documentLocale, getLocale, publicLocale } from './locale';

beforeEach(() => {
  request.cookie = undefined;
  request.headers = {};
});

describe('getLocale (admin, onboarding, sign-in)', () => {
  it('is English for a Spanish browser when nothing was saved', async () => {
    request.headers['accept-language'] = 'es-MX,es;q=0.9';
    expect(await getLocale()).toBe('en');
  });

  it('keeps the language the switcher saved, whatever the browser says', async () => {
    request.headers['accept-language'] = 'es-MX,es;q=0.9';
    request.cookie = 'en';
    expect(await getLocale()).toBe('en');
    request.headers['accept-language'] = 'en-US';
    request.cookie = 'es';
    expect(await getLocale()).toBe('es');
  });

  it('is English with no cookie and no header', async () => {
    expect(await getLocale()).toBe('en');
  });
});

describe('publicLocale', () => {
  it('reads ?lang= from the forwarded query when the page passes none', async () => {
    request.headers['accept-language'] = 'en-US';
    request.headers['x-slate-query'] = '?lang=es&utm_source=x';
    expect(await publicLocale()).toBe('es');
  });

  it('lets an explicit lang win over everything', async () => {
    request.headers['x-slate-query'] = '?lang=es';
    expect(await publicLocale('en')).toBe('en');
  });

  it('is English for a Spanish browser with no explicit choice', async () => {
    request.headers['accept-language'] = 'es-AR';
    expect(await publicLocale()).toBe('en');
  });
});

describe('documentLocale', () => {
  it("answers a product route with the admin's language", async () => {
    request.headers['x-slate-path'] = '/admin/event-types';
    request.headers['x-slate-query'] = '?lang=es';
    request.cookie = 'en';
    expect(await documentLocale()).toBe('en');
  });

  it('answers a booking page in English by default, Spanish only for ?lang=es', async () => {
    request.headers['x-slate-path'] = '/acme/alex-rivera/intro-call';
    request.headers['accept-language'] = 'es-CO';
    request.cookie = 'es';
    expect(await documentLocale()).toBe('en');
    request.headers['x-slate-query'] = '?lang=es';
    expect(await documentLocale()).toBe('es');
  });

  it('treats a missing path header as public', async () => {
    request.headers['x-slate-query'] = '?lang=es';
    expect(await documentLocale()).toBe('es');
  });
});
