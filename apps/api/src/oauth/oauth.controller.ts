import { Controller, Get, Inject, NotFoundException, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { oauthMode, type ServerEnv } from '@slate/config/env';
import { AuthService, type ReqLike } from '../auth.service';
import { assertAdmin } from '../permissions';
import { ENV } from '../tokens';
import { ExternalOAuthService } from './external.service';

/**
 * The HTTP surface of OAuth for the MCP endpoint. This API is an OAuth
 * resource server only: sign-in, consent, client registration and tokens
 * belong to the external authorization server (OAUTH_AUTHORIZATION_SERVER).
 * What is left here is discovery, and the switches the dashboard reads. Every
 * discovery route answers 404 while OAuth is off.
 */

function notEnabled(): never {
  throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
}

/**
 * `/.well-known/oauth-authorization-server` (RFC 8414) and
 * `/.well-known/oauth-protected-resource[/<path>]` (RFC 9728). Clients cache
 * discovery for minutes; so may any proxy.
 */
@Controller('.well-known')
export class OAuthMetadataController {
  constructor(@Inject(ExternalOAuthService) private readonly external: ExternalOAuthService) {}

  /**
   * The external server's metadata, for clients that still read it from the
   * resource's origin (fetched server-side from the configured issuer, cached;
   * never a header of this request). 503 while it cannot be fetched.
   */
  @Get('oauth-authorization-server')
  async authorizationServer(@Res({ passthrough: true }) res: Response) {
    if (!this.external.enabled) notEnabled();
    let metadata: Record<string, unknown>;
    try {
      metadata = await this.external.authorizationServerMetadata();
    } catch {
      res.setHeader('Cache-Control', 'no-store');
      throw new ServiceUnavailableException({ error: 'UNAVAILABLE', message: 'The authorization server metadata could not be fetched. Try again shortly.' });
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return metadata;
  }

  @Get('oauth-protected-resource')
  protectedResource(@Res({ passthrough: true }) res: Response) {
    if (!this.external.enabled) notEnabled();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.external.protectedResourceMetadata();
  }

  /** The path-suffixed form (`/.well-known/oauth-protected-resource/mcp`) clients probe first. */
  @Get('oauth-protected-resource/*')
  protectedResourceForPath(@Res({ passthrough: true }) res: Response) {
    return this.protectedResource(res);
  }
}

/**
 * The switches the dashboard's MCP pages read, at the address the Connected
 * apps list used to live (an older web build still calls it): `external`
 * (true when an external authorization server signs connections in) and
 * `mcpEnabled` (MCP_ENABLED: whether this API serves `/mcp` at all; the page
 * shows how to connect an agent only then, so nobody is handed an address that
 * answers 404). `enabled` and `grants` stay for that older build: this API
 * keeps no connections of its own any more. Owner/admin only, like API keys.
 */
@Controller('v1/oauth')
export class OAuthHostController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  @Get('grants')
  async grants(@Req() req: ReqLike) {
    const host = await this.auth.resolveHost(req);
    assertAdmin(host);
    return {
      enabled: false,
      ...(oauthMode(this.env) === 'external' ? { external: true } : {}),
      mcpEnabled: this.env.MCP_ENABLED,
      accessTokenTtlSeconds: null,
      grants: [],
    };
  }
}
