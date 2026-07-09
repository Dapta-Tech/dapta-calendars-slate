import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  addAttendeeToBooking,
  getAccountByCode,
  getEventType,
  getMember,
  listBookings,
  resolveBooking,
  sql,
} from '@slate/db';
import { BookingService } from './booking.service';
import { AuthService, type ReqLike } from './auth.service';
import { unwrap } from './http';
import { DB } from './tokens';

/**
 * Agent / machine surface — API-key authenticated. Deliberately distinct from
 * the host surface (path-split): bookings use `attendees[]` (plural) and lists
 * return an `{items,nextCursor}` envelope. Voice/flow-node integrations depend
 * on this exact shape. The key is account-scoped; a per-key eventType allowlist
 * enforces resource scope, and an out-of-scope target is indistinguishable from
 * not-found (both 403 — anti-uid-probing).
 */
@Controller('v1/machine')
export class MachineController {
  constructor(
    @Inject(BookingService) private readonly svc: BookingService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DB) private readonly db: Db,
  ) {}

  private async accountCode(accountId: string): Promise<string | null> {
    const row = await this.db.get<{ code: string }>(
      sql`SELECT code FROM account WHERE id = ${accountId} LIMIT 1`,
    );
    return row?.code ?? null;
  }

  private async resolveEventTypeId(accountId: string, handle: string, slug: string) {
    const account = await getAccountByCode(this.db, (await this.accountCode(accountId))!);
    if (!account) return null;
    const member = await getMember(this.db, account.id, handle);
    if (!member) return null;
    const et = await getEventType(this.db, account.id, member.id, slug);
    return et?.id ?? null;
  }

  @Get('availability')
  async availability(@Req() req: ReqLike, @Query() q: Record<string, string>) {
    const principal = await this.auth.resolveMachine(req, 'availability:read');
    const code = await this.accountCode(principal.accountId);
    if (!code || !q.handle || !q.slug || !q.from || !q.to)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'handle, slug, from, to required' });
    const etId = await this.resolveEventTypeId(principal.accountId, q.handle, q.slug);
    this.auth.assertEventTypeAllowed(principal, etId);
    const r = await this.svc.availability({ ...q, accountCode: code });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    return r;
  }

  @Post('bookings')
  @HttpCode(201)
  async book(
    @Req() req: ReqLike,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: {
      handle: string;
      slug: string;
      startUtc: string;
      attendees: Array<{ name: string; email: string; timeZone: string; notes?: string; phone?: string }>;
      answers?: Record<string, unknown>;
    },
  ) {
    const principal = await this.auth.resolveMachine(req, 'bookings:write');
    const code = await this.accountCode(principal.accountId);
    if (!code || !body?.handle || !body?.slug || !body?.startUtc || !Array.isArray(body?.attendees) || body.attendees.length === 0)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'handle, slug, startUtc, attendees[] required' });
    const etId = await this.resolveEventTypeId(principal.accountId, body.handle, body.slug);
    this.auth.assertEventTypeAllowed(principal, etId);

    const primary = body.attendees[0]!;
    const result = unwrap(
      await this.svc.book(
        {
          accountCode: code,
          handle: body.handle,
          slug: body.slug,
          startUtc: body.startUtc,
          attendee: primary,
          answers: body.answers,
          idempotencyKey,
        },
        true,
      ),
    );
    // Machine envelope: attendees[] (plural).
    return {
      uid: result.uid,
      status: result.status,
      startUtc: result.startUtc,
      endUtc: result.endUtc,
      attendees: [result.attendee],
    };
  }

  @Get('bookings')
  async list(@Req() req: ReqLike, @Query() q: Record<string, string>) {
    const principal = await this.auth.resolveMachine(req, 'bookings:read');
    const res = await listBookings(this.db, {
      accountId: principal.accountId,
      // Honor the key's resource allowlist: an event-type-scoped key must not
      // read the whole account's bookings. null → unrestricted.
      eventTypeIds: principal.eventTypeIds,
      from: q.from ? new Date(q.from).getTime() : undefined,
      to: q.to ? new Date(q.to).getTime() : undefined,
      status: q.status,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor,
    });
    // P1-3: real keyset pagination — nextCursor is non-null when more remain.
    return { items: res.items, nextCursor: res.nextCursor };
  }

  /**
   * Resolve a booking within the key's account + resource allowlist. A uid that
   * is out-of-account OR out-of-scope both surface as 403 (anti-uid-probing) so
   * an agent can't enumerate other tenants' booking ids.
   */
  private async scopedBooking(req: ReqLike, uid: string, scope: 'bookings:write' | 'bookings:read') {
    const principal = await this.auth.resolveMachine(req, scope);
    const b = await resolveBooking(this.db, uid, principal.accountId);
    if (!b) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Not permitted.' });
    this.auth.assertEventTypeAllowed(principal, b.event_type_id);
    return { principal, b };
  }

  @Patch('bookings/:uid')
  async reschedule(
    @Req() req: ReqLike,
    @Param('uid') uid: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { newStartUtc: string },
  ) {
    await this.scopedBooking(req, uid, 'bookings:write');
    if (!body?.newStartUtc)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'newStartUtc required' });
    // P1-2: honor Idempotency-Key so an agent retry doesn't double-move.
    return unwrap(await this.svc.reschedule(uid, { newStartUtc: body.newStartUtc, byHost: true, idempotencyKey }));
  }

  @Post('bookings/:uid/cancel')
  @HttpCode(200)
  async cancel(
    @Req() req: ReqLike,
    @Param('uid') uid: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: { reason?: string },
  ) {
    await this.scopedBooking(req, uid, 'bookings:write');
    // P1-1/P1-2: a retried cancel returns success (already-cancelled), not 410.
    return unwrap(await this.svc.cancel(uid, { reason: body?.reason, byHost: true, idempotencyKey }));
  }

  @Post('bookings/:uid/attendees')
  @HttpCode(201)
  async addAttendee(
    @Req() req: ReqLike,
    @Param('uid') uid: string,
    @Body() body: { attendee: { name: string; email: string; timeZone?: string; notes?: string; phone?: string } },
  ) {
    const { principal } = await this.scopedBooking(req, uid, 'bookings:write');
    const a = body?.attendee;
    if (!a?.name || !a?.email)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'attendee name + email required' });
    await addAttendeeToBooking(this.db, uid, principal.accountId, {
      name: a.name,
      email: a.email,
      timeZone: a.timeZone ?? 'UTC',
      notes: a.notes,
      phone: a.phone,
    });
    return { ok: true, uid };
  }
}
