import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/**
 * A stand-in external OAuth authorization server for specs: RS256 and ES256
 * keys generated here, its RFC 8414 metadata and its JWKS served by a local
 * HTTP server, tokens minted on demand. Each document can be switched to a
 * failure (status 500, a stall, a wrong issuer, an oversized body, a redirect)
 * to prove the resource server never answers worse than a 401 or a 503.
 */

type CryptoKeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export type DocumentMode = 'ok' | 'error' | 'stall' | 'huge' | 'redirect' | 'wrong-issuer';

export interface FakeAs {
  issuer: string;
  jwksUrl: string;
  /** How each document answers next; flip them between assertions. */
  modes: { metadata: DocumentMode; jwks: DocumentMode };
  /** Requests served per path, for cache assertions. */
  hits: Record<string, number>;
  /** An access token; `claims` overrides the defaults, `null` removes a claim. */
  mint(claims?: Record<string, unknown>, opts?: { alg?: 'RS256' | 'ES256'; kid?: string; key?: CryptoKeyLike }): Promise<string>;
  /** The RS256 public key, as a JWK (for "HS256 signed with the public key" attacks). */
  publicJwk: JWK;
  close(): Promise<void>;
}

export async function startFakeAs(opts: { audience: string }): Promise<FakeAs> {
  const rsa = await generateKeyPair('RS256', { extractable: true });
  const ec = await generateKeyPair('ES256', { extractable: true });
  const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
  const ecJwk = { ...(await exportJWK(ec.publicKey)), kid: 'ec-1', alg: 'ES256', use: 'sig' };
  const modes: FakeAs['modes'] = { metadata: 'ok', jwks: 'ok' };
  const hits: Record<string, number> = {};
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    const mode = path === '/.well-known/oauth-authorization-server' ? modes.metadata : path === '/oauth2/jwks' ? modes.jwks : null;
    if (mode === null) return void res.writeHead(404).end();
    if (mode === 'stall') return; // never answers; the client's timeout must fire
    if (mode === 'error') return void res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    if (mode === 'redirect') return void res.writeHead(302, { location: `${issuer}/elsewhere` }).end();
    if (mode === 'huge') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer, pad: 'x'.repeat(100_000) }));
    const body =
      path === '/oauth2/jwks'
        ? { keys: [rsaJwk, ecJwk] }
        : {
            issuer: mode === 'wrong-issuer' ? 'https://someone-else.example.test' : issuer,
            authorization_endpoint: `${issuer}/oauth2/authorize`,
            token_endpoint: `${issuer}/oauth2/token`,
            registration_endpoint: `${issuer}/oauth2/register`,
            jwks_uri: `${issuer}/oauth2/jwks`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
            client_id_metadata_document_supported: true,
          };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    jwksUrl: `${issuer}/oauth2/jwks`,
    modes,
    hits,
    publicJwk: rsaJwk,
    async mint(claims = {}, o = {}) {
      const alg = o.alg ?? 'RS256';
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = { iss: issuer, aud: opts.audience, sub: 'user_01TESTSUBJECT', exp: now + 300, iat: now, ...claims };
      for (const [k, v] of Object.entries(payload)) if (v === null) delete payload[k];
      return new SignJWT(payload as never)
        .setProtectedHeader({ alg, kid: o.kid ?? (alg === 'RS256' ? 'rsa-1' : 'ec-1'), typ: 'JWT' })
        .sign(o.key ?? (alg === 'RS256' ? rsa.privateKey : ec.privateKey));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
