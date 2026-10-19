import { describe, expect, it } from 'vitest';
import { authKind, derefSchema, fixedHeaderValue, listOperations, parseOpenApi } from './openapi-doc';

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
