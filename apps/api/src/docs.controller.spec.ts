import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadServerEnv, serverEnvSchema } from '@slate/config/env';
import { DocsController } from './controllers';
import { apiIntroduction, CAL_VERSION_PINS, openapiFor, openapiSpec } from './openapi';
import { FONT_STYLESHEET, SCALAR_SCRIPT, SCALAR_VERSION } from './docs-page';
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

/** The explorer configuration as Scalar reads it from the page. */
const configOf = (html: string) => {
  const raw = /<script id="api-reference" data-configuration="([^"]*)"><\/script>/.exec(html)?.[1];
  if (raw === undefined) throw new Error('no explorer configuration on the page');
  return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
};

describe('DocsController: the deployment address', () => {
  it('names no hardcoded host when API_PUBLIC_URL is unset', () => {
    const docs = docsFor();
    expect(docs.spec().servers).toEqual([{ url: '/', description: 'This deployment' }]);
    const html = docs.docs();
    expect(html).not.toMatch(OLD_HOSTS);
    expect(configOf(html).url).toBe('/openapi.json');
    expect(html).toContain('<a href="/openapi.json" style="color:inherit">the raw OpenAPI document</a>');
    expect(docs.spec().info.description).toContain('**Base URL:** the address this API is served at');
    // The way to the raw document from inside the reference, on this address.
    expect(docs.spec().info.description).toContain('**OpenAPI document:** [`/openapi.json`](/openapi.json)');
    expect(JSON.stringify(openapiSpec)).not.toMatch(OLD_HOSTS);
  });

  it('names API_PUBLIC_URL in servers and the introduction when set', () => {
    const docs = docsFor('https://api.calendar.example.com/');
    expect(docs.spec().servers).toEqual([{ url: 'https://api.calendar.example.com', description: 'This deployment' }]);
    expect(docs.spec().info.description).toContain('**Base URL:** `https://api.calendar.example.com`');
    expect(docs.spec().info.description).toContain(
      '**OpenAPI document:** [`https://api.calendar.example.com/openapi.json`](https://api.calendar.example.com/openapi.json)',
    );
    const html = docs.docs();
    expect(html).toContain('<a href="https://api.calendar.example.com/openapi.json" style="color:inherit">');
    expect(html).not.toContain('href="/openapi.json"');
  });

  it('loads the explorer document from the page origin, path prefix kept', () => {
    expect(configOf(docsFor('https://api.calendar.example.com').docs()).url).toBe('/openapi.json');
    const prefixed = docsFor('https://host.example.com/calendar-api/').docs();
    expect(configOf(prefixed).url).toBe('/calendar-api/openapi.json');
    expect(prefixed).toContain('<a href="https://host.example.com/calendar-api/openapi.json"');
  });

  it('escapes the address in the page (defense in depth: the schema already encodes these)', () => {
    // Built directly, bypassing the schema, so the characters reach the page raw.
    const html = new DocsController({ API_PUBLIC_URL: 'https://api.example.com/a"<b>' }).docs();
    expect(html).toContain('https://api.example.com/a&quot;&lt;b&gt;');
    expect(html).not.toContain('a"<b>');
  });

  it("names the deployment's product: PRODUCT_NAME, else the mail sender name", () => {
    const named = new DocsController({ API_PUBLIC_URL: undefined, PRODUCT_NAME: 'dCal', MAIL_FROM_NAME: 'Other' });
    expect(named.spec().info.title).toBe('dCal API');
    expect(named.docs()).toContain('<title>dCal API</title>');
    expect(new DocsController({ API_PUBLIC_URL: undefined, MAIL_FROM_NAME: 'Acme' }).spec().info.title).toBe('Acme API');
    // A fork with nothing set reads the env schema's default sender name.
    expect(docsFor().spec().info.title).toBe('Calendars API');
    expect(docsFor().docs()).toContain('<title>Calendars API</title>');
    expect(JSON.stringify(openapiSpec)).not.toMatch(/dapta calendars/i);
  });

  it('escapes the product name in the page', () => {
    const html = new DocsController({ API_PUBLIC_URL: undefined, PRODUCT_NAME: 'A<b>"c' }).docs();
    expect(html).toContain('<title>A&lt;b&gt;&quot;c API</title>');
    expect(html).not.toContain('A<b>');
  });

  it('keeps every path of the document whichever address it names', () => {
    expect(openapiFor('https://api.example.com').paths).toBe(openapiSpec.paths);
    expect(openapiFor(undefined, 'dCal').paths).toBe(openapiSpec.paths);
    expect(openapiFor(undefined, 'dCal').servers).toEqual(openapiSpec.servers);
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

/** Every address a dCal-like deployment configures, through the env schema. */
const configured = (overrides: Record<string, string> = {}) =>
  new DocsController(
    serverEnvSchema.parse({
      API_PUBLIC_URL: 'https://api.calendar.example.com',
      PUBLIC_APP_URL: 'https://app.calendar.example.com',
      MCP_PUBLIC_URL: 'https://mcp.calendar.example.com/mcp',
      DEVELOPER_DOCS_URL: 'https://docs.calendar.example.com/developers/',
      PRODUCT_NAME: 'dCal',
      ...overrides,
    }),
  );

describe('DocsController: one reference page', () => {
  it('is the Scalar reference alone: no second introduction above it', () => {
    const html = configured().docs();
    for (const tag of ['<main', '<h1', '<h2', '<pre', '<code']) expect(html).not.toContain(tag);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html.match(/<script src=/g)).toHaveLength(1);
  });

  it('loads Scalar and the font pinned to an exact version, with Subresource Integrity', () => {
    const html = configured().docs();
    expect(SCALAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(html).toContain(
      `<script src="${SCALAR_SCRIPT.src}" integrity="${SCALAR_SCRIPT.integrity}" crossorigin="anonymous"></script>`,
    );
    expect(SCALAR_SCRIPT.src).toContain(`@scalar/api-reference@${SCALAR_VERSION}/`);
    expect(html).toContain(`href="${FONT_STYLESHEET.href}" integrity="${FONT_STYLESHEET.integrity}" crossorigin="anonymous"`);
    expect(FONT_STYLESHEET.href).toMatch(/@\d+\.\d+\.\d+\//);
    for (const sri of [SCALAR_SCRIPT.integrity, FONT_STYLESHEET.integrity]) expect(sri).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  it('keeps the explorer from reporting to or chatting through Scalar', () => {
    const config = configOf(configured().docs());
    expect(config).toMatchObject({
      telemetry: false,
      agent: { disabled: true },
      mcp: { disabled: true },
      showDeveloperTools: 'never',
      withDefaultFonts: false,
    });
  });

  it("shows the web app's icon when the dashboard's address is known", () => {
    expect(configured().docs()).toContain('<link rel="icon" type="image/svg+xml" href="https://app.calendar.example.com/icon.svg">');
  });
});

describe('DocsController: the introduction', () => {
  it('names the configured keys page, MCP server and guides', () => {
    const intro = configured().spec().info.description;
    expect(intro).toContain('**Base URL:** `https://api.calendar.example.com`');
    expect(intro).toContain('[API keys](https://app.calendar.example.com/admin/developers/keys)');
    expect(intro).toContain('the MCP server at `https://mcp.calendar.example.com/mcp`');
    expect(intro).toContain('[developer docs](https://docs.calendar.example.com/developers)');
    expect(intro).toContain('Authorization: Bearer dcl_');
    expect(intro).toContain('never put a key in a URL');
    expect(intro).toContain('`Idempotency-Key`');
    for (const [op, version] of CAL_VERSION_PINS) expect(intro).toContain(`| \`${op}\` | \`${version}\` |`);
  });

  it('leaves out what is not configured instead of naming another host', () => {
    const intro = configured({ MCP_PUBLIC_URL: '', DEVELOPER_DOCS_URL: '' }).spec().info.description;
    expect(intro).not.toContain('MCP server');
    expect(intro).not.toContain('developer docs');
    expect(intro).not.toContain('## More');
    expect(configured({ MCP_ENABLED: 'false' }).spec().info.description).not.toContain('MCP server');
    expect(apiIntroduction()).not.toMatch(/https?:\/\//);
  });

  it('keeps the keys link and icon when the dashboard address carries a query or fragment', () => {
    const docs = new DocsController({
      API_PUBLIC_URL: undefined,
      PUBLIC_APP_URL: 'https://app.calendar.example.com/?utm_source=x#top',
    });
    expect(docs.spec().info.description).toContain('[API keys](https://app.calendar.example.com/admin/developers/keys)');
    expect(docs.docs()).toContain('href="https://app.calendar.example.com/icon.svg"');
  });

  it('publishes the MCP address as the dashboard shows it, never with credentials, a query or a fragment', () => {
    const intro = (MCP_PUBLIC_URL: string) =>
      new DocsController({ API_PUBLIC_URL: undefined, MCP_ENABLED: true, MCP_PUBLIC_URL }).spec().info.description;
    expect(intro('https://mcp.calendar.example.com/mcp/')).toContain('`https://mcp.calendar.example.com/mcp`');
    for (const bad of [
      'https://mcp.calendar.example.com/mcp?token=abc',
      'https://mcp.calendar.example.com/mcp#frag',
      withUserinfo('https://mcp.calendar.example.com/mcp', 'user', 'secret'),
    ]) {
      expect(intro(bad)).not.toContain('MCP server');
    }
  });

  it('keeps a configured address from breaking out of its markdown link', () => {
    expect(apiIntroduction({ docsUrl: 'https://docs.example.com/a(b) c' })).toContain(
      '[developer docs](https://docs.example.com/a%28b%29%20c)',
    );
  });

  it('speaks to the people who call the API: no internal names, a clean version', () => {
    for (const doc of [openapiSpec, configured().spec()]) {
      expect(doc.info.description).not.toMatch(/flow studio|vault|pilot|\bmvp\b|\.md\b|repository|dapta/i);
      expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
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
