import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Db } from '@slate/db';
import { getAccountByCode, getEventType, getMember, listBookings, sql } from '@slate/db';
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
    });
    return { items: res.items, nextCursor: null };
  }
}
