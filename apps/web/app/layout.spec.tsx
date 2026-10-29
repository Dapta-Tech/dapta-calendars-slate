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
    const { generateMetadata } = await loadLayout('dCal');
    const en = await generateMetadata();
    expect(en.title).toBe('dCal: calendars for AI agents');
    expect(en.description).toMatch(/^With dCal, your agent finds a free time/);

    request.headers['x-slate-query'] = '?lang=es';
    const es = await generateMetadata();
    expect(es.title).toBe('dCal: calendarios para agentes de IA');
    expect(es.description).toMatch(/^Con dCal, tu agente busca un horario libre/);

    for (const text of [en.title, en.description, es.title, es.description]) {
      expect(String(text)).not.toMatch(/[\u2014\u2013]/);
      expect(String(text)).not.toMatch(/clone|open-source scheduling/i);
      // dCal is a calendar for agents, never a page builder.
      expect(String(text)).not.toMatch(/booking page|página de reservas/i);
    }
  });

  it("reads well under a fork's neutral default name", async () => {
    const { generateMetadata } = await loadLayout();
    const meta = await generateMetadata();
    expect(meta.title).toBe('Calendars: calendars for AI agents');
    expect(String(meta.description)).not.toMatch(/dapta/i);
  });

  it('is in the admin language on a product route', async () => {
    const { generateMetadata } = await loadLayout('dCal');
    request.headers = { 'x-slate-path': '/admin', 'accept-language': 'es-ES' };
    expect((await generateMetadata()).title).toBe('dCal: calendars for AI agents');
    request.cookie = 'es';
    expect((await generateMetadata()).title).toBe('dCal: calendarios para agentes de IA');
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

  it('is English on a booking page unless ?lang= says otherwise', async () => {
    request.headers['accept-language'] = 'es-CO,es;q=0.9';
    expect(await langOf()).toBe('en');
    request.headers = { 'x-slate-path': '/acme/alex-rivera', 'x-slate-query': '?lang=es' };
    expect(await langOf()).toBe('es');
    request.headers = { 'x-slate-path': '/acme/alex-rivera', 'accept-language': 'en-US' };
    expect(await langOf()).toBe('en');
  });

  it("is the admin's language on a product route", async () => {
    request.headers = { 'x-slate-path': '/onboarding', 'accept-language': 'es-PE' };
    expect(await langOf()).toBe('en');
    request.cookie = 'es';
    expect(await langOf()).toBe('es');
  });
});
