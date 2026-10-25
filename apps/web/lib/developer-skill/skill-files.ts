import { getMessages } from '@slate/shared';
import { DEVELOPERS_CONNECT_HREF, DEVELOPERS_DOCS_HREF, DEVELOPERS_KEYS_HREF, DEVELOPERS_TOOLS_HREF } from '../admin-nav';
import {
  API_KEY_ENV,
  KEY_PREFIX,
  MCP_TOOLS,
  SCOPE_CATALOG,
  SERVER_NAME,
  exportKeyCommand,
  type ToolInfo,
  type ToolKind,
} from '../mcp-connect';
import { endpointsMd } from './endpoints-md';
import { code, tableCell } from './markdown';
import {
  declaresResponseHeader,
  derefSchema,
  documentedKeyPrefix,
  findOperation,
  fixedHeaderValue,
  isRecord,
  listOperations,
  operationLabel,
  operationParameters,
  type HttpMethod,
  type OpenApiDocument,
  type Schema,
} from './openapi-doc';
import { SKILL_DIR, SKILL_ZIP_NAME } from './skill-names';

/**
 * The skill zip an owner or admin downloads from the API keys page: what an
 * agent with a terminal and no MCP needs to use this installation's API with
 * the same key. English only: it is read by a model, not shown in the UI.
 *
 * Three inputs make it, and none of them is written here:
 *  - the API's own OpenAPI document, fetched when the zip is built. The
 *    endpoint reference is generated from it, and every route the prose names,
 *    and every error code or header a rule quotes, is looked up in it first,
 *    so the skill never sends an agent to a route the API does not document
 *    or promises an answer the document does not give;
 *  - the MCP tools and scopes the dashboard already shows (`mcp-connect.ts`),
 *    with their English copy from the shared catalog;
 *  - the addresses, from the environment the zip is downloaded from. The
 *    repository is public and a fork runs at its own address, so no host is
 *    ever hardcoded.
 *
 * The zip never carries a key: every snippet names `API_KEY_ENV`.
 */
export interface SkillInputs {
  /** The API's public origin, no trailing slash. */
  apiUrl: string;
  /** The MCP endpoint. Always known once the API origin is: it hangs off it unless set on its own. */
  mcpUrl: string;
  /** The dashboard's public origin, no trailing slash. */
  appUrl: string;
  /** What this build calls the product. */
  productName: string;
  /** The API's OpenAPI document, as fetched. */
  openapi: OpenApiDocument;
}

export interface SkillFile {
  path: string;
  content: string;
}

export { SKILL_DIR, SKILL_ZIP_NAME };

const en = getMessages('en').admin.developer;
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const bearer = `Authorization: Bearer $${API_KEY_ENV}`;
const KIND_LABEL = { read: en.kindRead, write: en.kindWrite, destructive: en.kindDestructive } as const;

/**
 * The operations the prose may name. Each one is looked up in the document
 * before a sentence about it is written, so an installation whose API lacks it
 * gets a skill without that sentence, never one pointing at a missing route.
 */
const has = (doc: OpenApiDocument, method: HttpMethod, path: string): boolean => findOperation(doc, method, path) !== null;
const ref = (method: HttpMethod, path: string): string => code(operationLabel(method, path));

/** A `/v2` route's fixed `cal-api-version`, from the document. */
const version = (doc: OpenApiDocument, method: HttpMethod, path: string): string | null => {
  const op = findOperation(doc, method, path);
  return op ? fixedHeaderValue(doc, op, 'cal-api-version') : null;
};

const paramNames = (doc: OpenApiDocument, method: HttpMethod, path: string): Set<string> => {
  const op = findOperation(doc, method, path);
  return new Set(op ? operationParameters(doc, op).map((p) => p.name) : []);
};

/** The document's example for a parameter, or a shell variable named after it. */
function paramValue(doc: OpenApiDocument, method: HttpMethod, path: string, name: string): string {
  const op = findOperation(doc, method, path);
  const param = op ? operationParameters(doc, op).find((p) => p.name === name) : undefined;
  if (typeof param?.example === 'string') return param.example;
  return `$${name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/**
 * The document's own example body cut down to the fields its schema requires
 * (for an `anyOf` of required sets, the first set), at every level. An agent
 * copies what it is shown, so it is shown the least that works, in the
 * document's own words.
 */
export function requiredOnly(doc: OpenApiDocument, schemaIn: unknown, example: unknown): unknown {
  const schema = derefSchema(doc, schemaIn);
  if (!schema || !isRecord(example) || !isRecord(schema.properties)) return example;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const first = Array.isArray(schema.anyOf) ? schema.anyOf.find(isRecord) : undefined;
  if (first && Array.isArray(first.required)) for (const k of first.required) required.add(String(k));
  const properties = schema.properties as Record<string, Schema>;
  return Object.fromEntries(
    Object.entries(example)
      .filter(([k]) => required.has(k))
      .map(([k, v]) => [k, requiredOnly(doc, properties[k], v)]),
  );
}

/** `-H` lines for a call: the key, then the route's fixed version, then whatever else it needs. */
function headerLines(doc: OpenApiDocument, method: HttpMethod, path: string, extra: string[] = []): string[] {
  const v = version(doc, method, path);
  return [bearer, ...(v ? [`cal-api-version: ${v}`] : []), ...extra].map((h) => `  -H "${h}"`);
}

const curl = (first: string, lines: string[]): string => [first, ...lines].join(' \\\n');

/** "Book a meeting", step by step. Only when the document has all three routes and the parameters used. */
function bookingWalkthrough(doc: OpenApiDocument, apiUrl: string): string {
  const slotsParams = paramNames(doc, 'get', '/v2/slots');
  const booking = findOperation(doc, 'post', '/v2/bookings');
  const bodySchema = booking?.requestBody?.content?.['application/json']?.schema;
  const example = isRecord(bodySchema) ? (bodySchema.example ?? derefSchema(doc, bodySchema)?.example) : undefined;
  const ready =
    has(doc, 'get', '/v2/event-types') &&
    ['eventTypeId', 'start', 'end', 'timeZone'].every((p) => slotsParams.has(p)) &&
    booking !== null &&
    isRecord(example) &&
    paramNames(doc, 'post', '/v2/bookings').has('Idempotency-Key');
  if (!ready) return '';

  // An event type can ask the invitee questions; a booking that leaves a
  // required one unanswered is refused, so the walkthrough says how to answer.
  const bookingSchema = derefSchema(doc, bodySchema);
  const answers =
    bookingSchema && isRecord(bookingSchema.properties) && 'bookingFieldsResponses' in bookingSchema.properties
      ? '\n\nIf the event type lists `bookingFields`, answer every one marked `required` in `bookingFieldsResponses`, keyed by the field\'s `name` (for example `{ "company": "Acme" }`).'
      : '';
  // The API turns every refusal of what was booked into this one code (a
  // missing answer, a start out of range, a time the event does not offer), so
  // the agent is told to read the message rather than assume which it was.
  const refusal = documentedErrorCodes(doc).includes('BOOKING_FIELDS_INVALID')
    ? '\n\nA 422 `BOOKING_FIELDS_INVALID` is how this route refuses anything about what was booked, not only a missing answer, so read its `message`. It names a missing answer by the field\'s `label` (`Missing required field: Company`): find that label in `bookingFields` to get the `name` to answer. Or it says the start time is not offered, in the past or too far ahead: pick another time from step 2.'
    : '';
  const query = ['eventTypeId', 'start', 'end', 'timeZone'].map(
    (name) => `  --data-urlencode "${name}=${paramValue(doc, 'get', '/v2/slots', name)}"`,
  );
  const body = requiredOnly(doc, bodySchema, example);
  return `## Book a meeting

1. Find the event type with ${ref('get', '/v2/event-types')} and take its \`id\` (and its \`bookingFields\`, the questions the invitee answers):

~~~bash
${curl(`curl -sS "${apiUrl}/v2/event-types"`, headerLines(doc, 'get', '/v2/event-types'))}
~~~

2. Read its free times in the window the user wants with ${ref('get', '/v2/slots')} (the dates below are only an example). The answer groups them by date; each one has a \`start\`.

~~~bash
${curl(`curl -sS -G "${apiUrl}/v2/slots"`, [...headerLines(doc, 'get', '/v2/slots'), ...query])}
~~~

3. Book one of those \`start\` times with ${ref('post', '/v2/bookings')}, with a new \`Idempotency-Key\` for this booking:

~~~bash
${curl(`curl -sS -X POST "${apiUrl}/v2/bookings"`, [
  ...headerLines(doc, 'post', '/v2/bookings', ['Idempotency-Key: $IDEMPOTENCY_KEY', 'Content-Type: application/json']),
  // Single-quoted for the shell, so a quote inside the example is closed, escaped and reopened.
  `  --data '${JSON.stringify(body).replace(/'/g, "'\\''")}'`,
])}
~~~

Keep the booking's \`uid\` from the answer: every later call about this booking uses it. The other fields the body takes are under the route in \`reference/endpoints.md\`.${answers}${refusal}`;
}

/** What to do with a booking once it exists, one line per route the document has. */
function afterBooking(doc: OpenApiDocument): string {
  const lines = [
    has(doc, 'get', '/v2/bookings/{uid}') && `- Read it: ${ref('get', '/v2/bookings/{uid}')}.`,
    has(doc, 'post', '/v2/bookings/{uid}/reschedule') &&
      `- Move it: ${ref('post', '/v2/bookings/{uid}/reschedule')}. The moved booking has a new \`uid\`; use that one from then on.`,
    has(doc, 'post', '/v2/bookings/{uid}/guests') && `- Add guests: ${ref('post', '/v2/bookings/{uid}/guests')}.`,
    has(doc, 'post', '/v2/bookings/{uid}/cancel') &&
      `- Cancel it, after the user confirms: ${ref('post', '/v2/bookings/{uid}/cancel')}.`,
    has(doc, 'get', '/v1/machine/bookings') &&
      `- List bookings: ${ref('get', '/v1/machine/bookings')}. It answers \`{ items, nextCursor }\`: send \`nextCursor\` back as \`cursor\` for the next page, until it is null.`,
    has(doc, 'get', '/v2/calendars') && `- See the connected calendars: ${ref('get', '/v2/calendars')}.`,
    has(doc, 'post', '/v2/calendars/availability') &&
      `- Free time across several of those calendars at once: ${ref('post', '/v2/calendars/availability')}.`,
  ].filter((l): l is string => typeof l === 'string');
  return lines.length ? `## Bookings, calendars and lists\n\n${lines.join('\n')}` : '';
}

/** Each `/v2` route's fixed version header, as a table. */
function versionTable(doc: OpenApiDocument): string {
  const rows = listOperations(doc)
    .map(({ method, path, op }) => ({ method, path, value: fixedHeaderValue(doc, op, 'cal-api-version') }))
    .filter((r) => r.value !== null)
    .map((r) => `   | ${tableCell(ref(r.method, r.path))} | ${tableCell(code(r.value))} |`);
  return rows.length ? ['   | Route | `cal-api-version` |', '   |---|---|', ...rows].join('\n') : '';
}

/** The routes that take an `Idempotency-Key`, from the document. */
function idempotentRoutes(doc: OpenApiDocument): string[] {
  return listOperations(doc)
    .filter(({ op }) => operationParameters(doc, op).some((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key'))
    .map(({ method, path }) => ref(method, path));
}

/** The fields of the error envelope's `error` object, when the document defines one. */
function envelopeErrorFields(doc: OpenApiDocument): Record<string, unknown> | null {
  const envelope = derefSchema(doc, doc.components?.schemas?.ErrorEnvelope);
  const error = envelope && isRecord(envelope.properties) ? derefSchema(doc, envelope.properties.error) : null;
  return error && isRecord(error.properties) ? error.properties : null;
}

/** The error codes the document lists for its envelope. A rule quotes a code only when it is here. */
function documentedErrorCodes(doc: OpenApiDocument): string[] {
  const codeSchema = envelopeErrorFields(doc)?.code;
  const examples = isRecord(codeSchema) && Array.isArray(codeSchema.examples) ? codeSchema.examples : [];
  return examples.filter((c): c is string => typeof c === 'string');
}

/** The document's own example of an error envelope, from the first answer that shows one. */
function envelopeExample(doc: OpenApiDocument): unknown {
  for (const { op } of listOperations(doc)) {
    for (const r of Object.values(op.responses ?? {})) {
      const content = r?.content?.['application/json'];
      const isEnvelope = typeof content?.schema?.$ref === 'string' && content.schema.$ref.endsWith('/ErrorEnvelope');
      if (isEnvelope && content?.example !== undefined) return content.example;
    }
  }
  return undefined;
}

/** The one scope of a kind in the catalog, or null when there is not exactly one. */
function onlyScope(kind: ToolKind): string | null {
  const matches = SCOPE_CATALOG.filter((s) => s.kind === kind);
  return matches.length === 1 ? matches[0]!.scope : null;
}

/** The catalog scope an operation's answers name (`API key lacks event-types:read.`), if any. */
function scopeNamedBy(doc: OpenApiDocument, method: HttpMethod, path: string): string | null {
  const texts = Object.values(findOperation(doc, method, path)?.responses ?? {}).map((r) => r?.description ?? '');
  return SCOPE_CATALOG.map((s) => s.scope).find((scope) => texts.some((t) => t.includes(scope))) ?? null;
}

/**
 * What the scope table cannot say in one cell: which REST routes take which
 * scope where that differs from the label. Both facts are the controllers'
 * (the REST cancel routes take either scope so keys made before
 * `bookings:cancel` existed keep working; guests and attendees ride on the
 * write scope); each line is written only for the routes the document has.
 */
function scopeNotes(doc: OpenApiDocument): string[] {
  const write = onlyScope('write');
  const cancel = onlyScope('destructive');
  const listed = (routes: Array<[HttpMethod, string]>) =>
    routes.filter(([m, p]) => has(doc, m, p)).map(([m, p]) => ref(m, p));
  const guests = listed([
    ['post', '/v2/bookings/{uid}/guests'],
    ['post', '/v1/machine/bookings/{uid}/attendees'],
  ]);
  const cancels = listed([
    ['post', '/v2/bookings/{uid}/cancel'],
    ['post', '/v1/machine/bookings/{uid}/cancel'],
  ]);
  const mcpCancel = MCP_TOOLS.filter((t) => cancel && t.scope === cancel).map((t) => `\`${t.name}\``);
  const notes: string[] = [];
  if (write && guests.length) notes.push(`\`${write}\` also adds guests: ${guests.join(', ')}.`);
  if (write && cancel && cancels.length) {
    notes.push(
      `The REST cancel routes (${cancels.join(', ')}) take \`${cancel}\` or \`${write}\`.${
        mcpCancel.length ? ` The MCP tool ${mcpCancel.join(', ')} takes only \`${cancel}\`.` : ''
      }`,
    );
  }
  return notes;
}

function skillMd({ apiUrl, mcpUrl, appUrl, productName, openapi: doc }: SkillInputs): string {
  const hasV2 = Object.keys(doc.paths).some((p) => p.startsWith('/v2/'));
  const versions = versionTable(doc);
  const idempotent = idempotentRoutes(doc);
  const codes = documentedErrorCodes(doc);
  const errorFields = envelopeErrorFields(doc);
  const description =
    `Check free times, book, reschedule and cancel meetings, and read event types, bookings and connected calendars in ${productName} through its REST API with an API key. ` +
    `Use it whenever the user asks to find a time, book, move or cancel a meeting, or look up bookings, event types or calendars in ${productName}.`;

  const rules: string[] = [];
  if (versions) {
    rules.push(
      `**Send the version header on \`/v2\`.** Each \`/v2\` route below takes a fixed \`cal-api-version\`; a missing or different value ${
        codes.includes('UNSUPPORTED_API_VERSION') ? 'answers 400 `UNSUPPORTED_API_VERSION`' : 'is refused'
      }.\n\n${versions}`,
    );
  }
  if (idempotent.length) {
    rules.push(
      `**Make writes safe to retry.** ${idempotent.join(', ')} take an \`Idempotency-Key\` header. Send one with a value unique to that one action, and send the same value when you retry it: the API answers with the first result instead of acting twice.${
        hasV2 && codes.includes('IDEMPOTENCY_KEY_REUSED')
          ? ' On `/v2`, the same key with a different request answers 409 `IDEMPOTENCY_KEY_REUSED`.'
          : ''
      }`,
    );
  }
  rules.push(
    '**Ask before you cancel.** A cancelled booking cannot be brought back. Confirm which booking with the user first.',
    '**Wait when told to.** On a 429, or any answer with a `Retry-After` header, wait that many seconds, then try again.',
    '**A 401 means the key is not accepted:** it is wrong, revoked or expired. Ask the user for a new one; retrying does not help.',
    '**A 403 or 404 on something that should be there** can mean the key is limited to other event types: the API answers as if it did not exist, on purpose. A 403 that names a scope means the key lacks it. Tell the user what is missing; never guess other ids.',
    '**Times** are ISO-8601 instants such as `2026-07-24T15:00:00Z`. Send the user\'s IANA time zone (such as `America/Bogota`) wherever a route takes `timeZone`, and show times to the user in that zone.',
    '**Only call routes listed in `reference/endpoints.md`.** If what the user asks has no route, say so.',
  );

  const scopes = SCOPE_CATALOG.map(
    ({ scope, kind }) => `| \`${scope}\` | ${en.scopeLabels[scope] ?? scope} | ${KIND_LABEL[kind]} |`,
  );
  const notes = scopeNotes(doc);

  // The `/v2` envelope only as the document defines it: its example, the
  // request id when the envelope has one, the header when an answer declares it.
  const example = envelopeExample(doc);
  const requestId =
    errorFields && 'requestId' in errorFields
      ? ` When you report a failure, quote \`error.requestId\`${
          declaresResponseHeader(doc, 'X-Request-Id') ? ' (also in the `X-Request-Id` header)' : ''
        }.`
      : '';
  const errors = [
    '## Errors',
    hasV2 && errorFields && 'code' in errorFields
      ? `\`/v2\` routes answer an error with an \`error\` object${example === undefined ? '.' : ':'}${
          example === undefined ? '' : `\n\n~~~json\n${json(example)}\n~~~`
        }

Act on \`error.code\`, not on the message.${requestId}${
          codes.length ? ` The codes: ${codes.map((c) => code(c)).join(', ')}.` : ''
        }

Other routes answer \`{ "error": "CODE", "message": "..." }\`.`
      : 'Errors answer `{ "error": "CODE", "message": "..." }`.',
  ].join('\n\n');

  return `---
name: ${SKILL_DIR}
description: ${JSON.stringify(description)}
---

# ${productName} API

- API base URL: \`${apiUrl}\`
- MCP server: \`${mcpUrl}\`
- API keys: ${appUrl}${DEVELOPERS_KEYS_HREF}
- What each MCP tool does, for a person to read: ${appUrl}${DEVELOPERS_TOOLS_HREF}
- The API reference, for a person to read: ${appUrl}${DEVELOPERS_DOCS_HREF}

Every path below is relative to the API base URL. \`reference/endpoints.md\` lists the routes this installation's API documents for integrations.

## Authentication

Send the key on every request that needs one:

~~~
${bearer}
~~~

- Read the key from the \`${API_KEY_ENV}\` environment variable. If it is not set, ask the user to create a key on the API keys page and set it. Never print the key, never write it to a file, never commit it, never put it in a URL.
- Keys start with \`${documentedKeyPrefix(doc) ?? KEY_PREFIX}\`. A key belongs to one workspace and can only do what its scopes allow. It may also be limited to some event types.

## MCP or REST

If your agent has the \`${SERVER_NAME}\` MCP server connected, use its tools instead: \`reference/mcp-tools.md\` lists them with the access each needs. They take the same key and the same scopes. This skill is for an agent with a terminal and no MCP: it calls the REST API with \`curl\` or any HTTP client.

## Scopes

| Scope | What it allows | Kind |
|---|---|---|
${scopes.join('\n')}
${notes.length ? `\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
## Rules

${rules.map((r, i) => `${i + 1}. ${r}`).join('\n\n')}

${[bookingWalkthrough(doc, apiUrl), afterBooking(doc), errors].filter(Boolean).join('\n\n')}

## Files in this skill

- \`INSTALL.md\`: how to install it in Claude Code, Codex and Cursor, and check the key.
- \`reference/endpoints.md\`: the routes the API documents for integrations, with their parameters, bodies and answers, written from its own OpenAPI document.
- \`reference/mcp-tools.md\`: the MCP tools and the access each needs.
- \`reference/openapi.json\`: that OpenAPI document (${doc.openapi}), with \`servers\` set to this installation's API.
`;
}

/** What a tool needs, in the words the API docs page uses. */
function toolAccess(tool: ToolInfo): string {
  if (!tool.scope) return tool.publicOk ? en.toolNeedsNoKey : en.toolNeedsAnyKey;
  return `\`${tool.scope}\`${tool.publicOk ? ` ${en.toolOrPublic}` : ''}`;
}

function mcpToolsMd({ mcpUrl, appUrl, productName }: SkillInputs): string {
  const where = `The ${productName} MCP server is at \`${mcpUrl}\`, registered in agents as \`${SERVER_NAME}\`. It takes the same key as the REST API, in the same header: \`${bearer}\`. To connect an app that signs in with your account instead of a key, follow ${appUrl}${DEVELOPERS_CONNECT_HREF}.`;
  const rows = MCP_TOOLS.map(
    (tool) => `| \`${tool.name}\` | ${KIND_LABEL[tool.kind]} | ${toolAccess(tool)} | ${en.toolDescriptions[tool.name] ?? ''} |`,
  );
  return `# MCP tools

${where}

Read tools only look. Write tools change the calendar. Destructive ones cannot be undone: ask the user first.

| Tool | Kind | Access it needs | What it does |
|---|---|---|---|
${rows.join('\n')}

Scopes are explained in \`SKILL.md\`.
`;
}

/** Unzip the skill where `agent` reads it, plus the pointer file it needs. */
export function installCommand(agent: 'claude-code' | 'codex' | 'cursor', productName: string): string {
  switch (agent) {
    case 'claude-code':
      return `unzip -o ${SKILL_ZIP_NAME} -d ~/.claude/skills/`;
    case 'codex':
      // The pointer is appended once: a second install (an update) finds it and leaves AGENTS.md alone.
      return `unzip -o ${SKILL_ZIP_NAME} -d .
grep -qs '${SKILL_DIR}/SKILL.md' AGENTS.md || cat >> AGENTS.md <<'EOF'

## ${productName}
For any task about ${productName} availability, bookings or event types, read ${SKILL_DIR}/SKILL.md first and follow its rules. The references it names are in ${SKILL_DIR}/reference/.
EOF`;
    case 'cursor':
      return `unzip -o ${SKILL_ZIP_NAME} -d .
mkdir -p .cursor/rules
cat > .cursor/rules/${SKILL_DIR}.mdc <<'EOF'
---
description: Use the ${productName} API to check availability and to book, reschedule and cancel meetings.
alwaysApply: false
---
Read ${SKILL_DIR}/SKILL.md and follow its rules. The references are in ${SKILL_DIR}/reference/.
EOF`;
  }
}

function installMd({ apiUrl, appUrl, productName, openapi: doc }: SkillInputs): string {
  const checkScope = scopeNamedBy(doc, 'get', '/v2/event-types');
  const check = has(doc, 'get', '/v2/event-types')
    ? `
3. Check it:

~~~bash
${curl(`curl -sS "${apiUrl}/v2/event-types"`, headerLines(doc, 'get', '/v2/event-types'))}
~~~

A 401 means the key is not accepted. A 403 means it works but lacks ${
        checkScope ? `\`${checkScope}\`` : 'the access this route needs'
      }, which is fine if the agent does not need it.
`
    : '';
  return `# Installing the ${productName} API skill

1. Create an API key on ${appUrl}${DEVELOPERS_KEYS_HREF}, with only the access the agent needs. It is shown once: copy it then.
   What each MCP tool does is on ${appUrl}${DEVELOPERS_TOOLS_HREF}, and the API reference on ${appUrl}${DEVELOPERS_DOCS_HREF}.
2. Put it in the environment the agent runs in, never in a file you commit:

~~~bash
${exportKeyCommand()}
~~~
${check}
## Claude Code

Unzip so that \`SKILL.md\` ends up in a folder named \`${SKILL_DIR}\` inside a skills folder:

- For all your projects: \`~/.claude/skills/${SKILL_DIR}/SKILL.md\`
- For one project: \`.claude/skills/${SKILL_DIR}/SKILL.md\` in that project

~~~bash
${installCommand('claude-code', productName)}
~~~

Claude Code picks the skill up on its own when a request is about ${productName}. You can also ask for it by name: "use the ${SKILL_DIR} skill".

## Codex

Codex reads \`AGENTS.md\`. Unzip the folder into your project and point \`AGENTS.md\` at it:

~~~bash
${installCommand('codex', productName)}
~~~

## Cursor

Unzip the folder into your project and add a project rule that sends Cursor to it:

~~~bash
${installCommand('cursor', productName)}
~~~

Running the same commands again updates the skill in place.

## Other agents

Any agent that can read files and make HTTP requests can use it: give it \`${SKILL_DIR}/SKILL.md\` as instructions and keep the folder next to it.
`;
}

/**
 * The OpenAPI document as shipped: the API's own, with `servers` pointed at
 * this installation. The API names its address only as it sees it (its own
 * API_PUBLIC_URL, or a relative `/` when that is unset), and a relative server
 * means nothing inside a zip, so an agent that reads `servers` gets the address
 * this installation shows for its API. Everything else is as the API served it.
 */
export function shippedOpenApi(doc: OpenApiDocument, apiUrl: string): OpenApiDocument {
  return { ...doc, servers: [{ url: apiUrl, description: 'This installation' }] };
}

/**
 * Every file of the skill, inside `SKILL_DIR/`. Pure: the same inputs always
 * give the same files, which is what lets the spec check them without a server.
 */
export function buildSkillFiles(inputs: SkillInputs): SkillFile[] {
  const files: Array<[string, string]> = [
    ['SKILL.md', skillMd(inputs)],
    ['INSTALL.md', installMd(inputs)],
    ['reference/endpoints.md', endpointsMd(inputs.openapi, inputs)],
    ['reference/mcp-tools.md', mcpToolsMd(inputs)],
    ['reference/openapi.json', `${json(shippedOpenApi(inputs.openapi, inputs.apiUrl))}\n`],
  ];
  return files.map(([path, content]) => ({ path: `${SKILL_DIR}/${path}`, content }));
}

