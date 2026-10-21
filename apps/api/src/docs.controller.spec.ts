import { describe, it, expect } from 'vitest';
import { DocsController } from './controllers';
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
    expect(JSON.stringify(openapiSpec)).not.toMatch(OLD_HOSTS);
  });

  it('names API_PUBLIC_URL in servers and the examples when set', () => {
    const docs = new DocsController({ API_PUBLIC_URL: 'https://api.calendar.example.com/' });
    expect(docs.spec().servers).toEqual([{ url: 'https://api.calendar.example.com', description: 'This deployment' }]);
    const html = docs.docs();
    expect(html).toContain('BASE_URL="<span id="base-url">https://api.calendar.example.com</span>"');
    expect(html).not.toContain("getElementById('base-url')");
  });

  it('escapes the configured address in the page', () => {
    const html = new DocsController({ API_PUBLIC_URL: 'https://api.example.com/a"<b>' }).docs();
    expect(html).toContain('https://api.example.com/a&quot;&lt;b&gt;');
  });

  it('keeps every path of the document whichever address it names', () => {
    expect(openapiFor('https://api.example.com').paths).toBe(openapiSpec.paths);
  });
});
