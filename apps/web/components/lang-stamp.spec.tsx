// @vitest-environment jsdom
/**
 * `<html lang>` across client navigations: the server's rule, re-applied per
 * route from the two answers the server handed over, and nothing written on the
 * full load the server already stamped.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const route = vi.hoisted(() => ({ pathname: '/admin', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));

import { LangStamp } from './lang-stamp';
import { documentLangFor } from '@/lib/document-lang';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const answers = { product: 'en', visitor: 'es' } as const;

describe('documentLangFor', () => {
  it("answers a product route with the admin's language", () => {
    expect(documentLangFor('/admin/bookings', '?lang=es', answers)).toBe('en');
    expect(documentLangFor('/', '', answers)).toBe('en');
  });

  it("answers a public route with ?lang=, else the visitor's language", () => {
    expect(documentLangFor('/acme/alex-rivera', '', answers)).toBe('es');
    expect(documentLangFor('/acme/alex-rivera', '?lang=en', answers)).toBe('en');
    expect(documentLangFor('/acme/alex-rivera', 'lang=es-MX', { product: 'en', visitor: 'en' })).toBe('es');
  });

  it('treats an unknown path as public', () => {
    expect(documentLangFor('', '', answers)).toBe('es');
  });
});

describe('LangStamp', () => {
  async function render() {
    await act(async () => root!.render(<LangStamp product={answers.product} visitor={answers.visitor} />));
  }

  it('leaves the full load alone, then follows each client navigation', async () => {
    document.documentElement.lang = 'en';
    route.pathname = '/';
    route.search = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
    expect(document.documentElement.lang).toBe('en');

    // The OSS landing's demo link: product to a booking page.
    route.pathname = '/acme/alex-rivera';
    await render();
    expect(document.documentElement.lang).toBe('es');

    // The not-found page's way home: back to the product.
    route.pathname = '/';
    await render();
    expect(document.documentElement.lang).toBe('en');

    // A booking link that names its language.
    route.pathname = '/acme/alex-rivera/intro-call';
    route.search = 'lang=en';
    await render();
    expect(document.documentElement.lang).toBe('en');
  });
});
