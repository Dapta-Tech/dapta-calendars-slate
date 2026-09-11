import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  migrate,
  seed,
  sql,
  createTeam,
  createEventType,
  mintOneOffLink,
  getOneOffLinkByToken,
  revokeOneOffLink,
  type Db,
} from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { PublicController } from './public.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * One-off links (#69 / AB2, #110) at the API boundary.
 *
 * The unit under test here is the RESPONSE CODES, which are the half of #110
 * that a reviewer cannot check by reading the repository:
 *
 *   410 ONE_OFF_GONE       a link that was real and is spent or revoked
 *   404 NOT_FOUND          a token that names nothing — shaped like any other
 *                          missing route, and saying nothing about links
 *   409 DUPLICATE_BOOKING  AB1's, untouched by this unit
 *
 * Three codes, three causes, and the 404 must stay indistinguishable from the
 * one an unknown booking page already gives.
 */
describe('one-off links — API mapping', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;

  const service = () =>
    new BookingService(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );

  const WINDOW = () => ({
    from: new Date().toISOString(),
    to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });

  const attendee = { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' };

  /** 43 base64url characters — the right SHAPE, so it reaches the lookup. */
  const WELL_FORMED_BUT_UNKNOWN = 'z'.repeat(43);

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  /** A HIDDEN personal event on Alex — the shape a one-off link is FOR. */
  async function personalEvent(slug: string, opts: { hidden?: boolean } = {}) {
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
      hidden: opts.hidden ?? true,
    });
    if (!ev.ok) throw new Error('event create failed');
    return ev.value.id;
  }

  async function teamEvent(slug: string, opts: { hidden?: boolean } = {}) {
    const teamSlug = `${slug}-team`;
    const team = await createTeam(db, accountId, { name: slug, slug: teamSlug });
    if (!team.ok) throw new Error('team create failed');
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType: 'round_robin',
      scheduleId: null,
      teamId: team.value.id,
      hidden: opts.hidden ?? true,
    });
    if (!ev.ok) throw new Error('event create failed');
    const now = Date.now();
    for (const memberId of [alexId, jordanId]) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, 0, NULL, 100, NULL, ${now})`,
      );
    }
    return { eventTypeId: ev.value.id, teamSlug, slug };
  }

  async function mint(eventTypeId: string) {
    const link = await mintOneOffLink(db, { accountId, eventTypeId, createdByMemberId: alexId });
    if (!link) throw new Error('mint failed');
    return link;
  }

  // --- The resolve route --------------------------------------------------

  it('answers a live link with its target and nothing else', async () => {
    const controller = new PublicController(service());
    const link = await mint(await personalEvent('resolve-live'));

    const target = await controller.oneOffLink(link.token);
    expect(target).toEqual({
      kind: 'personal',
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'resolve-live',
    });
    // Exactly the addressing triple, and no more. The handle is part of the
    // address, so a name appearing inside it is expected; what must NOT appear
    // is the token itself, the event's title, the host's display name, or any
    // hint about the link's own lifecycle.
    expect(Object.keys(target as object).sort()).toEqual([
      'accountCode',
      'handle',
      'kind',
      'slug',
    ]);
    expect(JSON.stringify(target)).not.toMatch(/token|title|displayName|consumed|revoked/i);
  });

  it('answers a CONSUMED link 410, and keeps answering 410 after a cancel', async () => {
    const svc = service();
    const controller = new PublicController(svc);
    const eventTypeId = await personalEvent('resolve-consumed');
    const link = await mint(eventTypeId);
    const w = WINDOW();

    const avail = await svc.availability(
      { accountCode: 'acme', handle: 'alex-rivera', slug: 'resolve-consumed', ...w },
      link.token,
    );
    const booked = await svc.book(
      {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'resolve-consumed',
        startUtc: avail!.slots[0]!.startUtc,
        attendee,
      },
      false,
      { oneOffToken: link.token },
    );
    expect('error' in booked).toBe(false);
    if ('error' in booked) return;

    await expect(controller.oneOffLink(link.token)).rejects.toMatchObject({
      status: 410,
      response: { error: 'ONE_OFF_GONE' },
    });

    // The rule a refactor will get wrong: cancelling does not hand the link
    // back. It is still 410, not 200.
    await svc.cancel(booked.uid, { token: '', reason: 'changed my mind', byHost: true, accountId });
    await expect(controller.oneOffLink(link.token)).rejects.toMatchObject({ status: 410 });
  });

  it('answers a REVOKED link 410 too — the host killed it', async () => {
    const controller = new PublicController(service());
    const eventTypeId = await personalEvent('resolve-revoked');
    const link = await mint(eventTypeId);
    await revokeOneOffLink(db, accountId, eventTypeId, link.id);
    await expect(controller.oneOffLink(link.token)).rejects.toMatchObject({
      status: 410,
      response: { error: 'ONE_OFF_GONE' },
    });
  });

  it('answers an unknown token with the SAME 404 an unknown booking page gives', async () => {
    const svc = service();
    const controller = new PublicController(svc);

    const guessed = await controller.oneOffLink(WELL_FORMED_BUT_UNKNOWN).catch((e) => e);
    const missingPage = await controller.profile('acme', 'nobody-here').catch((e) => e);

    expect(guessed.status).toBe(404);
    expect(missingPage.status).toBe(404);
    // Same status AND same error code. A body that said "invite link" would
    // confirm to a guesser that this deployment mints them.
    expect(guessed.response.error).toBe('NOT_FOUND');
    expect(missingPage.response.error).toBe('NOT_FOUND');
    expect(JSON.stringify(guessed.response)).not.toMatch(/invite|one.?off|link|token/i);
  });

  it('answers a malformed token 404 without touching the database', async () => {
    const controller = new PublicController(service());
    for (const junk of ['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`]) {
      await expect(controller.oneOffLink(junk)).rejects.toMatchObject({ status: 404 });
    }
  });

  // --- The write paths ----------------------------------------------------

  it('personal: a live link books the hidden event, then 410s on re-use', async () => {
    const svc = service();
    const eventTypeId = await personalEvent('write-personal');
    const link = await mint(eventTypeId);
    const w = WINDOW();
    const query = { accountCode: 'acme', handle: 'alex-rivera', slug: 'write-personal', ...w };

    // Without the token the hidden event is not even readable.
    expect(await svc.availability(query)).toBeNull();
    const avail = await svc.availability(query, link.token);
    expect(avail!.slots.length).toBeGreaterThan(1);

    const body = (startUtc: string) => ({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'write-personal',
      startUtc,
      attendee,
    });

    const first = await svc.book(body(avail!.slots[0]!.startUtc), false, {
      oneOffToken: link.token,
    });
    expect('error' in first).toBe(false);

    const second = await svc.book(body(avail!.slots[1]!.startUtc), false, {
      oneOffToken: link.token,
    });
    expect(second).toMatchObject({ error: 'ONE_OFF_GONE', status: 410 });
  });

  it('personal: a guessed token on the write path is 404, not 410', async () => {
    const svc = service();
    await personalEvent('write-guessed', { hidden: false });
    const w = WINDOW();
    const avail = await svc.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'write-guessed',
      ...w,
    });
    const out = await svc.book(
      {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'write-guessed',
        startUtc: avail!.slots[0]!.startUtc,
        attendee,
      },
      false,
      { oneOffToken: WELL_FORMED_BUT_UNKNOWN },
    );
    expect(out).toMatchObject({ error: 'NOT_FOUND', status: 404 });
  });

  it('team: the same behaviour through createTeamBooking', async () => {
    const svc = service();
    const t = await teamEvent('write-team');
    const link = await mint(t.eventTypeId);
    const w = WINDOW();

    expect(await svc.teamAvailability('acme', t.teamSlug, t.slug, w.from, w.to)).toBeNull();
    const avail = await svc.teamAvailability(
      'acme',
      t.teamSlug,
      t.slug,
      w.from,
      w.to,
      undefined,
      link.token,
    );
    expect(avail!.slots.length).toBeGreaterThan(1);

    const body = (startUtc: string) => ({ slug: t.slug, startUtc, attendee });
    const first = await svc.teamBook('acme', t.teamSlug, body(avail!.slots[0]!.startUtc), {
      oneOffToken: link.token,
    });
    expect('error' in first).toBe(false);

    const second = await svc.teamBook('acme', t.teamSlug, body(avail!.slots[1]!.startUtc), {
      oneOffToken: link.token,
    });
    expect(second).toMatchObject({ error: 'ONE_OFF_GONE', status: 410 });
  });

  // --- What the header may and may not do ---------------------------------

  it('a link for one event does not unhide another', async () => {
    const svc = service();
    const openEvent = await personalEvent('decoy', { hidden: false });
    await personalEvent('secret');
    const decoyLink = await mint(openEvent);
    const w = WINDOW();

    // Presenting a perfectly live token while asking about a DIFFERENT event
    // must leave that event exactly as hidden as it was.
    expect(
      await svc.availability(
        { accountCode: 'acme', handle: 'alex-rivera', slug: 'secret', ...w },
        decoyLink.token,
      ),
    ).toBeNull();
  });

  it('the token is read from the header, never from the booking body', async () => {
    // The public booking routes are unauthenticated and the controller hands
    // the service an unvalidated body. A token honoured off that body would be
    // a second, unaudited carrier for a credential.
    const svc = service();
    const controller = new PublicController(svc);
    const eventTypeId = await personalEvent('header-only');
    const link = await mint(eventTypeId);
    const w = WINDOW();
    const avail = await svc.availability(
      { accountCode: 'acme', handle: 'alex-rivera', slug: 'header-only', ...w },
      link.token,
    );

    await expect(
      controller.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'header-only',
        startUtc: avail!.slots[0]!.startUtc,
        attendee,
        oneOffToken: link.token,
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    // The link was never touched by the attempt.
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('live');

    // Through the header it works.
    const ok = await controller.book(
      {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'header-only',
        startUtc: avail!.slots[0]!.startUtc,
        attendee,
      },
      link.token,
    );
    expect(ok).toHaveProperty('uid');
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('consumed');
  });

  it('AB1’s 409 is untouched — three codes, three causes', async () => {
    const svc = service();
    const ev = await createEventType(db, accountId, alexId, {
      slug: 'ab1-still-409',
      title: 'ab1-still-409',
      lengthMinutes: 30,
      scheduleId: null,
      preventDuplicateBookings: true,
    });
    if (!ev.ok) throw new Error('event create failed');
    const w = WINDOW();
    const avail = await svc.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'ab1-still-409',
      ...w,
    });
    const body = (startUtc: string) => ({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'ab1-still-409',
      startUtc,
      attendee,
    });
    expect('error' in (await svc.book(body(avail!.slots[0]!.startUtc)))).toBe(false);
    expect(await svc.book(body(avail!.slots[1]!.startUtc))).toMatchObject({
      error: 'DUPLICATE_BOOKING',
      status: 409,
    });
  });
});
