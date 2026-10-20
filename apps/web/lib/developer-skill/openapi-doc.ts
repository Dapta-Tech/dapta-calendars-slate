/**
 * Just enough of an OpenAPI 3 document to write the skill's endpoint reference
 * from it. The document is the API's own `/openapi.json`: hand-curated, focused
 * on the routes integrations use, and kept in parity with the controllers by
 * the API's tests. It is fetched when the zip is built, so the skill lists what
 * this installation's API documents and nothing else.
 *
 * Read defensively: the shape is trusted only as far as `parseOpenApi` checks
 * it, and every optional field below is treated as possibly absent, because a
 * fork may describe its API differently.
 */

export type Schema = Record<string, unknown>;

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
  example?: unknown;
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: unknown[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema; example?: unknown }> };
  responses?: Record<
    string,
    | { description?: string; headers?: Record<string, unknown>; content?: Record<string, { schema?: Schema; example?: unknown }> }
    | undefined
  >;
}

export interface OpenApiDocument {
  openapi: string;
  servers?: unknown;
  security?: Array<Record<string, unknown>>;
  components?: {
    securitySchemes?: Record<
      string,
      { type?: string; scheme?: string; bearerFormat?: string; description?: string } | undefined
    >;
    schemas?: Record<string, Schema | undefined>;
  };
  paths: Record<string, Record<string, unknown>>;
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface Operation {
  method: HttpMethod;
  path: string;
  op: OpenApiOperation;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The document, or null when the value is not an OpenAPI 3 document with paths. */
export function parseOpenApi(value: unknown): OpenApiDocument | null {
  if (!isRecord(value) || typeof value.openapi !== 'string' || !value.openapi.startsWith('3.')) return null;
  if (!isRecord(value.paths) || !Object.values(value.paths).every(isRecord)) return null;
  return value as unknown as OpenApiDocument;
}

/**
 * An operation with the parameters its path declares for every method merged
 * in, as OpenAPI defines them: the operation's own wins when both name the
 * same parameter in the same place.
 */
function withPathParameters(doc: OpenApiDocument, item: Record<string, unknown>, op: OpenApiOperation): OpenApiOperation {
  const shared = Array.isArray(item.parameters) ? item.parameters : [];
  if (shared.length === 0) return op;
  const own = op.parameters ?? [];
  const key = (p: unknown): string | null => {
    const resolved = isRecord(p) && typeof p.$ref === 'string' ? resolveRef(doc, p.$ref) : p;
    return isRecord(resolved) && typeof resolved.name === 'string' && typeof resolved.in === 'string'
      ? `${resolved.in}:${resolved.name}`
      : null;
  };
  const taken = new Set(own.map(key).filter(Boolean));
  return { ...op, parameters: [...shared.filter((p) => !taken.has(key(p))), ...own] };
}

/** Every operation, in the document's own order: paths as listed, methods as listed under each. */
export function listOperations(doc: OpenApiDocument): Operation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((key): key is HttpMethod => (HTTP_METHODS as readonly string[]).includes(key) && isRecord(item[key]))
      .map((method) => ({ method, path, op: withPathParameters(doc, item, item[method] as OpenApiOperation) })),
  );
}

/** `GET /v2/slots`: how the skill names an operation everywhere it mentions one. */
export const operationLabel = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

export function findOperation(doc: OpenApiDocument, method: HttpMethod, path: string): OpenApiOperation | null {
  const item = doc.paths[path];
  const op = item?.[method];
  return item && isRecord(op) ? withPathParameters(doc, item, op as OpenApiOperation) : null;
}

/** A local `#/...` reference, or null. Remote references are not followed. */
export function resolveRef(doc: OpenApiDocument, ref: unknown): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let at: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(at)) return null;
    at = at[key];
  }
  return at;
}

/** A schema with its own `$ref` followed (once per hop, with a cap so a cycle cannot hang the route). */
export function derefSchema(doc: OpenApiDocument, schema: unknown): Schema | null {
  let at = schema;
  for (let hop = 0; hop < 10 && isRecord(at) && typeof at.$ref === 'string'; hop++) at = resolveRef(doc, at.$ref);
  return isRecord(at) ? at : null;
}

/** The operation's parameters, with any `$ref` resolved and anything malformed dropped. */
export function operationParameters(doc: OpenApiDocument, op: OpenApiOperation): OpenApiParameter[] {
  return (op.parameters ?? [])
    .map((p) => (isRecord(p) && typeof p.$ref === 'string' ? resolveRef(doc, p.$ref) : p))
    .filter((p): p is OpenApiParameter => isRecord(p) && typeof p.name === 'string' && typeof p.in === 'string');
}

/** The value a header parameter must carry when its schema allows exactly one (`cal-api-version`). */
export function fixedHeaderValue(doc: OpenApiDocument, op: OpenApiOperation, name: string): string | null {
  const param = operationParameters(doc, op).find((p) => p.in === 'header' && p.name.toLowerCase() === name.toLowerCase());
  const values = param?.schema?.enum;
  return Array.isArray(values) && values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
}

export type AuthKind = 'key' | 'other' | 'none';

/**
 * Who may call an operation, from its `security` (or the document's): `key`
 * when a requirement names an HTTP bearer scheme, which is how this API
 * describes its keys; `other` for any other scheme (a dashboard session);
 * `none` when nothing is required.
 */
export function authKind(doc: OpenApiDocument, op: OpenApiOperation): AuthKind {
  const requirements = op.security ?? doc.security ?? [];
  const names = requirements.filter(isRecord).flatMap((r) => Object.keys(r));
  if (names.length === 0) return 'none';
  const schemes = doc.components?.securitySchemes ?? {};
  const bearer = names.some((n) => {
    const s = schemes[n];
    return s?.type === 'http' && s.scheme?.toLowerCase() === 'bearer';
  });
  return bearer ? 'key' : 'other';
}

/**
 * How the document says its API keys begin, when it says so: a bearer scheme's
 * `bearerFormat` that starts with it (`dcl_ API key`), or a description that
 * shows one (`Bearer dcl_<prefix>_<secret>`). Null when no scheme carries it.
 */
export function documentedKeyPrefix(doc: OpenApiDocument): string | null {
  for (const scheme of Object.values(doc.components?.securitySchemes ?? {})) {
    if (scheme?.type !== 'http' || scheme.scheme?.toLowerCase() !== 'bearer') continue;
    const fromFormat = /^([a-z][a-z0-9]*_)(?:\s|$)/i.exec(scheme.bearerFormat ?? '');
    const fromText = /Bearer ([a-z][a-z0-9]*_)</i.exec(scheme.description ?? '');
    const prefix = fromFormat?.[1] ?? fromText?.[1];
    if (prefix) return prefix;
  }
  return null;
}

/** True when some operation declares `name` as a response header. */
export function declaresResponseHeader(doc: OpenApiDocument, name: string): boolean {
  const wanted = name.toLowerCase();
  return listOperations(doc).some(({ op }) =>
    Object.values(op.responses ?? {}).some(
      (r) => isRecord(r?.headers) && Object.keys(r.headers).some((h) => h.toLowerCase() === wanted),
    ),
  );
}
