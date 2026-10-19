/**
 * The root document: `<html lang>` follows the page's language, and the default
 * title and description are product copy in that language, for whatever name
 * the deployment set, with the noindex switch layered on top.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

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
// The font loader is a build-time transform with nothing to run here.
vi.mock('next/font/google', () => ({ Figtree: () => ({ variable: 'font-figtree' }) }));
// The theme has its own spec; here it only has to answer.
vi.mock('@/lib/theme.server', () => ({
  resolveDocumentTheme: async () => 'light',
  isPublicDocument: async () => true,
}));

async function loadLayout(productName?: string) {
  if (productName === undefined) vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', '');
  else vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', productName);
  vi.resetModules();
  return import('./layout');
}

beforeEach(() => {
  request.cookie = undefined;
  request.headers = { 'x-slate-path': '/acme/alex-rivera/intro-call' };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('root metadata', () => {
  it('is product copy, with no em dash, in English and Spanish', async () => {
    const { generateMetadata } = await loadLayout('Dapta Calendars');
    const en = await generateMetadata();
    expect(en.title).toBe('Dapta Calendars: free online scheduling and booking pages');
    expect(en.description).toMatch(/^Dapta Calendars gives you a booking page/);

    request.headers['accept-language'] = 'es-CO';
    const es = await generateMetadata();
    expect(es.title).toBe('Dapta Calendars: agenda de citas en línea gratis');
    expect(es.description).toMatch(/^Dapta Calendars te da una página de reservas/);

    for (const text of [en.title, en.description, es.title, es.description]) {
      expect(String(text)).not.toMatch(/[\u2014\u2013]/);
      expect(String(text)).not.toMatch(/clone|open-source scheduling/i);
    }
  });

  it("reads well under a fork's neutral default name", async () => {
    const { generateMetadata } = await loadLayout();
    const meta = await generateMetadata();
    expect(meta.title).toBe('Calendars: free online scheduling and booking pages');
    expect(String(meta.description)).not.toMatch(/dapta/i);
  });

  it('is in the admin language on a product route', async () => {
    const { generateMetadata } = await loadLayout('Dapta Calendars');
    request.headers = { 'x-slate-path': '/admin', 'accept-language': 'es-ES' };
    expect((await generateMetadata()).title).toBe('Dapta Calendars: agenda de citas en línea gratis');
    request.cookie = 'en';
    expect((await generateMetadata()).title).toBe('Dapta Calendars: free online scheduling and booking pages');
  });

  it('carries no robots rule by default, and noindex when the deployment says so', async () => {
    const { generateMetadata } = await loadLayout('Dapta Calendars');
    expect((await generateMetadata()).robots).toBeUndefined();
    vi.stubEnv('NOINDEX', '1');
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: false });
  });
});

describe('<html lang>', () => {
  async function langOf() {
    const { default: RootLayout } = await loadLayout('Dapta Calendars');
    const html = (await RootLayout({ children: null })) as ReactElement<{ lang: string }>;
    return html.props.lang;
  }

  it("is the visitor's language on a booking page", async () => {
    request.headers['accept-language'] = 'es-CO,es;q=0.9';
    expect(await langOf()).toBe('es');
    request.headers = { 'x-slate-path': '/acme/alex-rivera', 'x-slate-query': '?lang=es' };
    expect(await langOf()).toBe('es');
    request.headers = { 'x-slate-path': '/acme/alex-rivera', 'accept-language': 'en-US' };
    expect(await langOf()).toBe('en');
  });

  it("is the admin's language on a product route", async () => {
    request.headers = { 'x-slate-path': '/onboarding', 'accept-language': 'es-PE' };
    expect(await langOf()).toBe('es');
    request.cookie = 'en';
    expect(await langOf()).toBe('en');
  });
});
