import { API_KEY_ENV } from '../mcp-connect';
import {
  authKind,
  derefSchema,
  isRecord,
  listOperations,
  operationLabel,
  operationParameters,
  type AuthKind,
  type OpenApiDocument,
  type Operation,
  type Schema,
} from './openapi-doc';

/**
 * `reference/endpoints.md`: every operation of the OpenAPI document, and only
 * those. The document covers the routes the API offers integrations, not every
 * route it serves, and the reference says so. Nothing in this file names a route: headings, parameters, bodies and
 * answers are all read off the document, so the reference cannot list a route
 * the API does not serve, and a route added to the API (and to its document,
 * which the API's parity test demands) shows up here with no change.
 *
 * Descriptions are copied as the document words them, with one change: a
 * dash between two clauses becomes a colon, which carries the same pause. The
 * document itself ships in the zip as the API served it.
 */

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** The document's words, with a dash between clauses read as a colon. */
const prose = (text: string): string => text.replace(/\s*\u2014\s*|\s+\u2013\s+/g, ': ');

/** One line, safe inside a table cell. */
const cell = (text: string): string => prose(text).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();

const code = (value: unknown): string => `\`${value === null ? 'null' : String(value)}\``;

/** A short, readable type: `string (date-time)`, `array of Attendee`, `"en" or "es"`. */
export function describeType(doc: OpenApiDocument, schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth > 4) return 'any';
  if (typeof schema.$ref === 'string') return code(schema.$ref.split('/').pop());
  if ('const' in schema) return code(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(code).join(' or ');
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) {
      return options.map((o) => describeType(doc, o, depth + 1)).join(' or ');
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === 'string' ? [schema.type] : [];
  if (types.length === 0) return isRecord(schema.properties) ? 'object' : 'any';
  return types
    .map((t) => {
      if (t === 'array') return `array of ${describeType(doc, schema.items, depth + 1)}`;
      if (t === 'string' && typeof schema.format === 'string') return `string (${schema.format})`;
      return String(t);
    })
    .join(' or ');
}

const LIMITS: Array<[string, string]> = [
  ['minLength', 'min length'],
  ['maxLength', 'max length'],
  ['minimum', 'min'],
  ['maximum', 'max'],
  ['minItems', 'min items'],
  ['maxItems', 'max items'],
];

/** What a cell says about one value: its description, default and bounds. */
function notes(schema: Schema | null, description?: unknown): string {
  const parts: string[] = [];
  const text = typeof description === 'string' ? description : schema && typeof schema.description === 'string' ? schema.description : '';
  if (text) parts.push(text);
  if (schema && 'default' in schema) parts.push(`Default ${code(schema.default)}.`);
  const bounds = schema ? LIMITS.filter(([k]) => typeof schema[k] === 'number').map(([k, label]) => `${label} ${String(schema[k])}`) : [];
  if (bounds.length) parts.push(`${bounds.join(', ')}.`);
  return cell(parts.join(' '));
}

function parametersTable(doc: OpenApiDocument, { op }: Operation): string {
  const params = operationParameters(doc, op);
  if (params.length === 0) return '';
  const rows = params.map(
    (p) =>
      `| ${code(p.name)} | ${p.in} | ${p.required ? 'yes' : 'no'} | ${cell(describeType(doc, p.schema))} | ${notes(derefSchema(doc, p.schema), p.description)} |`,
  );
  return ['| Parameter | In | Required | Type | Notes |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** The JSON body: its fields, any "one of these sets" rule, and the document's own example. */
function bodySection(doc: OpenApiDocument, { op }: Operation): string {
  const content = op.requestBody?.content?.['application/json'];
  if (!content) return '';
  const raw = content.schema;
  const schema = derefSchema(doc, raw);
  const required = op.requestBody?.required ? 'required' : 'optional';
  const out: string[] = [`Body (JSON, ${required}):`];

  const properties = schema && isRecord(schema.properties) ? schema.properties : null;
  if (properties) {
    const mustHave = new Set(Array.isArray(schema!.required) ? schema!.required.map(String) : []);
    out.push(
      '',
      '| Field | Required | Type | Notes |',
      '|---|---|---|---|',
      ...Object.entries(properties).map(
        ([name, s]) =>
          `| ${code(name)} | ${mustHave.has(name) ? 'yes' : 'no'} | ${cell(describeType(doc, s))} | ${notes(derefSchema(doc, s))} |`,
      ),
    );
    const sets = (Array.isArray(schema!.anyOf) ? schema!.anyOf : [])
      .map((alt) => (isRecord(alt) && Array.isArray(alt.required) ? alt.required.map(code).join(' and ') : null))
      .filter((s): s is string => Boolean(s));
    if (sets.length) out.push('', `It also needs one of these: ${sets.join('; ')}.`);
  } else if (raw) {
    out.push('', `A ${describeType(doc, raw)}.`);
  }

  const example =
    (isRecord(raw) ? raw.example : undefined) ?? (schema ? schema.example : undefined) ?? content.example;
  if (example !== undefined) out.push('', 'Example:', '', '~~~json', json(example), '~~~');
  return out.join('\n');
}

function responsesList({ op }: Operation): string {
  const entries = Object.entries(op.responses ?? {});
  if (entries.length === 0) return '';
  return ['Answers:', '', ...entries.map(([status, r]) => `- ${code(status)}: ${cell(r?.description ?? '')}`)].join('\n');
}

function operationSection(doc: OpenApiDocument, operation: Operation): string {
  const { method, path, op } = operation;
  const blocks = [
    `### \`${operationLabel(method, path)}\``,
    op.summary ? prose(`${op.summary}.`.replace(/\.\.$/, '.')) : '',
    prose(op.description ?? ''),
    parametersTable(doc, operation),
    bodySection(doc, operation),
    responsesList(operation),
  ];
  return blocks.filter(Boolean).join('\n\n');
}

const GROUPS: Array<{ kind: AuthKind; title: string; lead: string }> = [
  {
    kind: 'key',
    title: 'With an API key',
    lead: `Send \`Authorization: Bearer $${API_KEY_ENV}\` on every one of these.`,
  },
  {
    kind: 'other',
    title: 'Other sign-in',
    lead: 'These need a sign-in other than an API key (see `security` in `openapi.json`). An agent with a key cannot call them.',
  },
  {
    kind: 'none',
    title: 'No key',
    lead: 'These take no key. An agent with a key rarely needs them: prefer the routes above.',
  },
];

export function endpointsMd(doc: OpenApiDocument, { apiUrl }: { apiUrl: string }): string {
  const operations = listOperations(doc);
  const sections = GROUPS.flatMap(({ kind, title, lead }) => {
    const ops = operations.filter((o) => authKind(doc, o.op) === kind);
    if (ops.length === 0) return [];
    return [`## ${title}\n\n${lead}`, ...ops.map((o) => operationSection(doc, o))];
  });
  return `# Endpoints

The routes this installation's API documents for integrations: ${operations.length} operations, written from its OpenAPI document (\`openapi.json\` in this folder) when the skill was downloaded. The API has other routes too (the dashboard's own, and the MCP server that \`mcp-tools.md\` covers); over REST, call nothing that is not listed here.

Base URL: \`${apiUrl}\`. Paths are relative to it. Bodies are JSON (\`Content-Type: application/json\`). A type in backticks, such as \`Attendee\`, is a schema under \`components.schemas\` in \`openapi.json\`.

${sections.join('\n\n')}
`;
}
