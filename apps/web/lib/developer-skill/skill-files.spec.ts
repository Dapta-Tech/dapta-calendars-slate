import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getMessages } from '@slate/shared';
// The API's real description, the very object it serves at /openapi.json. It
// has no imports, so the web spec can read it straight from the API's source.
import { openapiSpec } from '../../../api/src/openapi';
import { API_KEY_ENV, KEY_PREFIX, MCP_TOOLS, SCOPE_CATALOG } from '../mcp-connect';
import { parseOpenApi, type OpenApiDocument } from './openapi-doc';
import { buildSkillFiles, requiredOnly, SKILL_DIR } from './skill-files';

/** As the route has it: the document after a trip through JSON. */
const REAL = parseOpenApi(JSON.parse(JSON.stringify(openapiSpec)))!;

const URLS = {
  apiUrl: 'https://api.calendar.example.com',
  mcpUrl: 'https://api.calendar.example.com/mcp',
  appUrl: 'https://calendar.example.com',
  productName: 'Dapta Calendars',
};

const build = (openapi: OpenApiDocument = REAL, over: Partial<typeof URLS> = {}) =>
  new Map(buildSkillFiles({ ...URLS, ...over, openapi }).map((f) => [f.path.slice(SKILL_DIR.length + 1), f.content]));

const files = build();
const get = (path: string) => files.get(path)!;
const markdown = [...files].filter(([p]) => p.endsWith('.md'));

/** Every operation in the raw document, worked out here without the skill's own helpers. */
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const rawOperations = (doc: { paths: Record<string, object> }): string[] =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((m) => METHODS.has(m))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );

/** Each `### \`METHOD /path\`` heading of the endpoint reference. */
const headings = (md: string): string[] => [...md.matchAll(/^### `([A-Z]+ \/[^`]*)`$/gm)].map((m) => m[1]!);

/** Every `METHOD /path` the files mention anywhere, in prose, tables or headings. */
const mentions = (md: string): string[] =>
  [...md.matchAll(/\b(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS) (\/[A-Za-z0-9_{}./-]*)/g)].map(
    // A sentence may end right after a path: its full stop is not part of it.
    (m) => `${m[1]} ${m[2]!.replace(/\.+$/, '')}`,
  );

/** A host of the vendor's own domains, and its internal names, built so this file holds none of them. */
const VENDOR_HOST = new RegExp(['[a-z0-9-]+\\.', 'dap', 'ta\\.(ai|dev|com)'].join(''), 'i');
const VENDOR_WORDS = new RegExp(['dap', 'tatech|amazon', 'aws|aur', 'ora|m', 'embrane|int', 'egration\\.app|work', 'os'].join(''), 'i');
const DASHES = /\u2014|\u2013/;
/** The shape of a real key: `dcl_` + 8 hex + `_` + the secret. */
const REAL_KEY = /dcl_[0-9a-f]{8}_[A-Za-z0-9_-]{16,}/;

const en = getMessages('en').admin.developer;

describe('buildSkillFiles', () => {
  it('ships SKILL.md, the install note and the references, inside one folder', () => {
    expect(SKILL_DIR).toBe('dapta-calendars');
    expect([...files.keys()].sort()).toEqual([
      'INSTALL.md',
      'SKILL.md',
      'reference/endpoints.md',
      'reference/mcp-tools.md',
      'reference/openapi.json',
    ]);
    for (const f of buildSkillFiles({ ...URLS, openapi: REAL })) expect(f.path.startsWith(`${SKILL_DIR}/`)).toBe(true);
  });

  it('opens SKILL.md with frontmatter that names the skill and says when to use it', () => {
    const front = /^---\nname: dapta-calendars\ndescription: (".+")\n---\n/.exec(get('SKILL.md'));
    expect(front).not.toBeNull();
    const description = JSON.parse(front![1]!) as string;
    expect(description).toMatch(/Use it whenever/);
    expect(description).toContain('Dapta Calendars');
  });

  it('keeps the frontmatter valid whatever the product is called', () => {
    const skill = build(REAL, { productName: 'Acme: "Book"' }).get('SKILL.md')!;
    const line = /^description: (.+)$/m.exec(skill)![1]!;
    // A double-quoted YAML scalar takes JSON escapes, so a colon or a quote cannot break it.
    expect(JSON.parse(line)).toContain('Acme: "Book"');
  });

  describe('no invented endpoints', () => {
    it('lists exactly the operations of the OpenAPI document, each once', () => {
      const listed = headings(get('reference/endpoints.md'));
      expect(listed.sort()).toEqual(rawOperations(openapiSpec).sort());
      expect(new Set(listed).size).toBe(listed.length);
      expect(get('reference/endpoints.md')).toContain(`${rawOperations(openapiSpec).length} operations`);
    });

    it('names no route anywhere that the document does not have', () => {
      const real = new Set(rawOperations(openapiSpec));
      for (const [path, md] of markdown) {
        for (const op of mentions(md)) expect(real.has(op), `${path}: ${op}`).toBe(true);
      }
    });

    it('leaves out what a smaller API does not serve, and still names nothing else', () => {
      const small = parseOpenApi({
        openapi: '3.1.0',
        components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
        paths: {
          '/v1/machine/bookings': { get: { summary: 'List', security: [{ key: [] }], responses: { 200: { description: 'ok' } } } },
          '/health': { get: { summary: 'Probe', responses: { 200: { description: 'ok' } } } },
        },
      })!;
      const out = build(small);
      expect(headings(out.get('reference/endpoints.md')!)).toEqual(['GET /v1/machine/bookings', 'GET /health']);
      for (const [path, md] of [...out].filter(([p]) => p.endsWith('.md'))) {
        for (const op of mentions(md)) expect(['GET /v1/machine/bookings', 'GET /health'], `${path}: ${op}`).toContain(op);
      }
      const skill = out.get('SKILL.md')!;
      expect(skill).not.toContain('## Book a meeting');
      expect(skill).not.toContain('cal-api-version');
      expect(skill).toContain('`GET /v1/machine/bookings`');
    });

    it('takes every version pin from the document', () => {
      const rows = [...get('SKILL.md').matchAll(/^ {3}\| `([A-Z]+) ([^`]+)` \| `([^`]+)` \|$/gm)];
      expect(rows.length).toBeGreaterThan(0);
      type Op = { parameters?: Array<{ name?: string; schema?: { enum?: string[] } }> };
      const paths = (JSON.parse(JSON.stringify(openapiSpec)) as { paths: Record<string, Record<string, Op>> }).paths;
      for (const [, method, path, value] of rows) {
        const header = paths[path!]![method!.toLowerCase()]!.parameters!.find((p) => p.name === 'cal-api-version');
        expect(header?.schema?.enum, `${method} ${path}`).toEqual([value]);
      }
    });

    it('keeps a version row on one line, whatever the pin holds', () => {
      const pinned = parseOpenApi({
        openapi: '3.1.0',
        paths: {
          '/v2/things': {
            get: {
              parameters: [{ name: 'cal-api-version', in: 'header', required: true, schema: { enum: ['a\rb|c'] } }],
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      })!;
      const skill = build(pinned).get('SKILL.md')!;
      expect(skill).not.toMatch(/\r/);
      expect(skill).toContain('   | `GET /v2/things` | `a b\\|c` |');
    });

    it('books with the parameters, fields and answers the document defines', () => {
      const skill = get('SKILL.md');
      const slots = openapiSpec.paths['/v2/slots'].get.parameters.map((p) => p.name);
      for (const [, name] of skill.matchAll(/--data-urlencode "([A-Za-z]+)=/g)) expect(slots).toContain(name);
      const body = JSON.parse(/--data '(.+)'$/m.exec(skill)![1]!);
      expect(Object.keys(body)).toEqual(['eventTypeId', 'start', 'attendee']);
      expect(Object.keys(body.attendee)).toEqual(openapiSpec.components.schemas.CalAttendeeInput.required);
      // The fields the prose tells the agent to read off the answers.
      expect(openapiSpec.components.schemas.EventType.properties).toHaveProperty('id');
      expect(openapiSpec.components.schemas.Slot.properties).toHaveProperty('start');
      expect(openapiSpec.components.schemas.Booking.properties).toHaveProperty('uid');
      // An event type with a required question refuses a booking that leaves it out.
      expect(openapiSpec.components.schemas.EventType.properties).toHaveProperty('bookingFields');
      const bookingBody = openapiSpec.paths['/v2/bookings'].post.requestBody.content['application/json'].schema;
      expect((bookingBody as { properties: object }).properties).toHaveProperty('bookingFieldsResponses');
      expect(skill).toContain('answer every one marked `required` in `bookingFieldsResponses`');
      expect(skill).toContain('422 `BOOKING_FIELDS_INVALID`');
      expect(openapiSpec.paths['/v1/machine/bookings'].get.responses['200'].description).toBe('{items,nextCursor}');
      expect(openapiSpec.paths['/v1/machine/bookings'].get.parameters.map((p) => p.name)).toContain('cursor');
    });

    it('lists the /v2 error codes the document gives', () => {
      for (const code of openapiSpec.components.schemas.ErrorEnvelope.properties.error.properties.code.examples) {
        expect(get('SKILL.md'), code).toContain(`\`${code}\``);
      }
    });

    it('ships the document as served, with servers pointed at this installation', () => {
      const shipped = JSON.parse(get('reference/openapi.json'));
      expect(shipped.servers).toEqual([{ url: URLS.apiUrl, description: 'This installation' }]);
      const { servers: _shipped, ...rest } = shipped;
      const { servers: _served, ...served } = JSON.parse(JSON.stringify(openapiSpec));
      expect(rest).toEqual(served);
    });
  });

  it('lists exactly the MCP tools the dashboard shows, with their English copy and access', () => {
    const md = get('reference/mcp-tools.md');
    const rows = [...md.matchAll(/^\| `([a-z_]+)` \| (\w+) \| (.+?) \| (.+?) \|$/gm)];
    expect(rows.map((r) => r[1])).toEqual(MCP_TOOLS.map((t) => t.name));
    for (const tool of MCP_TOOLS) {
      const row = rows.find((r) => r[1] === tool.name)!;
      expect(row[4]).toBe(en.toolDescriptions[tool.name]);
      if (tool.scope) expect(row[3]).toContain(`\`${tool.scope}\``);
      else expect(row[3]).toBe(tool.publicOk ? en.toolNeedsNoKey : en.toolNeedsAnyKey);
    }
    expect(md).toContain(`\`${URLS.mcpUrl}\``);
  });

  it('lists every scope a key can carry, in the order the create form shows them', () => {
    const rows = [...get('SKILL.md').matchAll(/^\| `([a-z:-]+)` \| (.+?) \| (\w+) \|$/gm)];
    expect(rows.map((r) => r[1])).toEqual(SCOPE_CATALOG.map((s) => s.scope));
    for (const row of rows) expect(row[2]).toBe(en.scopeLabels[row[1]!]);
  });

  it('writes the environment addresses in and leaves no placeholder or local address behind', () => {
    expect(get('SKILL.md')).toContain(`\`${URLS.apiUrl}\``);
    expect(get('SKILL.md')).toContain(`\`${URLS.mcpUrl}\``);
    for (const path of ['SKILL.md', 'INSTALL.md']) {
      expect(get(path), path).toContain('https://calendar.example.com/admin/developers/keys');
      expect(get(path), path).toContain('https://calendar.example.com/admin/developers/docs');
    }
    expect(get('reference/endpoints.md')).toContain(`Base URL: \`${URLS.apiUrl}\``);
    for (const [path, content] of files) {
      expect(content, path).not.toMatch(/\$\{|undefined|null\/|localhost|127\.0\.0\.1/);
    }
    // Every curl goes to the public API address.
    for (const [path, md] of markdown) {
      for (const [, url] of md.matchAll(/curl [^"]*"([^"]+)"/g)) expect(url!.startsWith(`${URLS.apiUrl}/`), path).toBe(true);
    }
  });

  it('never carries a key: every snippet names the environment variable', () => {
    for (const [path, content] of files) expect(content, path).not.toMatch(REAL_KEY);
    for (const [path, md] of markdown) {
      for (const [, after] of md.matchAll(/Authorization: Bearer (\S+)/g)) {
        expect(after, path).toMatch(new RegExp(`^\\$${API_KEY_ENV}\\b`));
      }
    }
    expect(get('INSTALL.md')).toContain(`export ${API_KEY_ENV}="dcl_your_key_here"`);
  });

  it('states the rules the API code enforces', () => {
    const skill = get('SKILL.md');
    expect(skill).toContain('400 `UNSUPPORTED_API_VERSION`');
    expect(skill).toContain('409 `IDEMPOTENCY_KEY_REUSED`');
    expect(skill).toContain('`Retry-After`');
    expect(skill).toContain('quote `error.requestId`');
    expect(skill).toContain('{ "error": "CODE", "message": "..." }');
    expect(skill).toMatch(/Ask before you cancel/);
    // The key prefix the document's security scheme gives.
    expect(skill).toContain('Keys start with `dcl_`.');
  });

  it('says the reference covers the routes the API documents for integrations, not every route', () => {
    expect(get('SKILL.md')).toContain('lists the routes this installation\'s API documents for integrations');
    expect(get('reference/endpoints.md')).toContain("The routes this installation's API documents for integrations");
    for (const [path, md] of markdown) expect(md, path).not.toMatch(/every route (this installation|the API) serves/i);
  });

  describe('quotes a code, a field or a header only when the document carries it', () => {
    /** The real document with its error codes, request id and key prefix taken out. */
    const bare = (): OpenApiDocument => {
      const doc = JSON.parse(JSON.stringify(openapiSpec));
      delete doc.components.schemas.ErrorEnvelope.properties.error.properties.code.examples;
      delete doc.components.schemas.ErrorEnvelope.properties.error.properties.requestId;
      for (const scheme of Object.values(doc.components.securitySchemes) as Array<Record<string, unknown>>) {
        delete scheme.bearerFormat;
        delete scheme.description;
      }
      return parseOpenApi(doc)!;
    };

    it('drops the codes, the request id and the documented prefix when the document lacks them', () => {
      const skill = build(bare()).get('SKILL.md')!;
      for (const code of ['UNSUPPORTED_API_VERSION', 'IDEMPOTENCY_KEY_REUSED', 'BOOKING_FIELDS_INVALID']) {
        expect(skill, code).not.toContain(code);
      }
      // The document's own example envelope may still show one; the rule to quote it goes.
      expect(skill).not.toContain('quote `error.requestId`');
      // The rules themselves stay, without the promise of a code.
      expect(skill).toContain('a missing or different value is refused');
      expect(skill).toContain('take an `Idempotency-Key` header');
      // With no prefix in the document, the one this product mints.
      expect(skill).toContain(`Keys start with \`${KEY_PREFIX}\`.`);
    });

    it('names the X-Request-Id header only when an answer declares it', () => {
      expect(get('SKILL.md')).not.toContain('X-Request-Id');
      const doc = JSON.parse(JSON.stringify(openapiSpec));
      doc.paths['/v2/slots'].get.responses['400'].headers = { 'X-Request-Id': { schema: { type: 'string' } } };
      expect(build(parseOpenApi(doc)!).get('SKILL.md')).toContain('(also in the `X-Request-Id` header)');
    });
  });

  it('tells the agent how to read a booking refusal, as the API words it', () => {
    const skill = get('SKILL.md');
    expect(skill).toContain('read its `message`');
    // validateIntakeAnswers (packages/db) names the field by its label.
    expect(skill).toContain('by the field\'s `label` (`Missing required field: Company`)');
    expect(skill).toContain('find that label in `bookingFields` to get the `name` to answer');
    // Out of range, or a time the event does not offer, arrives under the same code.
    expect(skill).toContain('the start time is not offered, in the past or too far ahead');
  });

  it('says which REST routes take which scope where the label does not, from the catalog', () => {
    const skill = get('SKILL.md');
    const write = SCOPE_CATALOG.find((s) => s.kind === 'write')!.scope;
    const cancel = SCOPE_CATALOG.find((s) => s.kind === 'destructive')!.scope;
    expect(skill).toContain(`\`${write}\` also adds guests: \`POST /v2/bookings/{uid}/guests\`, \`POST /v1/machine/bookings/{uid}/attendees\`.`);
    expect(skill).toContain(
      `The REST cancel routes (\`POST /v2/bookings/{uid}/cancel\`, \`POST /v1/machine/bookings/{uid}/cancel\`) take \`${cancel}\` or \`${write}\`.`,
    );
    expect(skill).toContain(`The MCP tool \`cancel_booking\` takes only \`${cancel}\`.`);
    // Every scope the files name is one the catalog has.
    const known = new Set(SCOPE_CATALOG.map((s) => s.scope));
    for (const [path, md] of markdown) {
      for (const [scope] of md.matchAll(/\b[a-z-]+:(read|write|cancel)\b/g)) expect(known.has(scope), `${path}: ${scope}`).toBe(true);
    }
  });

  it('explains how to install it in Claude Code, Codex and Cursor, and to update it the same way', () => {
    const install = get('INSTALL.md');
    // `-o`: an update overwrites without asking about every file.
    expect(install).not.toMatch(/unzip (?!-o )/);
    expect(install).toContain('unzip -o dapta-calendars-skill.zip -d ~/.claude/skills/');
    // A second install does not add a second pointer to AGENTS.md.
    expect(install).toContain("grep -qs 'dapta-calendars/SKILL.md' AGENTS.md || cat >> AGENTS.md <<'EOF'");
    // The check names the scope the document says the route needs.
    expect(install).toContain('lacks `event-types:read`');
    expect(install).toContain('~/.claude/skills/dapta-calendars/SKILL.md');
    expect(install).toContain('AGENTS.md');
    expect(install).toContain('.cursor/rules/dapta-calendars.mdc');
  });

  it('carries no vendor host, no internal name and no dash in what it writes', () => {
    for (const [path, content] of files) {
      expect(content, path).not.toMatch(VENDOR_HOST);
      expect(content, path).not.toMatch(VENDOR_WORDS);
    }
    for (const [path, md] of markdown) expect(md, path).not.toMatch(DASHES);
  });
});

describe('requiredOnly', () => {
  it('keeps the required fields of the example, and the first of an anyOf of required sets', () => {
    const doc = parseOpenApi({
      openapi: '3.1.0',
      paths: {},
      components: { schemas: { Person: { type: 'object', required: ['name'], properties: { name: {}, age: {} } } } },
    })!;
    const schema = {
      type: 'object',
      required: ['who'],
      anyOf: [{ required: ['id'] }, { required: ['slug'] }],
      properties: { who: { $ref: '#/components/schemas/Person' }, id: {}, slug: {}, note: {} },
    };
    expect(requiredOnly(doc, schema, { id: 1, slug: 's', note: 'n', who: { name: 'Ana', age: 3 } })).toEqual({
      id: 1,
      who: { name: 'Ana' },
    });
  });
});

describe('skill sources', () => {
  /** The skill, the route that serves it and the guide that links it, as written in the repository. */
  const roots = [
    fileURLToPath(new URL('.', import.meta.url)),
    fileURLToPath(new URL('../../app/api/developers', import.meta.url)),
  ];
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : [full];
    });

  it('hardcode no vendor host: the addresses only arrive at request time', () => {
    for (const file of roots.flatMap(sources)) expect(readFileSync(file, 'utf8'), file).not.toMatch(VENDOR_HOST);
  });
});
