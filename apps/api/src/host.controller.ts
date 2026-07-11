import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { brandingSchema } from '@slate/types';
import { checkWebhookUrl } from '@slate/db';
import { ZodError } from 'zod';
import { AdminService } from './admin.service';
import { AuthService, type ReqLike } from './auth.service';
import { assertAdmin } from './permissions';
import { unwrap } from './http';

/**
 * Authed host/dashboard surface. The host/agent path-split is deliberate (R29):
 * this surface uses the SINGULAR `attendee` shape; the machine surface uses
 * `attendees[]`. Identity comes from the AuthProvider (local dev stub / WorkOS).
 */
@Controller('v1')
export class HostController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get('me')
  async me(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    return this.admin.me(p);
  }

  @Get('handle-available')
  async handleAvailable(@Req() req: ReqLike, @Query('handle') handle: string) {
    const p = await this.auth.resolveHost(req);
    if (!handle) throw new BadRequestException({ error: 'BAD_REQUEST', message: 'handle required' });
    return this.admin.handleAvailable(p, handle);
  }

  @Patch('me/settings')
  async updateSettings(
    @Req() req: ReqLike,
    @Body() body: { timeZone?: string; locale?: string | null; weekStart?: string; displayName?: string | null },
  ) {
    const p = await this.auth.resolveHost(req);
    await this.admin.updateSettings(p, body);
    return { ok: true };
  }

  @Patch('me/handle')
  async renameHandle(@Req() req: ReqLike, @Body() body: { handle: string }) {
    const p = await this.auth.resolveHost(req);
    if (!body?.handle)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'handle required' });
    const r = await this.admin.renameHandle(p, body.handle);
    if (!r.ok) throw new ConflictException({ error: 'HANDLE_UNAVAILABLE', message: r.reason ?? 'taken' });
    return { ok: true };
  }

  @Patch('booking-page')
  async updateBranding(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    try {
      const patch = brandingSchema.parse(body);
      await this.admin.updateBranding(p, patch);
      return { ok: true };
    } catch (err) {
      if (err instanceof ZodError)
        throw new BadRequestException({ error: 'BAD_REQUEST', message: err.issues[0]?.message });
      throw err;
    }
  }

  // Host bookings (R29 on-behalf; singular attendee shape).
  @Get('host/bookings')
  async listBookings(@Req() req: ReqLike, @Query() q: Record<string, string>) {
    const p = await this.auth.resolveHost(req);
    return this.admin.listBookings(p, {
      from: q.from,
      to: q.to,
      status: q.status,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  }

  @Post('host/bookings')
  @HttpCode(201)
  async hostCreate(@Req() req: ReqLike, @Body() body: never) {
    const p = await this.auth.resolveHost(req);
    const code = await this.admin.accountCode(p);
    if (!code) throw new BadRequestException({ error: 'BAD_REQUEST', message: 'No account.' });
    const out = await this.admin.hostCreate(p, body, code);
    if (!out.ok) {
      if (out.reason === 'NOT_FOUND') throw new BadRequestException({ error: 'NOT_FOUND', message: 'No such event.' });
      if (out.reason === 'INVALID') throw new BadRequestException({ error: 'INTAKE_INVALID', message: out.message });
      throw new BadRequestException({ error: 'SLOT_TAKEN', message: 'That time is taken.' });
    }
    return { uid: out.booking.uid, status: out.booking.status };
  }

  @Post('host/bookings/:uid/cancel')
  @HttpCode(200)
  async hostCancel(@Req() req: ReqLike, @Param('uid') uid: string, @Body() body: { reason?: string }) {
    const p = await this.auth.resolveHost(req);
    return unwrap(
      (await this.admin.hostCancel(p, uid, body?.reason)).ok
        ? { uid, status: 'cancelled' }
        : { error: 'NOT_FOUND', message: 'Booking not found.', status: 404 },
    );
  }

  @Post('host/bookings/:uid/confirm')
  @HttpCode(200)
  async hostConfirm(@Req() req: ReqLike, @Param('uid') uid: string) {
    const p = await this.auth.resolveHost(req);
    const out = await this.admin.confirm(p, uid);
    if (!out.ok) throw new ConflictException({ error: out.reason, message: 'Cannot confirm.' });
    return { uid, status: 'accepted' };
  }

  @Post('host/bookings/:uid/decline')
  @HttpCode(200)
  async hostDecline(@Req() req: ReqLike, @Param('uid') uid: string, @Body() body: { reason?: string }) {
    const p = await this.auth.resolveHost(req);
    const out = await this.admin.decline(p, uid, body?.reason);
    if (!out.ok) throw new ConflictException({ error: out.reason, message: 'Cannot decline.' });
    return { uid, status: 'rejected' };
  }

  // Connections.
  @Get('connections')
  async listConnections(@Req() req: ReqLike) {
    return this.admin.listConnections(await this.auth.resolveHost(req));
  }
  @Post('connections')
  @HttpCode(201)
  async createConnection(@Req() req: ReqLike, @Body() body: { provider: string; externalId: string; primaryEmail?: string; isDestination?: boolean; checkConflicts?: boolean }) {
    const p = await this.auth.resolveHost(req);
    if (!body?.provider || !body?.externalId)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'provider, externalId required' });
    return this.admin.createConnection(p, body);
  }

  /**
   * Mint the token + connect URL the browser uses to start an OAuth connect flow.
   * When a provider is wired this returns a real `{ token, connectUrl }`; with the
   * OSS default it honestly reports the disabled state (no vendor named — R15).
   */
  @Post('connections/token')
  @HttpCode(200)
  async connectionToken(@Req() req: ReqLike, @Body() body: { provider?: string }) {
    const p = await this.auth.resolveHost(req);
    return this.admin.connectionToken(p, body?.provider ?? 'google');
  }

  /**
   * After the OAuth popup completes, discover + persist the tenant's connection(s)
   * for the provider (idempotent) and return the current connection list.
   */
  @Post('connections/discover')
  @HttpCode(200)
  async discoverConnections(@Req() req: ReqLike, @Body() body: { provider?: string }) {
    const p = await this.auth.resolveHost(req);
    return this.admin.discoverConnections(p, body?.provider ?? 'google');
  }

  /** List the calendars a connected account exposes (post-connect pick). */
  @Get('connections/:id/calendars')
  async listConnectionCalendars(@Req() req: ReqLike, @Param('id') id: string) {
    return this.admin.listConnectionCalendars(await this.auth.resolveHost(req), id);
  }

  @Patch('connections/:id')
  async updateConnection(
    @Req() req: ReqLike,
    @Param('id') id: string,
    @Body() body: { isDestination?: boolean; checkConflicts?: boolean },
  ) {
    const p = await this.auth.resolveHost(req);
    await this.admin.updateConnection(p, id, body);
    return { ok: true };
  }

  @Post('connections/:id/ping')
  @HttpCode(200)
  async pingConnection(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    // Real reachability test when a provider is wired; honest disabled state otherwise.
    return this.admin.pingConnection(p, id);
  }

  @Delete('connections/:id')
  async deleteConnection(@Req() req: ReqLike, @Param('id') id: string) {
    const out = await this.admin.deleteConnection(await this.auth.resolveHost(req), id);
    if (!out.ok)
      throw new ConflictException({
        error: 'LAST_DESTINATION_REQUIRED',
        message: 'Keep at least one destination calendar — unset it as a destination first.',
      });
    return { ok: true };
  }

  // API keys (Developer surface) — admin/owner only.
  @Get('api-keys')
  async listApiKeys(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.listApiKeys(p);
  }
  @Post('api-keys')
  @HttpCode(201)
  async createApiKey(@Req() req: ReqLike, @Body() body: { name: string; scopes: string[]; eventTypeIds?: string[] }) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    if (!body?.name || !Array.isArray(body?.scopes) || body.scopes.length === 0)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'name and >=1 scope required' });
    return this.admin.createApiKey(p, body);
  }
  @Delete('api-keys/:id')
  @HttpCode(204)
  async revokeApiKey(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    await this.admin.revokeApiKey(p, id);
  }

  // Webhooks (Developer surface) — admin/owner only.
  @Get('webhooks')
  async listWebhooks(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.listWebhooks(p);
  }
  @Post('webhooks')
  @HttpCode(201)
  async createWebhook(@Req() req: ReqLike, @Body() body: { subscriberUrl: string; eventTriggers: string[]; secret?: string }) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    if (!body?.subscriberUrl)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'subscriberUrl required' });
    const urlCheck = await checkWebhookUrl(body.subscriberUrl);
    if (!urlCheck.ok)
      throw new BadRequestException({
        error: 'INVALID_WEBHOOK_URL',
        message: `Subscriber URL rejected (${urlCheck.reason}). Must be a public https:// endpoint.`,
      });
    return this.admin.createWebhook(p, { subscriberUrl: body.subscriberUrl, eventTriggers: body.eventTriggers ?? [], secret: body.secret });
  }
  @Patch('webhooks/:id')
  async updateWebhook(@Req() req: ReqLike, @Param('id') id: string, @Body() body: { active?: boolean }) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    await this.admin.updateWebhook(p, id, body);
    return { ok: true };
  }

  @Post('webhooks/:id/ping')
  @HttpCode(200)
  async pingWebhook(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.pingWebhook(p, id);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  async deleteWebhook(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    await this.admin.deleteWebhook(p, id);
  }
}
