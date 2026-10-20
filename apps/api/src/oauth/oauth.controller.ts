import {
  All,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { oauthMode, type ServerEnv } from '@slate/config/env';
import { AuthService, type ReqLike } from '../auth.service';
import { assertAdmin } from '../permissions';
import { ENV } from '../tokens';
import { ExternalOAuthService } from './external.service';
import { OAuthService, oauthErrorPage } from './oauth.service';

/**
 * The HTTP surface of the OAuth authorization server, in four controllers.
 * Their ORDER in `AppModule.controllers` matters: the interaction routes are
 * registered before the catch-all mount, or oidc-provider would answer them.
 * Every route answers 404 while OAUTH_ENABLED is off. With an external
 * authorization server only the discovery documents answer: everything else
 * belongs to that server.
 */

function notEnabled(): never {
  throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
}

/**
 * The consent page's 404 while an external authorization server signs people
 * in. Its own code, so the web app answers the page with a 404 instead of the
 * "this request expired" card it shows for a stale built-in request.
 */
function externalSignIn(): never {
  throw new NotFoundException({ error: 'EXTERNAL_AUTHORIZATION_SERVER', message: 'Sign-in happens at the external authorization server.' });
}

/**
 * `/.well-known/oauth-authorization-server` (RFC 8414) and
 * `/.well-known/oauth-protected-resource[/<path>]` (RFC 9728). Clients cache
 * discovery for minutes; so may any proxy.
 */
@Controller('.well-known')
export class OAuthMetadataController {
  constructor(
    @Inject(OAuthService) private readonly oauth: OAuthService,
    @Inject(ExternalOAuthService) private readonly external: ExternalOAuthService,
  ) {}

  /**
   * With an external server: ITS metadata, for clients that still read it from
   * the resource's origin (fetched server-side from the configured issuer,
   * cached; never a header of this request). 503 while it cannot be fetched.
   */
  @Get('oauth-authorization-server')
  async authorizationServer(@Res({ passthrough: true }) res: Response) {
    if (this.external.enabled) {
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
    if (!this.oauth.enabled) notEnabled();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.oauth.authorizationServerMetadata();
  }

  @Get('oauth-protected-resource')
  protectedResource(@Res({ passthrough: true }) res: Response) {
    if (this.external.enabled) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return this.external.protectedResourceMetadata();
    }
    if (!this.oauth.enabled) notEnabled();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.oauth.protectedResourceMetadata();
  }

  /** The path-suffixed form (`/.well-known/oauth-protected-resource/mcp`) clients probe first. */
  @Get('oauth-protected-resource/*')
  protectedResourceForPath(@Res({ passthrough: true }) res: Response) {
    return this.protectedResource(res);
  }
}

/**
 * The two browser stops between oidc-provider and the web consent page.
 * Errors here are dead ends a person reads, so they render a short page.
 */
@Controller('oauth/interaction')
export class OAuthInteractionController {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}

  @Get(':uid')
  async start(@Req() req: Request, @Res() res: Response, @Param('uid') uid: string): Promise<void> {
    if (!this.oauth.enabled) notEnabled();
    let next: string;
    try {
      next = await this.oauth.startInteraction(req, res, uid);
    } catch {
      res
        .status(400)
        .type('html')
        .send(oauthErrorPage('This sign-in link has expired', 'Go back to the app you were connecting and start again.'));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, next);
  }

  @Get(':uid/finish')
  async finish(@Req() req: Request, @Res() res: Response, @Param('uid') uid: string, @Query('ticket') ticket: unknown): Promise<void> {
    if (!this.oauth.enabled) notEnabled();
    const problem = await this.oauth.finish(req, res, uid, ticket);
    if (problem && !res.headersSent) res.status(400).type('html').send(oauthErrorPage('This sign-in could not be completed', problem));
  }
}

/**
 * What the web app calls with the signed-in host's session: the consent
 * decision and the Connected apps list. Every route resolves the principal
 * first (invariant 4); the list and revoke are owner/admin only, like API keys.
 */
@Controller('v1/oauth')
export class OAuthHostController {
  constructor(
    @Inject(OAuthService) private readonly oauth: OAuthService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  /**
   * The consent page with no request to show (no `uid`, or a malformed one):
   * always 404, coded for an external authorization server so the page is a
   * 404 too. No session needed; the mode is public anyway (the
   * protected-resource metadata names the server).
   */
  @Get('consent')
  consentWithoutRequest() {
    if (oauthMode(this.env) === 'external') externalSignIn();
    notEnabled();
  }

  // With an external server the mode decides before the session does: a
  // signed-out visitor gets the 404 straight away, not a login first.
  @Get('consent/:uid')
  async consent(@Req() req: ReqLike, @Param('uid') uid: string) {
    if (oauthMode(this.env) === 'external') externalSignIn();
    const host = await this.auth.resolveHost(req);
    if (!this.oauth.enabled) notEnabled();
    return this.oauth.consentDetails(uid, host);
  }

  @Post('consent/:uid')
  @HttpCode(200)
  async decide(@Req() req: ReqLike, @Param('uid') uid: string, @Body() body: { decision?: unknown }) {
    if (oauthMode(this.env) === 'external') externalSignIn();
    const host = await this.auth.resolveHost(req);
    if (!this.oauth.enabled) notEnabled();
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'deny')
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'decision must be "approve" or "deny".' });
    return this.oauth.decide(uid, host, decision);
  }

  /**
   * The Connected apps list, with the switches the dashboard's MCP pages read:
   * `enabled` (OAuth through this API's own server, whose connections are
   * listed here), `external` (present, true, when an external authorization
   * server signs connections in instead: they live there, so the list stays
   * empty) and `mcpEnabled` (MCP_ENABLED: whether this API serves `/mcp` at
   * all). The page shows how to connect an agent only on `mcpEnabled: true`,
   * so nobody is handed an address that answers 404.
   */
  @Get('grants')
  async grants(@Req() req: ReqLike) {
    const host = await this.auth.resolveHost(req);
    assertAdmin(host);
    const mcpEnabled = this.env.MCP_ENABLED;
    if (oauthMode(this.env) === 'external') return { enabled: false, external: true, mcpEnabled, accessTokenTtlSeconds: null, grants: [] };
    if (!this.oauth.enabled) return { enabled: false, mcpEnabled, accessTokenTtlSeconds: null, grants: [] };
    return {
      enabled: true,
      mcpEnabled,
      accessTokenTtlSeconds: this.oauth.settings!.accessTokenTtlSeconds,
      grants: await this.oauth.listGrants(host.accountId),
    };
  }

  @Delete('grants/:id')
  @HttpCode(204)
  async revoke(@Req() req: ReqLike, @Param('id') id: string): Promise<void> {
    const host = await this.auth.resolveHost(req);
    assertAdmin(host);
    if (!this.oauth.enabled || !(await this.oauth.revokeGrant(host.accountId, id, host.memberId)))
      throw new NotFoundException({ error: 'NOT_FOUND', message: 'Connected app not found.' });
  }
}

/**
 * oidc-provider itself, mounted under `/oauth` with its official NestJS
 * recipe: authorize, token, register, revoke, jwks. The body is left unparsed
 * for it (see `main.ts`). Registration and the token endpoints are throttled
 * per client address before oidc-provider sees the request.
 */
@Controller('oauth')
export class OAuthProviderController {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}

  @All('*')
  async mount(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.oauth.enabled) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Not found.' });
      return;
    }
    const path = req.path.replace(/^\/oauth/, '');
    if (req.method === 'POST') {
      const { allowed, retryAfterMs } = this.oauth.throttle(req, path);
      if (!allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        res.status(429).json({ error: 'temporarily_unavailable', error_description: 'Too many requests. Slow down.' });
        return;
      }
    }
    await this.oauth.handle(req, res);
  }
}
