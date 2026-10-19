/**
 * Which language a document is in: the admin's saved choice, else the
 * browser's; a public page's `?lang=`, else the browser's. The root layout
 * stamps `<html lang>` from the same answer the page renders in.
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

import { documentLocale, getLocale, negotiateLocale, publicLocale } from './locale';

beforeEach(() => {
  request.cookie = undefined;
  request.headers = {};
});

describe('negotiateLocale', () => {
  it('takes the first supported language the browser lists', () => {
    expect(negotiateLocale('es-CO,es;q=0.9,en;q=0.8')).toBe('es');
    expect(negotiateLocale('en-US,en;q=0.9,es;q=0.8')).toBe('en');
  });

  it('honors weights over the order they are written in', () => {
    expect(negotiateLocale('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.5')).toBe('es');
    expect(negotiateLocale('en;q=0.4, es;q=0.6')).toBe('es');
  });

  it('never picks a language the browser refuses (q=0)', () => {
    expect(negotiateLocale('es;q=0, en;q=0.1')).toBe('en');
    expect(negotiateLocale('es;q=0.0')).toBe('en');
  });

  it('ignores a weight it cannot read instead of taking it as a refusal', () => {
    expect(negotiateLocale('es;q=banana')).toBe('es');
    expect(negotiateLocale('es;q=, en;q=0.5')).toBe('es');
  });

  it('is English for a header that names neither, or none at all', () => {
    expect(negotiateLocale('fr-FR,de;q=0.8')).toBe('en');
    expect(negotiateLocale('*')).toBe('en');
    expect(negotiateLocale('')).toBe('en');
    expect(negotiateLocale(null)).toBe('en');
  });
});

describe('getLocale (admin, onboarding, sign-in)', () => {
  it("follows the browser's language when nothing was saved", async () => {
    request.headers['accept-language'] = 'es-MX,es;q=0.9';
    expect(await getLocale()).toBe('es');
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

  it("falls back to the browser's language", async () => {
    request.headers['accept-language'] = 'es-AR';
    expect(await publicLocale()).toBe('es');
  });
});

describe('documentLocale', () => {
  it("answers a product route with the admin's language", async () => {
    request.headers['x-slate-path'] = '/admin/event-types';
    request.headers['x-slate-query'] = '?lang=es';
    request.cookie = 'en';
    expect(await documentLocale()).toBe('en');
  });

  it("answers a booking page with the visitor's language", async () => {
    request.headers['x-slate-path'] = '/acme/alex-rivera/intro-call';
    request.headers['accept-language'] = 'es-CO';
    request.cookie = 'en';
    expect(await documentLocale()).toBe('es');
  });

  it('treats a missing path header as public', async () => {
    request.headers['x-slate-query'] = '?lang=es';
    expect(await documentLocale()).toBe('es');
  });
});
