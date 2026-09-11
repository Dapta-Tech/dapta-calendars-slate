import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { cancelBooking, createTeamBooking, getTeamAvailability, reserveSlot } from './parity';
import { createEventType, createTeam } from './crud';
import {
  consumeOneOffLink,
  getOneOffLinkByToken,
  listOneOffLinks,
  mintOneOffLink,
  oneOffGuardApplies,
  resolveOneOffLink,
  revokeOneOffLink,
} from './one-off-link';

/**
 * One-off links (#69, unit AB2 / #110).
 *
 * A grant a host mints over an event type they already have, pastes into one
 * message to one intended invitee, and which dies the moment a booking is made
 * against it. Both public write paths carry it — `createBooking` (personal) and
 * `createTeamBooking` (team) — and those live in different files, so every
 * behaviour is asserted on BOTH.
 *
 * Like the duplicate-booking guard it ships beside, this is not a security
 * control; these tests pin the product behaviour a host is promised.
 */
describe('one-off links (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  // --- Fixtures -----------------------------------------------------------

  /** A personal event on Alex. HIDDEN by default: that is the only shape over
   *  which a one-off link limits anything, and therefore the real case. */
  async function makePersonalEvent(
    slug: string,
    opts: { hidden?: boolean; requiresConfirmation?: boolean } = {},
  ) {
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
      hidden: opts.hidden ?? true,
      requiresConfirmation: opts.requiresConfirmation ?? false,
    });
    if (!ev.ok) throw new Error('event create failed');
    return ev.value.id;
  }

  async function makeTeamEvent(slug: string, opts: { hidden?: boolean } = {}) {
    const team = await createTeam(db, accountId, { name: slug, slug: `${slug}-team` });
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
    return { eventTypeId: ev.value.id, teamSlug: `${slug}-team`, slug };
  }

  async function mint(eventTypeId: string) {
    const link = await mintOneOffLink(db, { accountId, eventTypeId, createdByMemberId: alexId });
    if (!link) throw new Error('mint failed');
    return link;
  }

  /** Slots for a HIDDEN event — only reachable with the link's opt-in. */
  async function personalSlots(slug: string): Promise<number[]> {
    const r = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
      includeHidden: true,
    });
    return (r?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
  }

  async function teamSlots(t: { teamSlug: string; slug: string }): Promise<number[]> {
    const r = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: t.teamSlug,
      slug: t.slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
      includeHidden: true,
    });
    return (r?.slots ?? []).map((s) => new Date(s).getTime());
  }

  const bookPersonal = (slug: string, startMs: number, extra: Record<string, unknown> = {}) =>
    createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs,
      attendee: { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' },
      ...extra,
    });

  const bookTeam = (
    t: { teamSlug: string; slug: string },
    startMs: number,
    extra: Record<string, unknown> = {},
  ) =>
    createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: t.teamSlug,
      slug: t.slug,
      startMs,
      attendee: { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' },
      ...extra,
    });

  // --- Minting, listing, scoping -----------------------------------------

  it('mints a live link carrying a readable token', async () => {
    const eventTypeId = await makePersonalEvent('mintable');
    const link = await mint(eventTypeId);
    expect(link.state).toBe('live');
    expect(link.eventTypeId).toBe(eventTypeId);
    expect(link.createdByMemberId).toBe(alexId);
    // ADR 0003: stored IN CLEAR, so the host can copy it again days later.
    // A re-read returns the same token rather than a fresh one.
    expect((await getOneOffLinkByToken(db, link.token))?.token).toBe(link.token);
  });

  it('mints N links over one event type — there is no cap here', async () => {
    const eventTypeId = await makePersonalEvent('many');
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) tokens.add((await mint(eventTypeId)).token);
    expect(tokens.size).toBe(5);
    expect(await listOneOffLinks(db, accountId, eventTypeId)).toHaveLength(5);
  });

  it('refuses to mint over another account’s event type', async () => {
    // Invariant 4, defence in depth: the function is exported from @slate/db,
    // so holding an event-type id alone must not reach another tenant.
    const eventTypeId = await makePersonalEvent('scoped');
    expect(await mintOneOffLink(db, { accountId: randomUUID(), eventTypeId })).toBeUndefined();
  });

  it('lists and revokes only within the account', async () => {
    const eventTypeId = await makePersonalEvent('listing');
    const link = await mint(eventTypeId);
    expect(await listOneOffLinks(db, randomUUID(), eventTypeId)).toEqual([]);
    expect(await revokeOneOffLink(db, randomUUID(), eventTypeId, link.id)).toBe(false);
    expect(await revokeOneOffLink(db, accountId, eventTypeId, link.id)).toBe(true);
    // Revoking twice is not an error, it is simply nothing left to do.
    expect(await revokeOneOffLink(db, accountId, eventTypeId, link.id)).toBe(false);
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('revoked');
  });

  // --- Resolution ---------------------------------------------------------

  it('resolves a live personal link to its canonical public target', async () => {
    await makePersonalEvent('resolvable');
    const link = await mint(
      (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='resolvable'`))!.id,
    );
    const r = await resolveOneOffLink(db, link.token);
    expect(r).toMatchObject({
      state: 'live',
      target: { kind: 'personal', accountCode: 'acme', handle: 'alex-rivera', slug: 'resolvable' },
    });
  });

  it('resolves a live team link to its team target', async () => {
    const t = await makeTeamEvent('teamres');
    const link = await mint(t.eventTypeId);
    const r = await resolveOneOffLink(db, link.token);
    expect(r).toMatchObject({
      state: 'live',
      target: { kind: 'team', accountCode: 'acme', teamSlug: t.teamSlug, slug: t.slug },
    });
  });

  it('resolves an unknown token to nothing at all — the 404 case', async () => {
    expect(await resolveOneOffLink(db, 'a'.repeat(43))).toBeUndefined();
  });

  it('reports consumed and revoked apart, though both answer 410 upstream', async () => {
    const consumedEvent = await makePersonalEvent('c1');
    const consumed = await mint(consumedEvent);
    await consumeOneOffLink(db, consumed.id, randomUUID());
    expect(await resolveOneOffLink(db, consumed.token)).toEqual({ state: 'consumed' });

    const revokedEvent = await makePersonalEvent('c2');
    const revoked = await mint(revokedEvent);
    await revokeOneOffLink(db, accountId, revokedEvent, revoked.id);
    expect(await resolveOneOffLink(db, revoked.token)).toEqual({ state: 'revoked' });
  });

  it('resolves a link over a VISIBLE event too — it limits nothing, but it works', async () => {
    // Requirement 4 is a warning in the editor, never a block: the host may
    // have a reason to mint one over a publicly bookable event.
    const eventTypeId = await makePersonalEvent('public-one', { hidden: false });
    const link = await mint(eventTypeId);
    expect((await resolveOneOffLink(db, link.token))?.state).toBe('live');
  });

  // --- The personal write path -------------------------------------------

  it('personal: a live link books a HIDDEN event and is consumed by it', async () => {
    const eventTypeId = await makePersonalEvent('hidden-personal');
    const link = await mint(eventTypeId);
    const slots = await personalSlots('hidden-personal');

    const booked = await bookPersonal('hidden-personal', slots[0]!, { oneOffToken: link.token });
    expect(booked.ok).toBe(true);

    const after = await getOneOffLinkByToken(db, link.token);
    expect(after?.state).toBe('consumed');
    expect(after?.consumedAt).toBeTypeOf('number');
  });

  it('personal: without the link the hidden event is not bookable at all', async () => {
    await makePersonalEvent('hidden-nolink');
    const slots = await personalSlots('hidden-nolink');
    const out = await bookPersonal('hidden-nolink', slots[0]!);
    // The ordinary 404 a hidden event has always given — the link is the only
    // thing that changes this, and it is what makes the grant worth anything.
    expect(out).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('personal: a consumed link is ONE_OFF_GONE, and a guessed one is ONE_OFF_NOT_FOUND', async () => {
    const eventTypeId = await makePersonalEvent('twice');
    const link = await mint(eventTypeId);
    const slots = await personalSlots('twice');
    expect((await bookPersonal('twice', slots[0]!, { oneOffToken: link.token })).ok).toBe(true);

    expect(await bookPersonal('twice', slots[1]!, { oneOffToken: link.token })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_GONE',
    });
    expect(await bookPersonal('twice', slots[1]!, { oneOffToken: 'z'.repeat(43) })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_NOT_FOUND',
    });
  });

  it('personal: a link for one event does NOT open another', async () => {
    // Without this check a token minted over a throwaway public event would
    // unlock every hidden event on the account.
    const a = await makePersonalEvent('event-a');
    await makePersonalEvent('event-b');
    const linkForA = await mint(a);
    const slots = await personalSlots('event-b');
    expect(await bookPersonal('event-b', slots[0]!, { oneOffToken: linkForA.token })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_NOT_FOUND',
    });
    // ...and A's link is untouched by the attempt.
    expect((await getOneOffLinkByToken(db, linkForA.token))?.state).toBe('live');
  });

  it('personal: a revoked link is refused before the booking is attempted', async () => {
    const eventTypeId = await makePersonalEvent('revoked-book');
    const link = await mint(eventTypeId);
    await revokeOneOffLink(db, accountId, eventTypeId, link.id);
    const slots = await personalSlots('revoked-book');
    expect(await bookPersonal('revoked-book', slots[0]!, { oneOffToken: link.token })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_GONE',
    });
  });

  // --- PENDING counts -----------------------------------------------------

  it('a PENDING booking consumes the link exactly as an accepted one does', async () => {
    // The link did its job the moment it produced a booking. A host who has
    // not confirmed yet has still had the meeting requested.
    const eventTypeId = await makePersonalEvent('needs-conf', { requiresConfirmation: true });
    const link = await mint(eventTypeId);
    const slots = await personalSlots('needs-conf');

    const booked = await bookPersonal('needs-conf', slots[0]!, { oneOffToken: link.token });
    expect(booked.ok).toBe(true);
    if (booked.ok) expect(booked.booking.status).toBe('pending');
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('consumed');
  });

  // --- The rule a refactor will get wrong ---------------------------------

  it('a CANCEL never revives the link — it stays consumed, the host mints another', async () => {
    // THIS IS THE ONE. "The booking was cancelled, so free the link up again"
    // is the obvious-looking change, and it is wrong: the link is spent by
    // producing a booking, not by that booking surviving.
    const eventTypeId = await makePersonalEvent('cancel-me');
    const link = await mint(eventTypeId);
    const slots = await personalSlots('cancel-me');

    const booked = await bookPersonal('cancel-me', slots[0]!, { oneOffToken: link.token });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const cancelled = await cancelBooking(db, { uid: booked.booking.uid, byHost: true, accountId });
    expect(cancelled.ok).toBe(true);

    const after = await getOneOffLinkByToken(db, link.token);
    expect(after?.state).toBe('consumed');
    expect(after?.consumedAt).toBeTypeOf('number');
    // And the dead link still refuses a second booking on the freed slot.
    expect(await bookPersonal('cancel-me', slots[0]!, { oneOffToken: link.token })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_GONE',
    });
  });

  it('a PENDING booking that is cancelled does not revive it either', async () => {
    const eventTypeId = await makePersonalEvent('pending-cancel', { requiresConfirmation: true });
    const link = await mint(eventTypeId);
    const slots = await personalSlots('pending-cancel');
    const booked = await bookPersonal('pending-cancel', slots[0]!, { oneOffToken: link.token });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    await cancelBooking(db, { uid: booked.booking.uid, byHost: true, accountId });
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('consumed');
  });

  // --- The team write path ------------------------------------------------

  it('team: a live link books a HIDDEN team event and is consumed by it', async () => {
    const t = await makeTeamEvent('hidden-team');
    const link = await mint(t.eventTypeId);
    const slots = await teamSlots(t);
    expect((await bookTeam(t, slots[0]!, { oneOffToken: link.token })).ok).toBe(true);
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('consumed');
  });

  it('team: without the link the hidden team event is not bookable', async () => {
    const t = await makeTeamEvent('hidden-team-nolink');
    const slots = await teamSlots(t);
    expect(await bookTeam(t, slots[0]!)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  it('team: consumed answers ONE_OFF_GONE and a guess answers ONE_OFF_NOT_FOUND', async () => {
    const t = await makeTeamEvent('team-twice');
    const link = await mint(t.eventTypeId);
    const slots = await teamSlots(t);
    expect((await bookTeam(t, slots[0]!, { oneOffToken: link.token })).ok).toBe(true);
    expect(await bookTeam(t, slots[1]!, { oneOffToken: link.token })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_GONE',
    });
    expect(await bookTeam(t, slots[1]!, { oneOffToken: 'z'.repeat(43) })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_NOT_FOUND',
    });
  });

  it('team: a personal event’s link does not open a team event', async () => {
    const personal = await makePersonalEvent('personal-for-team');
    const link = await mint(personal);
    const t = await makeTeamEvent('team-crossed');
    const slots = await teamSlots(t);
    expect(await bookTeam(t, slots[0]!, { oneOffToken: link.token })).toMatchObject({
      ok: false,
      reason: 'ONE_OFF_NOT_FOUND',
    });
  });

  // --- Exemptions, exactly as AB1 does them -------------------------------

  it('oneOffGuardApplies exempts host and API-key writes, and nothing else', () => {
    expect(oneOffGuardApplies({})).toBe(true);
    expect(oneOffGuardApplies({ onBehalf: true })).toBe(false);
    // The v2 compatibility surface is an API-key write that reports
    // onBehalf: false, which is why keying on onBehalf alone is not enough.
    expect(oneOffGuardApplies({ apiKeyWrite: true, onBehalf: false })).toBe(false);
  });

  it('an onBehalf write succeeds with no link at all, and burns none', async () => {
    // Exemption means NOT SUBJECT to the grant. It is not a visibility widening:
    // a hidden event stays hidden to these writes exactly as it does today, so
    // this asserts the exemption over a VISIBLE event, which is where a host
    // write lives.
    const eventTypeId = await makePersonalEvent('on-behalf', { hidden: false });
    const link = await mint(eventTypeId);
    const slots = await personalSlots('on-behalf');
    const out = await createBooking(db, {
      accountCode: 'acme',
      memberId: alexId,
      slug: 'on-behalf',
      startMs: slots[0]!,
      attendee: { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' },
      onBehalf: true,
    });
    expect(out.ok).toBe(true);
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('live');
  });

  it('an API-key write succeeds with no link, and ignores one it carries', async () => {
    const eventTypeId = await makePersonalEvent('api-key', { hidden: false });
    const link = await mint(eventTypeId);
    const slots = await personalSlots('api-key');
    const out = await bookPersonal('api-key', slots[0]!, {
      apiKeyWrite: true,
      oneOffToken: link.token,
    });
    expect(out.ok).toBe(true);
    // Carried, exempt, therefore never burned — the host's link is still good.
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('live');
  });

  it('an API-key write is not refused by a link that is already dead', async () => {
    // The sharpest form of the exemption: a dead token on an exempt write must
    // not turn a booking the integration is entitled to make into a 410.
    const eventTypeId = await makePersonalEvent('api-key-dead', { hidden: false });
    const link = await mint(eventTypeId);
    await revokeOneOffLink(db, accountId, eventTypeId, link.id);
    const slots = await personalSlots('api-key-dead');
    expect(
      (await bookPersonal('api-key-dead', slots[0]!, { apiKeyWrite: true, oneOffToken: link.token }))
        .ok,
    ).toBe(true);
  });

  it('team: an API-key write succeeds with no link', async () => {
    const t = await makeTeamEvent('team-api-key', { hidden: false });
    const slots = await teamSlots(t);
    expect((await bookTeam(t, slots[0]!, { apiKeyWrite: true })).ok).toBe(true);
  });

  // --- What the link does NOT grant --------------------------------------

  it('a link does not let a booking skip availability', async () => {
    // The grant opens an event; it never widens what that event offers.
    const eventTypeId = await makePersonalEvent('off-hours');
    const link = await mint(eventTypeId);
    const slots = await personalSlots('off-hours');
    const offHours = slots[0]! + 13 * 60_000; // not on the slot grid
    expect(await bookPersonal('off-hours', offHours, { oneOffToken: link.token })).toMatchObject({
      ok: false,
      reason: 'INVALID',
    });
    expect((await getOneOffLinkByToken(db, link.token))?.state).toBe('live');
  });

  it('holds a slot on a hidden event so the booking flow can complete', async () => {
    // reserveSlot resolves the event type too, so without the same opt-in the
    // invitee cannot get past the slot picker on the event the link opens.
    await makePersonalEvent('holdable');
    const slots = await personalSlots('holdable');
    const held = await reserveSlot(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'holdable',
      startMs: slots[0]!,
      includeHidden: true,
    });
    expect(held.ok).toBe(true);
    // ...and without it, the hidden event is invisible exactly as before.
    const denied = await reserveSlot(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'holdable',
      startMs: slots[1]!,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });

  // --- Consumption is a single statement ---------------------------------

  it('only one consumer is ever recorded for a link', async () => {
    const eventTypeId = await makePersonalEvent('race');
    const link = await mint(eventTypeId);
    const first = randomUUID();
    const second = randomUUID();
    expect(await consumeOneOffLink(db, link.id, first)).toBe(true);
    expect(await consumeOneOffLink(db, link.id, second)).toBe(false);
    const row = await db.get<{ consumed_booking_id: string }>(
      sql`SELECT consumed_booking_id FROM one_off_link WHERE id = ${link.id}`,
    );
    expect(row?.consumed_booking_id).toBe(first);
  });

  it('a revoked link cannot then be consumed', async () => {
    const eventTypeId = await makePersonalEvent('revoked-consume');
    const link = await mint(eventTypeId);
    await revokeOneOffLink(db, accountId, eventTypeId, link.id);
    expect(await consumeOneOffLink(db, link.id, randomUUID())).toBe(false);
  });

  it('a group-event seat consumes the link — one link cannot fill every seat', async () => {
    // The seat-taker branch joins an EXISTING booking row rather than creating
    // one, so it is the one consume site that does not go through the dialect
    // write paths. Without this, a single link would keep opening the event for
    // every remaining seat, which is the opposite of what it is for.
    const ev = await createEventType(db, accountId, alexId, {
      slug: 'group-seat',
      title: 'group-seat',
      lengthMinutes: 30,
      scheduleId: null,
      hidden: true,
      seatsPerTimeSlot: 3,
    });
    if (!ev.ok) throw new Error('event create failed');
    const first = await mint(ev.value.id);
    const second = await mint(ev.value.id);
    const slots = await personalSlots('group-seat');

    // First booker creates the row and burns their own link.
    expect((await bookPersonal('group-seat', slots[0]!, { oneOffToken: first.token })).ok).toBe(true);
    expect((await getOneOffLinkByToken(db, first.token))?.state).toBe('consumed');

    // Second booker takes a SEAT on that same row, with their own link, and
    // burns it too.
    const seat = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'group-seat',
      startMs: slots[0]!,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      oneOffToken: second.token,
    });
    expect(seat.ok).toBe(true);
    expect((await getOneOffLinkByToken(db, second.token))?.state).toBe('consumed');

    // And the first link cannot take a third seat.
    expect(
      await createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'group-seat',
        startMs: slots[0]!,
        attendee: { name: 'Rae', email: 'rae@example.com', timeZone: 'America/New_York' },
        oneOffToken: first.token,
      }),
    ).toMatchObject({ ok: false, reason: 'ONE_OFF_GONE' });
  });

  it('the list names the booking that consumed a link', async () => {
    const eventTypeId = await makePersonalEvent('listed-consumer');
    const link = await mint(eventTypeId);
    const slots = await personalSlots('listed-consumer');
    const booked = await bookPersonal('listed-consumer', slots[0]!, { oneOffToken: link.token });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    const [listed] = await listOneOffLinks(db, accountId, eventTypeId);
    expect(listed?.state).toBe('consumed');
    expect(listed?.consumedBookingUid).toBe(booked.booking.uid);
  });
});
