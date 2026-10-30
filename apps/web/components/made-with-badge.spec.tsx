/**
 * The "Made with" badge says everything in the page's language, including the
 * part only a screen reader hears: a Spanish page whose badge ended in
 * "(opens in a new tab)" was finding F2 of the 2026-10-30 production E2E.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const env = vi.hoisted(() => {
  const saved = {
    NEXT_PUBLIC_SIGNUP_URL: process.env.NEXT_PUBLIC_SIGNUP_URL,
    NEXT_PUBLIC_HIDE_BADGE: process.env.NEXT_PUBLIC_HIDE_BADGE,
    NEXT_PUBLIC_PRODUCT_NAME: process.env.NEXT_PUBLIC_PRODUCT_NAME,
  };
  process.env.NEXT_PUBLIC_SIGNUP_URL = 'https://example.com/signup';
  delete process.env.NEXT_PUBLIC_HIDE_BADGE;
  process.env.NEXT_PUBLIC_PRODUCT_NAME = 'Dapta Calendars';
  return saved;
});

import { MadeWithBadge } from './made-with-badge';

afterAll(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const badge = (locale: string) => renderToStaticMarkup(<MadeWithBadge locale={locale} accountCode="northwind" show />);

describe('MadeWithBadge', () => {
  it('tells a screen reader the link opens a new tab, in English on an English page', () => {
    const html = badge('en');
    expect(html).toContain('<span>Made with dCal.ai by Dapta</span>');
    expect(html).toContain('<span class="sr-only">(opens in a new tab)</span>');
  });

  it('says it in Spanish on a Spanish page, with no English left in the link', () => {
    const html = badge('es');
    expect(html).toContain('<span>Hecho con dCal.ai de Dapta</span>');
    expect(html).toContain('<span class="sr-only">(se abre en una pestaña nueva)</span>');
    expect(html).not.toContain('opens in a new tab');
  });

  it('keeps the account code on the link in either language', () => {
    expect(badge('es')).toContain('utm_content=northwind');
  });
});
