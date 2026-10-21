import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadServerEnv, serverEnvSchema } from '@slate/config/env';
import { DocsController } from './controllers';
import { openapiFor, openapiSpec } from './openapi';
import { ENV } from './tokens';

const OLD_HOSTS = /calendars?(-api)?\.dapta\.(ai|dev)|calendar-api\.dapta/;

/** A URL with userinfo, built at runtime so no credential-looking literal sits in the source. */
const withUserinfo = (url: string, username: string, password: string): string => {
  const u = new URL(url);
  u.username = username;
  u.password = password;
  return u.href;
};

/** The controller as the app builds it: API_PUBLIC_URL through the env schema. */
const docsFor = (apiPublicUrl?: string) =>
  new DocsController(serverEnvSchema.parse(apiPublicUrl === undefined ? {} : { API_PUBLIC_URL: apiPublicUrl }));

describe('DocsController: the deployment address', () => {
  it('names no hardcoded host when API_PUBLIC_URL is unset', () => {
    const docs = docsFor();
    expect(docs.spec().servers).toEqual([{ url: '/', description: 'This deployment' }]);
    const html = docs.docs();
    expect(html).not.toMatch(OLD_HOSTS);
    expect(html).toContain('<span id="base-url">https://api.your-domain.example</span>');
    expect(html).toContain("document.getElementById('base-url').textContent=location.origin");
    expect(html).toContain("location.pathname.replace(/\\/docs\\/?$/i,'')");
    expect(html).toContain('/^[A-Za-z0-9._~%\\/-]*$/.test(p)?p:');
    expect(html).toContain("Replace <code>BASE_URL</code> with this page's address minus <code>/docs</code>.");
    expect(html).toContain('data-url="/openapi.json"');
    expect(html).toContain('<a href="/openapi.json">the raw OpenAPI document</a>');
    expect(JSON.stringify(openapiSpec)).not.toMatch(OLD_HOSTS);
  });

  it('names API_PUBLIC_URL in servers and the examples when set', () => {
    const docs = docsFor('https://api.calendar.example.com/');
    expect(docs.spec().servers).toEqual([{ url: 'https://api.calendar.example.com', description: 'This deployment' }]);
    const html = docs.docs();
    expect(html).toContain('BASE_URL="<span id="base-url">https://api.calendar.example.com</span>"');
    expect(html).not.toContain("getElementById('base-url')");
    expect(html).not.toContain('<noscript><p>Replace');
    expect(html).toContain('<a href="https://api.calendar.example.com/openapi.json"><code>/openapi.json</code></a>');
    expect(html).toContain('<a href="https://api.calendar.example.com/openapi.json">the raw OpenAPI document</a>');
    expect(html).not.toContain('href="/openapi.json"');
  });

  it('loads the explorer document from the page origin, path prefix kept', () => {
    expect(docsFor('https://api.calendar.example.com').docs()).toContain('data-url="/openapi.json"');
    const prefixed = docsFor('https://host.example.com/calendar-api/').docs();
    expect(prefixed).toContain('data-url="/calendar-api/openapi.json"');
    expect(prefixed).toContain('<a href="https://host.example.com/calendar-api/openapi.json">');
  });

  it('escapes the address in the page (defense in depth: the schema already encodes these)', () => {
    // Built directly, bypassing the schema, so the characters reach the page raw.
    const html = new DocsController({ API_PUBLIC_URL: 'https://api.example.com/a"<b>' }).docs();
    expect(html).toContain('https://api.example.com/a&quot;&lt;b&gt;');
    expect(html).not.toContain('a"<b>');
  });

  it('keeps every path of the document whichever address it names', () => {
    expect(openapiFor('https://api.example.com').paths).toBe(openapiSpec.paths);
  });

  it('gets API_PUBLIC_URL from the ENV provider when Nest builds it', async () => {
    @Module({
      controllers: [DocsController],
      providers: [
        {
          provide: ENV,
          useValue: loadServerEnv({ NODE_ENV: 'test', API_PUBLIC_URL: 'https://api.example.com/x/' } as NodeJS.ProcessEnv),
        },
      ],
    })
    class WiredModule {}
    const app = await NestFactory.createApplicationContext(WiredModule, { logger: false });
    try {
      expect(app.get(DocsController).spec().servers).toEqual([
        { url: 'https://api.example.com/x', description: 'This deployment' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('refuses to boot without an ENV provider instead of going relative', async () => {
    @Module({ controllers: [DocsController] })
    class UnwiredModule {}
    await expect(
      NestFactory.createApplicationContext(UnwiredModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow(/resolve dependencies of the DocsController/);
  });
});

describe('API_PUBLIC_URL parsing', () => {
  const parse = (v?: string) => serverEnvSchema.parse(v === undefined ? {} : { API_PUBLIC_URL: v }).API_PUBLIC_URL;

  it('normalizes like the web: trimmed, origin plus path, no trailing slash', () => {
    expect(parse(' https://API.Example.com/calendar-api/ ')).toBe('https://api.example.com/calendar-api');
    expect(parse('https://api.example.com')).toBe('https://api.example.com');
    expect(parse('HTTPS://API.EXAMPLE.COM/')).toBe('https://api.example.com');
    expect(parse('http://[::1]:4000/')).toBe('http://[::1]:4000');
    expect(parse('https://api.example.com:443/v1')).toBe('https://api.example.com/v1');
    expect(parse('http://api.example.com:80')).toBe('http://api.example.com');
    expect(parse('https://api.example.com:8443/')).toBe('https://api.example.com:8443');
  });

  it('reads unset, empty, non-http(s) and malformed values as unset without failing', () => {
    for (const v of [undefined, '', '   ', 'ftp://api.example.com', 'javascript:alert(1)', 'not a url']) {
      expect(parse(v)).toBeUndefined();
    }
  });

  it('reads credentials, a query or a fragment as unset: the address is published and extended', () => {
    for (const v of [
      withUserinfo('https://api.example.com', 'user', 'secret'),
      withUserinfo('https://api.example.com', 'user', ''),
      withUserinfo('https://api.example.com', '', 'secret'),
      'https://api.example.com/?x=1',
      'https://api.example.com?token=abc',
      'https://api.example.com/#frag',
    ]) {
      expect(parse(v)).toBeUndefined();
    }
  });
});
