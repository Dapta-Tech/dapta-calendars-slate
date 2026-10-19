import { describe, expect, it } from 'vitest';
import { docsNavHref, resolveDocsUrl } from './docs-url';

/**
 * The rail's Docs item comes from the deployment's runtime env, in the reader's
 * language, and a deployment that says nothing gets no item at all.
 */
describe('resolveDocsUrl', () => {
  it('is null when nothing is set, the bare-fork default that hides the item', () => {
    expect(resolveDocsUrl('en', {})).toBeNull();
    expect(resolveDocsUrl('es', {})).toBeNull();
  });

  it('uses DOCS_URL for every language that has no address of its own', () => {
    const env = { DOCS_URL: 'https://docs.example.test/' };
    expect(resolveDocsUrl('en', env)).toBe('https://docs.example.test/');
    expect(resolveDocsUrl('es', env)).toBe('https://docs.example.test/');
  });

  it('sends Spanish readers to DOCS_URL_ES when it is set, and nobody else', () => {
    const env = { DOCS_URL: 'https://docs.example.test/', DOCS_URL_ES: 'https://docs.example.test/es/intro' };
    expect(resolveDocsUrl('es', env)).toBe('https://docs.example.test/es/intro');
    expect(resolveDocsUrl('en', env)).toBe('https://docs.example.test/');
  });

  it('serves Spanish readers their own docs even with no default set', () => {
    expect(resolveDocsUrl('es', { DOCS_URL_ES: 'https://docs.example.test/es' })).toBe('https://docs.example.test/es');
    expect(resolveDocsUrl('en', { DOCS_URL_ES: 'https://docs.example.test/es' })).toBeNull();
  });

  it('treats anything that is not an http(s) URL as unset, so a typo hides the item', () => {
    for (const bad of ['', '   ', 'docs.example.test', 'javascript:alert(1)', 'ftp://docs.example.test/', 'mailto:a@b.c']) {
      expect(resolveDocsUrl('en', { DOCS_URL: bad })).toBeNull();
    }
    // A broken language-specific value falls back instead of hiding the item.
    expect(resolveDocsUrl('es', { DOCS_URL: 'https://docs.example.test/', DOCS_URL_ES: 'nope' })).toBe(
      'https://docs.example.test/',
    );
  });

  it('trims the value', () => {
    expect(resolveDocsUrl('en', { DOCS_URL: '  https://docs.example.test/en  ' })).toBe('https://docs.example.test/en');
  });
});

describe('docsNavHref', () => {
  it('tags the link as a click from this app’s sidebar', () => {
    const href = docsNavHref('en', { DOCS_URL: 'https://docs.example.test/start' });
    const url = new URL(href!);
    expect(url.origin + url.pathname).toBe('https://docs.example.test/start');
    expect(url.searchParams.get('utm_source')).toBe('calendars');
    expect(url.searchParams.get('utm_medium')).toBe('sidebar');
  });

  it('keeps a query and a fragment the deployment put in the address', () => {
    const url = new URL(docsNavHref('es', { DOCS_URL_ES: 'https://docs.example.test/es?lang=es#start' })!);
    expect(url.searchParams.get('lang')).toBe('es');
    expect(url.hash).toBe('#start');
    expect(url.searchParams.get('utm_medium')).toBe('sidebar');
  });

  it('is null when there is no docs address', () => {
    expect(docsNavHref('en', {})).toBeNull();
  });
});
