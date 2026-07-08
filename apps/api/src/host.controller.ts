import {
  BadRequestException,
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
import { ZodError } from 'zod';
import { AdminService } from './admin.service';
import { AuthService, type ReqLike } from './auth.service';
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
  @Delete('connections/:id')
  @HttpCode(204)
  async deleteConnection(@Req() req: ReqLike, @Param('id') id: string) {
    await this.admin.deleteConnection(await this.auth.resolveHost(req), id);
  }

  // API keys.
  @Get('api-keys')
  async listApiKeys(@Req() req: ReqLike) {
    return this.admin.listApiKeys(await this.auth.resolveHost(req));
  }
  @Post('api-keys')
  @HttpCode(201)
  async createApiKey(@Req() req: ReqLike, @Body() body: { name: string; scopes: string[]; eventTypeIds?: string[] }) {
    const p = await this.auth.resolveHost(req);
    if (!body?.name || !Array.isArray(body?.scopes) || body.scopes.length === 0)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'name and >=1 scope required' });
    return this.admin.createApiKey(p, body);
  }
  @Delete('api-keys/:id')
  @HttpCode(204)
  async revokeApiKey(@Req() req: ReqLike, @Param('id') id: string) {
    await this.admin.revokeApiKey(await this.auth.resolveHost(req), id);
  }

  // Webhooks.
  @Get('webhooks')
  async listWebhooks(@Req() req: ReqLike) {
    return this.admin.listWebhooks(await this.auth.resolveHost(req));
  }
  @Post('webhooks')
  @HttpCode(201)
  async createWebhook(@Req() req: ReqLike, @Body() body: { subscriberUrl: string; eventTriggers: string[]; secret?: string }) {
    const p = await this.auth.resolveHost(req);
    if (!body?.subscriberUrl)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'subscriberUrl required' });
    return this.admin.createWebhook(p, { subscriberUrl: body.subscriberUrl, eventTriggers: body.eventTriggers ?? [], secret: body.secret });
  }
  @Delete('webhooks/:id')
  @HttpCode(204)
  async deleteWebhook(@Req() req: ReqLike, @Param('id') id: string) {
    await this.admin.deleteWebhook(await this.auth.resolveHost(req), id);
  }
}
