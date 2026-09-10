import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { PublicController } from './public.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * #136 — the public TEAM availability route had no window clamp and no schema
 * validating its query, while the personal route had both. It is unauthenticated
 * by design, so one request could ask for a decade of slot generation across
 * every host of a collective event, and the per-IP rate limiter counts requests
 * rather than window width. An unparseable `from` became `NaN` and travelled
 * into the engine instead of being rejected at the edge.
 *
 * #135 adds the release route these assert alongside it, because both are the
 * same surface: what one anonymous caller can do to what other visitors see.
 */
describe('public availability bounds (#136) and slot release (#135)', () => {
  let db: Db;

  const service = () =>
    new BookingService(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );
  const controller = () => new PublicController(service());

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  /** Tomorrow at UTC midnight: fixed within a run, and always ahead of the
   *  seeded schedule's minimum notice so the window has slots in it. */
  const FROM = new Date(
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z',
  ).toISOString();
  const plus = (ms: number) => new Date(new Date(FROM).getTime() + ms).toISOString();

  describe('team availability window', () => {
    it('clamps a ten-year range to the same answer a maximum-width range gives', async () => {
      const c = controller();
      const wide = await c.teamAvailability('acme', 'sales', {
        slug: 'team-demo',
        from: FROM,
        to: plus(10 * 365 * 86_400_000),
      });
      const capped = await c.teamAvailability('acme', 'sales', {
        slug: 'team-demo',
        from: FROM,
        to: plus(MAX_AVAILABILITY_WINDOW_MS),
      });

      // Identical, not merely bounded: the clamp rewrites `to`, so the decade
      // request and the maximum-width request are the same query.
      expect(wide!.slots.map((s) => s.startUtc)).toEqual(capped!.slots.map((s) => s.startUtc));
      expect(wide!.slots.length).toBeGreaterThan(0);
    });

    it('offers no slot past the window cap however wide the range asked for', async () => {
      const c = controller();
      const r = await c.teamAvailability('acme', 'sales', {
        slug: 'team-demo',
        from: FROM,
        to: plus(10 * 365 * 86_400_000),
      });
      const ceiling = new Date(FROM).getTime() + MAX_AVAILABILITY_WINDOW_MS;
      for (const s of r!.slots) expect(new Date(s.startUtc).getTime()).toBeLessThanOrEqual(ceiling);
    });

    it('answers 400 for an unparseable `from` instead of passing NaN to the engine', async () => {
      const c = controller();
      await expect(
        c.teamAvailability('acme', 'sales', { slug: 'team-demo', from: 'yesterday', to: plus(86_400_000) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 400 for an instant with no offset, a missing bound, and a missing slug', async () => {
      const c = controller();
      // `2026-03-02T00:00:00` names no instant without a zone — the personal
      // route has always refused it, and the team route accepted it.
      await expect(
        c.teamAvailability('acme', 'sales', {
          slug: 'team-demo',
          from: '2026-03-02T00:00:00',
          to: plus(86_400_000),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        c.teamAvailability('acme', 'sales', { slug: 'team-demo', from: FROM } as Record<string, string>),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        c.teamAvailability('acme', 'sales', { from: FROM, to: plus(86_400_000) } as Record<string, string>),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still answers 404 for an unknown team event, not 400', async () => {
      const c = controller();
      await expect(
        c.teamAvailability('acme', 'sales', { slug: 'no-such-event', from: FROM, to: plus(86_400_000) }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('leaves the personal route answering exactly what it did', async () => {
      const c = controller();
      const wide = await c.availability({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        from: FROM,
        to: plus(10 * 365 * 86_400_000),
      });
      const capped = await c.availability({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        from: FROM,
        to: plus(MAX_AVAILABILITY_WINDOW_MS),
      });
      expect(wide!.slots.map((s) => s.startUtc)).toEqual(capped!.slots.map((s) => s.startUtc));
    });
  });

  describe('release route', () => {
    async function firstPersonalSlot(c: PublicController): Promise<string> {
      const a = await c.availability({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        from: new Date().toISOString(),
        to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      });
      const startUtc = a?.slots[0]?.startUtc;
      if (!startUtc) throw new Error('the seeded page offered no slots');
      return startUtc;
    }

    it('gives the held slot back to the next visitor', async () => {
      const c = controller();
      const startUtc = await firstPersonalSlot(c);
      const held = (await c.reserve({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc,
      })) as { reservationUid: string };

      const duringHold = await firstPersonalSlot(c);
      expect(duringHold).not.toBe(startUtc);

      expect(await c.releaseReservation({ reservationUid: held.reservationUid })).toEqual({
        released: true,
      });
      expect(await firstPersonalSlot(c)).toBe(startUtc);
    });

    it('answers the same success for a uid that names nothing, so it cannot probe for holds', async () => {
      const c = controller();
      const startUtc = await firstPersonalSlot(c);
      const held = (await c.reserve({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc,
      })) as { reservationUid: string };

      const foreign = await c.releaseReservation({
        reservationUid: '00000000-0000-4000-8000-000000000000',
      });
      const real = await c.releaseReservation({ reservationUid: held.reservationUid });
      // Byte-identical answers: a caller learns nothing from either.
      expect(foreign).toEqual(real);
    });

    it("does not free someone else's hold", async () => {
      const c = controller();
      const startUtc = await firstPersonalSlot(c);
      await c.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc });

      await c.releaseReservation({ reservationUid: '00000000-0000-4000-8000-000000000000' });

      expect(await firstPersonalSlot(c)).not.toBe(startUtc);
    });

    it('rejects a body with no uid rather than releasing at random', async () => {
      const c = controller();
      await expect(c.releaseReservation({})).rejects.toBeInstanceOf(BadRequestException);
      await expect(c.releaseReservation({ reservationUid: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cannot cancel a booking handed its uid', async () => {
      const c = controller();
      const startUtc = await firstPersonalSlot(c);
      const booking = (await c.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc,
        attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
        answers: { company: 'Acme' },
      })) as { uid: string; status: string };

      await c.releaseReservation({ reservationUid: booking.uid });

      const row = await db.get<{ status: string }>(
        sql`SELECT status FROM booking WHERE uid = ${booking.uid}`,
      );
      expect(row?.status).toBe(booking.status);
      expect(await firstPersonalSlot(c)).not.toBe(startUtc);
    });
  });
});
