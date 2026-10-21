import { describe, it, expect } from 'vitest';
import { DocsController } from './controllers';
import { serverEnvSchema } from '@slate/config/env';
import { openapiFor, openapiSpec } from './openapi';

const OLD_HOSTS = /calendars?(-api)?\.dapta\.(ai|dev)|calendar-api\.dapta/;

describe('DocsController: the deployment address', () => {
  it('names no hardcoded host when API_PUBLIC_URL is unset', () => {
    const docs = new DocsController({ API_PUBLIC_URL: undefined });
    expect(docs.spec().servers).toEqual([{ url: '/', description: 'This deployment' }]);
    const html = docs.docs();
    expect(html).not.toMatch(OLD_HOSTS);
    expect(html).toContain('<span id="base-url">https://api.your-domain.example</span>');
    expect(html).toContain("document.getElementById('base-url').textContent=location.origin");
    expect(html).toContain("location.pathname.replace(/\\/docs\\/?$/i,'')");
    expect(html).toContain('/^[A-Za-z0-9._~%\\/-]*$/.test(p)?p:');
    expect(html).toContain("Replace <code>BASE_URL</code> with this page's address minus <code>/docs</code>.");
    expect(html).toContain('data-url="/openapi.json"');
    expect(JSON.stringify(openapiSpec)).not.toMatch(OLD_HOSTS);
  });

  it('names API_PUBLIC_URL in servers and the examples when set', () => {
    const docs = new DocsController({ API_PUBLIC_URL: 'https://api.calendar.example.com/' });
    expect(docs.spec().servers).toEqual([{ url: 'https://api.calendar.example.com', description: 'This deployment' }]);
    const html = docs.docs();
    expect(html).toContain('BASE_URL="<span id="base-url">https://api.calendar.example.com</span>"');
    expect(html).not.toContain("getElementById('base-url')");
    expect(html).not.toContain('<noscript><p>Replace');
    expect(html).toContain('data-url="https://api.calendar.example.com/openapi.json"');
    expect(html).toContain('<a href="https://api.calendar.example.com/openapi.json"><code>/openapi.json</code></a>');
    expect(html).toContain('<a href="https://api.calendar.example.com/openapi.json">the raw OpenAPI document</a>');
    expect(html).not.toContain('href="/openapi.json"');
  });

  it('escapes the configured address in the page', () => {
    const html = new DocsController({ API_PUBLIC_URL: 'https://api.example.com/a"<b>' }).docs();
    expect(html).toContain('https://api.example.com/a&quot;&lt;b&gt;');
  });

  it('keeps every path of the document whichever address it names', () => {
    expect(openapiFor('https://api.example.com').paths).toBe(openapiSpec.paths);
  });
});

describe('API_PUBLIC_URL parsing', () => {
  const parse = (v?: string) => serverEnvSchema.parse(v === undefined ? {} : { API_PUBLIC_URL: v }).API_PUBLIC_URL;

  it('normalizes like the web: trimmed, URL.href, no trailing slash', () => {
    expect(parse(' https://API.Example.com/calendar-api/ ')).toBe('https://api.example.com/calendar-api');
    expect(parse('https://api.example.com')).toBe('https://api.example.com');
  });

  it('reads unset, empty, non-http(s) and malformed values as unset without failing', () => {
    for (const v of [undefined, '', '   ', 'ftp://api.example.com', 'javascript:alert(1)', 'not a url']) {
      expect(parse(v)).toBeUndefined();
    }
  });
});
