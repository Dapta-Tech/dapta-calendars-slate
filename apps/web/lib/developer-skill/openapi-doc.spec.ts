import { describe, expect, it } from 'vitest';
import {
  authKind,
  declaresResponseHeader,
  derefSchema,
  documentedKeyPrefix,
  findOperation,
  fixedHeaderValue,
  listOperations,
  operationParameters,
  parseOpenApi,
} from './openapi-doc';

const doc = parseOpenApi({
  openapi: '3.1.0',
  components: {
    securitySchemes: {
      key: { type: 'http', scheme: 'bearer' },
      session: { type: 'apiKey', in: 'header', name: 'authorization' },
    },
    schemas: { A: { $ref: '#/components/schemas/B' }, B: { type: 'object', title: 'B' }, Loop: { $ref: '#/components/schemas/Loop' } },
    parameters: { Version: { name: 'version', in: 'header', required: true, schema: { type: 'string', enum: ['2024-01-01'] } } },
  },
  paths: {
    '/things': {
      parameters: [],
      summary: 'not an operation',
      post: { security: [{ key: [] }], parameters: [{ $ref: '#/components/parameters/Version' }] },
      get: { security: [{ session: [] }] },
    },
    '/open': { get: {} },
  },
})!;

describe('parseOpenApi', () => {
  it('refuses anything that is not an OpenAPI 3 document with paths', () => {
    for (const bad of [null, [], 'x', { openapi: '2.0', paths: {} }, { openapi: '3.1.0' }, { openapi: '3.1.0', paths: { '/a': 1 } }]) {
      expect(parseOpenApi(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('listOperations', () => {
  it('lists methods only, in the order the document has them', () => {
    expect(listOperations(doc).map((o) => `${o.method} ${o.path}`)).toEqual(['post /things', 'get /things', 'get /open']);
  });
});

describe('authKind', () => {
  it('reads a bearer scheme as a key, another scheme as other, none as none', () => {
    const [post, get, open] = listOperations(doc);
    expect(authKind(doc, post!.op)).toBe('key');
    expect(authKind(doc, get!.op)).toBe('other');
    expect(authKind(doc, open!.op)).toBe('none');
  });
});

describe('references', () => {
  it('follows a referenced parameter to its single allowed header value', () => {
    expect(fixedHeaderValue(doc, listOperations(doc)[0]!.op, 'Version')).toBe('2024-01-01');
  });

  it('follows schema references, and gives up on a cycle instead of hanging', () => {
    expect(derefSchema(doc, { $ref: '#/components/schemas/A' })).toEqual({ type: 'object', title: 'B' });
    expect(derefSchema(doc, { $ref: '#/components/schemas/Loop' })).toEqual({ $ref: '#/components/schemas/Loop' });
    expect(derefSchema(doc, { $ref: 'https://elsewhere.example.com/x.json' })).toBeNull();
  });
});

describe('path-level parameters', () => {
  const shared = parseOpenApi({
    openapi: '3.1.0',
    paths: {
      '/bookings/{uid}': {
        parameters: [
          { name: 'uid', in: 'path', required: true, description: 'from the path' },
          { name: 'version', in: 'header', required: true },
        ],
        get: {},
        post: { parameters: [{ name: 'uid', in: 'path', required: true, description: 'from the operation' }, { name: 'uid', in: 'query' }] },
      },
    },
  })!;
  const params = (method: 'get' | 'post') =>
    operationParameters(shared, findOperation(shared, method, '/bookings/{uid}')!).map((p) => `${p.in}:${p.name}:${p.description ?? ''}`);

  it('applies to every operation under the path', () => {
    expect(params('get')).toEqual(['path:uid:from the path', 'header:version:']);
  });

  it('gives way to the operation when it names the same parameter in the same place', () => {
    expect(params('post')).toEqual(['header:version:', 'path:uid:from the operation', 'query:uid:']);
    // listOperations hands out the same merge.
    const post = listOperations(shared).find((o) => o.method === 'post')!;
    expect(operationParameters(shared, post.op)).toHaveLength(3);
  });
});

describe('documentedKeyPrefix', () => {
  const withScheme = (scheme: Record<string, unknown>) =>
    parseOpenApi({ openapi: '3.1.0', paths: {}, components: { securitySchemes: { k: { type: 'http', scheme: 'bearer', ...scheme } } } })!;

  it('reads the prefix from the bearer format, or from a description that shows a key', () => {
    expect(documentedKeyPrefix(withScheme({ bearerFormat: 'dcl_ API key' }))).toBe('dcl_');
    expect(documentedKeyPrefix(withScheme({ description: 'Authorization: Bearer abc_<prefix>_<secret>.' }))).toBe('abc_');
  });

  it('is null when no scheme says how a key begins', () => {
    expect(documentedKeyPrefix(withScheme({ bearerFormat: 'JWT' }))).toBeNull();
    expect(documentedKeyPrefix(doc)).toBeNull();
  });
});

describe('declaresResponseHeader', () => {
  it('finds a header an answer declares, whatever its case', () => {
    const declared = parseOpenApi({
      openapi: '3.1.0',
      paths: { '/a': { get: { responses: { 200: { description: 'ok', headers: { 'X-Request-Id': { schema: { type: 'string' } } } } } } } },
    })!;
    expect(declaresResponseHeader(declared, 'x-request-id')).toBe(true);
    expect(declaresResponseHeader(doc, 'X-Request-Id')).toBe(false);
  });
});
