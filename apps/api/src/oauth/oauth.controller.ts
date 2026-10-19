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
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, type ReqLike } from '../auth.service';
import { assertAdmin } from '../permissions';
import { OAuthService, oauthErrorPage } from './oauth.service';

/**
 * The HTTP surface of the OAuth authorization server, in four controllers.
 * Their ORDER in `AppModule.controllers` matters: the interaction routes are
 * registered before the catch-all mount, or oidc-provider would answer them.
 * Every route answers 404 while OAUTH_ENABLED is off.
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
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}

  @Get('oauth-authorization-server')
  authorizationServer(@Res({ passthrough: true }) res: Response) {
    if (!this.oauth.enabled) notEnabled();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.oauth.authorizationServerMetadata();
  }

  @Get('oauth-protected-resource')
  protectedResource(@Res({ passthrough: true }) res: Response) {
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
  ) {}

  @Get('consent/:uid')
  async consent(@Req() req: ReqLike, @Param('uid') uid: string) {
    const host = await this.auth.resolveHost(req);
    if (!this.oauth.enabled) notEnabled();
    return this.oauth.consentDetails(uid, host);
  }

  @Post('consent/:uid')
  @HttpCode(200)
  async decide(@Req() req: ReqLike, @Param('uid') uid: string, @Body() body: { decision?: unknown }) {
    const host = await this.auth.resolveHost(req);
    if (!this.oauth.enabled) notEnabled();
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'deny')
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'decision must be "approve" or "deny".' });
    return this.oauth.decide(uid, host, decision);
  }

  @Get('grants')
  async grants(@Req() req: ReqLike) {
    const host = await this.auth.resolveHost(req);
    assertAdmin(host);
    if (!this.oauth.enabled) return { enabled: false, accessTokenTtlSeconds: null, grants: [] };
    return {
      enabled: true,
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
