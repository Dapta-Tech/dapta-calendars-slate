import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerEnv } from '@slate/config/env';
import { AuthService, type MachinePrincipal } from '../auth.service';
import { annotateRequestAccount, requestIdFrom } from '../request-log';
import { RateLimitGuard } from '../rate-limit';
import { ENV, RATE_LIMITER } from '../tokens';
import type { RateLimiter } from '../rate-limit';
import { OAuthService } from '../oauth/oauth.service';
import { ExternalOAuthService, type ExternalLogin, type LoginAccount } from '../oauth/external.service';
import { BASELINE_SCOPES, trimSlash } from '../oauth/oauth.settings';
import type { ApiScope } from '@slate/types';
import { CALL_KEY, McpGateway } from './mcp.gateway';
import { loginPrincipal, signInKey, type McpCall } from './support';
import { clientInfoOf } from './mcp-usage';
import { TOOLS, accessOf } from './tools';

const TOOL_BY_NAME = new Map(TOOLS.map((def) => [def.name, def]));

/** Scopes as a challenge lists them: deduplicated, stable order. */
const scopeList = (...groups: readonly (readonly string[])[]): string[] => [...new Set(groups.flat())];

/**
 * What the `tools/call` messages in a body need before they may run: whether
 * any needs a credential at all, and every scope they need. Read from the raw
 * JSON-RPC (a single message or a batch); anything malformed or unknown is
 * left to the SDK, which answers it with a protocol error.
 */
export function toolCallNeeds(body: unknown): { credential: boolean; scopes: ApiScope[] } {
  const messages = Array.isArray(body) ? body : [body];
  let credential = false;
  const scopes = new Set<ApiScope>();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (method !== 'tools/call' || typeof params?.name !== 'string') continue;
    const def = TOOL_BY_NAME.get(params.name);
    if (!def) continue;
    const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
    const access = accessOf(def, args);
    if (access === 'public') continue;
    credential = true;
    if (access.scope) scopes.add(access.scope);
  }
  return { credential, scopes: [...scopes] };
}

/** Credentials in the URL end up in access logs and proxies; refuse them outright. */
const URL_CREDENTIAL_PARAMS = ['key', 'api_key', 'apikey', 'access_token', 'token', 'authorization'];

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => trimSlash(s.trim().toLowerCase()))
    .filter(Boolean);
}

/** The hostname of a `Host` header, port and brackets handled. */
export function hostnameOf(host: string | undefined): string {
  const h = (host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

function rpcError(res: Response, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function protocolVersionOf(req: Request): string {
  const header = req.headers['mcp-protocol-version'];
  if (typeof header === 'string' && header) return header.slice(0, 20);
  const body = req.body as { params?: { protocolVersion?: unknown; _meta?: Record<string, unknown> } } | undefined;
  const meta = body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const init = body?.params?.protocolVersion;
  const v = typeof meta === 'string' ? meta : typeof init === 'string' ? init : 'unknown';
  return v.slice(0, 20);
}

/**
 * `POST /mcp`: the remote MCP endpoint (Streamable HTTP, stateless).
 *
 * The SDK handler trusts its caller: it checks no Host, no Origin and no token.
 * Everything that guards the door lives here, in order: switch, method,
 * transport hygiene (Host, Origin, URL credentials, content type), rate limit,
 * authentication. A request with NO credential is let through to the public
 * tools only; one with a bad credential is refused with 401 rather than quietly
 * downgraded.
 *
 * Two kinds of Bearer, told apart by prefix and checked against their own
 * store, never forwarded anywhere: `dcl_` API keys (unchanged), and, when
 * OAUTH_ENABLED, OAuth access tokens: this server's own, or, with an external
 * authorization server, that server's (verified against its keys, then mapped
 * to the members the person may act as, on every request). With OAuth on, a
 * protected tool called with no credential gets the spec's HTTP 401 with
 * `WWW-Authenticate: Bearer resource_metadata=...` (what makes a chat app show
 * its Connect button), and a built-in OAuth token lacking a scope gets 403
 * `insufficient_scope` naming every scope the call needs (step-up). Both are
 * decided here, before the SDK runs: a 200 carrying a tool error would never
 * trigger the client's sign-in. API keys keep their tool-level scope errors,
 * because a key's scopes cannot be stepped up, and an external sign-in has no
 * step-up at all: it holds every scope its member's admin role allows. A valid
 * external sign-in that may act nowhere still connects, never a 401 that
 * loops the client back into its sign-in and never a 403 (chat apps show a
 * refused connect as their own error, "Automatic client registration isn't
 * supported", never ours): its tools answer NOT_LINKED (see `notLinked`).
 */
@Controller('mcp')
export class McpController {
  private readonly node: ReturnType<typeof toNodeHandler>;
  private readonly origins: Set<string>;
  private readonly hosts: Set<string>;

  constructor(
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(McpGateway) private readonly gateway: McpGateway,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(RateLimitGuard) private readonly clientKeys: RateLimitGuard,
    @Inject(OAuthService) private readonly oauth: OAuthService,
    @Inject(ExternalOAuthService) private readonly external: ExternalOAuthService,
  ) {
    this.node = toNodeHandler(gateway.handler);
    this.origins = new Set(csv(env.MCP_ALLOWED_ORIGINS));
    this.hosts = new Set(csv(env.MCP_ALLOWED_HOSTS));
  }

  @All()
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    const requestId = requestIdFrom(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);
    if (!this.env.MCP_ENABLED) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Not found.' });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no GET stream, no session to DELETE.
      rpcError(res, 405, -32000, 'Use POST.', { Allow: 'POST' });
      return;
    }
    if (this.hosts.size > 0 && !this.hosts.has(hostnameOf(req.headers.host))) {
      rpcError(res, 403, -32000, 'Host not allowed.');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.origins.has(trimSlash(String(origin).toLowerCase()))) {
      rpcError(res, 403, -32000, 'Origin not allowed.');
      return;
    }
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (URL_CREDENTIAL_PARAMS.some((p) => p in query)) {
      rpcError(res, 400, -32000, 'Send credentials in the Authorization header, never in the URL.');
      return;
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      rpcError(res, 415, -32000, 'Content-Type must be application/json.');
      return;
    }

    const ip = this.clientKeys.keyFor(req);
    const header = req.headers.authorization;
    let principal: MachinePrincipal | null = null;
    let login: { token: ExternalLogin; accounts: LoginAccount[] } | null = null;
    if (header === undefined) {
      // Anonymous: nothing proves who is calling, so the address is the identity.
      const { allowed, retryAfterMs } = this.limiter.take(`mcp:${ip}`);
      if (!allowed) return this.tooMany(res, retryAfterMs);
    } else {
      const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
      const isKey = !!bearer?.startsWith('dcl_');
      let token: ExternalLogin | null = null;
      if (isKey) principal = await this.auth.authenticateKey(bearer!);
      else if (bearer && this.external.enabled) token = await this.external.verify(bearer);
      else if (bearer && this.oauth.enabled) principal = await this.oauth.verifyAccessToken(bearer);
      if (!principal && !token) {
        // A wrong credential costs a lookup: count the attempt against the address.
        const { allowed, retryAfterMs } = this.limiter.take(`mcp-auth:${ip}`);
        if (!allowed) return this.tooMany(res, retryAfterMs);
        if (this.external.enabled && !isKey) {
          // Expired, another audience or issuer, a key we cannot fetch, or not
          // a token at all. The client refreshes or signs in again.
          rpcError(res, 401, -32001, 'Invalid or expired access token.', {
            'WWW-Authenticate': this.external.challenge('invalid_token', 'The access token is invalid or expired.'),
          });
          return;
        }
        if (this.oauth.enabled && !isKey) {
          // Expired, revoked-and-expired, another audience, another issuer, or
          // not ours at all. The client refreshes or signs in again.
          rpcError(res, 401, -32001, 'Invalid or expired access token.', {
            'WWW-Authenticate': this.oauth.challenge([], 'invalid_token', 'The access token is invalid or expired.'),
          });
          return;
        }
        rpcError(res, 401, -32001, 'Invalid, expired or revoked API key.', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
        return;
      }
      if (token) {
        // No account yet still connects, acting nowhere: every tool that is not
        // public says to open the app on the web once (`notLinked`). The server
        // keeps nothing between requests, so the first call after that visit
        // already acts, with no new sign-in.
        const accounts = await this.external.accountsFor(token.subject);
        if (accounts.length === 0) {
          // A budget per person at the door, not per address: hosted chat apps
          // connect many people from one address, and a 429 on connect would
          // be the app's own error again. Its tool calls count per address.
          const { allowed, retryAfterMs } = this.limiter.take(`mcp-login:${signInKey({ token, accounts })}`);
          if (!allowed) return this.tooMany(res, retryAfterMs);
        }
        login = { token, accounts };
        if (accounts.length === 1) principal = loginPrincipal(accounts[0]!, token);
      }
      if (principal) annotateRequestAccount(req, principal.accountId);
      if (principal?.kind === 'oauth' && principal.grantId) this.oauth.noteUse(principal.grantId);
    }

    if (this.external.enabled && principal === null && login === null && toolCallNeeds(req.body).credential) {
      // No scope in the challenge: the external server's scopes are not ours.
      rpcError(res, 401, -32001, 'Sign-in required for this tool.', { 'WWW-Authenticate': this.external.challenge() });
      return;
    }

    if (this.oauth.enabled && (principal === null || principal.kind === 'oauth')) {
      const needs = toolCallNeeds(req.body);
      if (needs.credential && principal === null) {
        rpcError(res, 401, -32001, 'Sign-in required for this tool.', {
          'WWW-Authenticate': this.oauth.challenge(scopeList(BASELINE_SCOPES, needs.scopes)),
        });
        return;
      }
      const missing = principal ? needs.scopes.filter((scope) => !principal!.scopes.includes(scope)) : [];
      if (principal && missing.length > 0) {
        // Every scope the connection needs, not just the missing one: the
        // client re-authorizes with exactly this list.
        rpcError(res, 403, -32001, `This connection needs: ${missing.join(', ')}.`, {
          'WWW-Authenticate': this.oauth.challenge(
            scopeList(principal.scopes, needs.scopes),
            'insufficient_scope',
            `This call needs ${missing.join(' ')}.`,
          ),
        });
        return;
      }
    }

    const call: McpCall = {
      requestId,
      protocolVersion: protocolVersionOf(req),
      ip,
      principal,
      ...(login ? { login } : {}),
      client: clientInfoOf(req),
    };
    // The plaintext credential is never handed on: the handler gets the prefix and scopes.
    (req as Request & { auth?: unknown }).auth = {
      token: '[redacted]',
      clientId: principal?.prefix ?? (login ? 'login' : 'anonymous'),
      scopes: principal?.scopes ?? [],
      extra: { [CALL_KEY]: call },
    };
    await this.node(req as never, res as never, req.body);
  }

  private tooMany(res: Response, retryAfterMs: number): void {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    rpcError(res, 429, -32000, 'Too many requests.', { 'Retry-After': String(seconds) });
  }
}
