import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  addTeamMember,
  changeMemberRole,
  transferOwnership,
  createEventType,
  createSchedule,
  createTeam,
  deleteEventType,
  deleteSchedule,
  deleteTeam,
  getAccountMember,
  getEventTypeById,
  getSchedule,
  getTeamById,
  inviteMember,
  listEventTypes,
  listMembers,
  listSchedules,
  listOneOffLinks,
  listTeamMembers,
  listTeams,
  mintOneOffLink,
  removeMember,
  removeTeamMember,
  revokeOneOffLink,
  setMemberStatus,
  updateEventType,
  updateSchedule,
  updateTeam,
  updateTeamMemberRole,
  type CrudResult,
} from '@slate/db';
import {
  eventTypeInputSchema,
  memberInviteSchema,
  type OneOffLinkView,
  memberPatchSchema,
  scheduleInputSchema,
  teamInputSchema,
  teamMemberInputSchema,
  type CrmPropertyMappings,
} from '@slate/types';
import { oneOffLinkPath } from '@slate/engine';
import { isCompatible, sourceExists, type MappableField } from '@slate/crm/mapping';
import { ZodError } from 'zod';
import { AuthService, type ReqLike } from './auth.service';
import { CrmPropertyCatalogService } from './crm-property-catalog';
import { GrowthService } from './growth.service';
import { assertAdmin, assertCanManageTarget, assertNotSelf, assertOwner, assertOwnsOrAdmin } from './permissions';
import { DB } from './tokens';

function parse<T>(schema: { parse: (v: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: err.issues[0]?.message });
    throw err;
  }
}

function unwrapCrud<T>(r: CrudResult<T>): T {
  if (r.ok) return r.value;
  if (r.reason === 'NOT_FOUND') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
  throw new ConflictException({ error: r.reason, message: r.message ?? 'Conflict.' });
}

/**
 * One stored link as the editor reads it (#110).
 *
 * `path` is built here from the engine's single helper rather than assembled by
 * the client, so the admin list, this response and the web route that serves
 * the link cannot spell the address three different ways — a host copying a
 * link that 404s is the exact failure that would cause.
 */
function toOneOffLinkView(link: {
  id: string;
  token: string;
  createdAt: number;
  createdByMemberId: string | null;
  state: 'live' | 'consumed' | 'revoked';
  consumedAt: number | null;
  consumedBookingUid: string | null;
  revokedAt: number | null;
}): OneOffLinkView {
  return {
    id: link.id,
    token: link.token,
    path: oneOffLinkPath(link.token),
    createdAt: link.createdAt,
    createdByMemberId: link.createdByMemberId,
    state: link.state,
    consumedAt: link.consumedAt,
    consumedBookingUid: link.consumedBookingUid,
    revokedAt: link.revokedAt,
  };
}

/** Host-authed CRUD for event-types, schedules, teams, members. */
@Controller('v1')
export class AdminCrudController {
  private readonly log = new Logger('AdminCrudController');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuthService) private readonly auth: AuthService,
    // Optional so the existing CRUD specs can construct this controller with
    // two arguments. A roster write must never depend on the growth funnel.
    @Optional() @Inject(GrowthService) private readonly growth?: GrowthService,
    // H2 (#108): the portal's property schema, for the save-time compatibility
    // check. LAST and @Optional() for the same reason — absent, the check is
    // skipped and the picker's own filtering is the only guard, which is what
    // every spec that constructs this controller positionally expects.
    @Optional()
    @Inject(CrmPropertyCatalogService)
    private readonly crmProperties?: CrmPropertyCatalogService,
  ) {}

  /**
   * Refuse a mapping this portal could not deliver (#64).
   *
   * The picker already filters to compatible properties, so reaching this needs
   * a hand-written request or a stale editor — but "unreachable beats
   * diagnosable" is the whole reason #64 put a check on the server too. Without
   * it an incompatible pair saves cleanly and then silently delivers nothing,
   * one booking at a time, in an outbox nobody watches.
   *
   * Three cases are deliberately ALLOWED rather than refused, all for the same
   * reason: none of them is a pair that would deliver WRONGLY, and refusing any
   * of them blocks an edit that has nothing to do with the CRM.
   *
   *   - a mapping whose QUESTION is gone. Deleting, renaming or retyping an
   *     intake question orphans its mapping, and that is an ordinary edit — the
   *     one thing it must not do is make the event type unsaveable. The editor
   *     flags the row and drops it from the payload; here it is simply skipped.
   *   - a property the portal does not have. That is the broken-mapping state
   *     the editor already draws in red, and refusing it would make an
   *     unrelated edit unsaveable because somebody deleted a property in the CRM.
   *   - no reachable catalog at all (CRM off, nothing connected, portal down).
   *     Blocking an event-type save because the CRM is briefly unreachable is a
   *     far worse trade than accepting a mapping the picker already filtered.
   */
  private async assertMappingsAreDeliverable(
    accountId: string,
    mappings: CrmPropertyMappings | null | undefined,
    fields: readonly MappableField[],
  ): Promise<void> {
    if (!mappings || !this.crmProperties) return;
    const rows = Object.values(mappings).flat();
    if (rows.length === 0) return;

    const catalog = await this.crmProperties.catalog(accountId);
    if (!catalog.connected || catalog.properties.length === 0) return;
    const byName = new Map(catalog.properties.map((p) => [p.name.toLowerCase(), p]));

    for (const row of rows) {
      // An ORPHANED source is not an incompatible one. `isCompatible` cannot
      // tell them apart — it returns false for both — so the distinction has
      // to be drawn here, before the refusal.
      if (!sourceExists(row.source, fields)) continue;
      for (const target of row.properties) {
        const property = byName.get(target.toLowerCase());
        if (!property) continue;
        if (isCompatible(row.source, property, fields)) continue;
        throw new BadRequestException({
          error: 'CRM_MAPPING_INCOMPATIBLE',
          message: `${target} cannot receive this answer: the property's type does not match the answer's.`,
        });
      }
    }
  }

  // --- Members (workspace roster) ---------------------------------------
  // The whole roster (role + status) is admin/owner-only — it doubles as the
  // host picker for team round-robin selection (also an admin activity).
  @Get('members')
  async members(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return listMembers(this.db, p.accountId);
  }

  @Post('members')
  @HttpCode(201)
  async inviteMember(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const input = parse(memberInviteSchema, body);
    const member = unwrapCrud(await inviteMember(this.db, p.accountId, input));

    // O2 (#65 → Growth funnel): the invitee reaches Dapta's marketing CRM the
    // moment their membership row exists, NOT at template pick — an invitee who
    // never finishes setup is exactly the person this is meant to capture.
    // Enqueue only (invariant 5), and never able to fail the invite: the member
    // was created, and the caller's request is about that.
    if (this.growth) {
      try {
        await this.growth.enqueueMemberInvite(p.accountId, member.id);
      } catch (err) {
        this.log.error(`growth enqueue failed for invited member ${member.id}: ${String(err)}`);
      }
    }
    return member;
  }

  @Patch('members/:id')
  async updateMember(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    assertNotSelf(p, id);
    const input = parse(memberPatchSchema, body);
    const target = await getAccountMember(this.db, p.accountId, id);
    if (!target) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    // Admins may not act on owners, nor promote anyone to owner — owner-only.
    assertCanManageTarget(p, target, { toRole: input.role });
    let updated = target;
    if (input.role !== undefined) updated = unwrapCrud(await changeMemberRole(this.db, p.accountId, id, input.role));
    if (input.status !== undefined) updated = unwrapCrud(await setMemberStatus(this.db, p.accountId, id, input.status));
    return updated;
  }

  @Delete('members/:id')
  @HttpCode(200)
  async removeMember(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    assertNotSelf(p, id);
    const target = await getAccountMember(this.db, p.accountId, id);
    if (!target) return { ok: true }; // idempotent — already gone
    assertCanManageTarget(p, target);
    unwrapCrud(await removeMember(this.db, p.accountId, id));
    return { ok: true };
  }

  // Ownership changes hands ONLY through this dedicated flow (single-owner
  // model, QA2 fix 6b): target becomes owner, caller steps down to admin. The
  // role dropdown can no longer mint owners.
  @Post('members/:id/transfer-ownership')
  async transferOwnership(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertOwner(p);
    assertNotSelf(p, id);
    return unwrapCrud(await transferOwnership(this.db, p.accountId, p.memberId, id));
  }

  // --- Event types -------------------------------------------------------
  @Get('event-types')
  async listEventTypes(@Req() req: ReqLike, @Query('teamId') teamId?: string) {
    const p = await this.auth.resolveHost(req);
    return listEventTypes(this.db, p.accountId, teamId ? { teamId } : { memberId: p.memberId });
  }

  @Get('event-types/:id')
  async getEventType(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const et = await getEventTypeById(this.db, p.accountId, id);
    if (!et) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    // A member sees only their own; admin/owner see anyone's (team events too).
    assertOwnsOrAdmin(p, et.memberId);
    return et;
  }

  @Post('event-types')
  @HttpCode(201)
  async createEventType(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(eventTypeInputSchema, body);
    // A team event-type is a cross-member resource → admin/owner only. A plain
    // member may only create their OWN personal event-type.
    if (input.teamId) assertAdmin(p);
    await this.assertMappingsAreDeliverable(
      p.accountId,
      input.crmPropertyMappings,
      (input.bookingFields ?? []) as MappableField[],
    );
    return unwrapCrud(await createEventType(this.db, p.accountId, p.memberId, input));
  }

  @Patch('event-types/:id')
  async updateEventType(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const existing = await getEventTypeById(this.db, p.accountId, id);
    if (!existing) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    assertOwnsOrAdmin(p, existing.memberId);
    const input = parse(eventTypeInputSchema.partial(), body);
    // Validated against the questions this save LEAVES BEHIND: a partial update
    // that omits `bookingFields` keeps the event's existing ones, and checking
    // against an empty list would refuse every question mapping on such a save.
    await this.assertMappingsAreDeliverable(
      p.accountId,
      input.crmPropertyMappings,
      (input.bookingFields ?? existing.bookingFields ?? []) as MappableField[],
    );
    return unwrapCrud(await updateEventType(this.db, p.accountId, id, input));
  }

  @Delete('event-types/:id')
  @HttpCode(204)
  async deleteEventType(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const existing = await getEventTypeById(this.db, p.accountId, id);
    if (!existing) return; // idempotent — already gone (204)
    assertOwnsOrAdmin(p, existing.memberId);
    await deleteEventType(this.db, p.accountId, id);
  }

  // --- One-off links (#69 / AB2, #110) -----------------------------------
  //
  // A link is a GRANT over an event type, so it hangs off that event type's
  // resource rather than living at a top level of its own. All three routes
  // resolve the principal and pass its `accountId` into the repository call
  // (invariant 4), and all three additionally run `assertOwnsOrAdmin` against
  // the event type they name — a plain member may mint, list and revoke links
  // on their OWN events, while team events (which have no `memberId`) stay
  // admin-and-owner territory exactly as editing them already is.
  //
  // An event type belonging to another account answers the same 404 a
  // non-existent one does, never a 403, so these routes cannot be used to
  // discover which ids exist elsewhere in the deployment.

  /**
   * The links on one event type, newest first.
   *
   * Carries the token IN CLEAR, which is the point (ADR 0003): a host comes
   * back to this list hours or days after minting and copies the link again.
   * It is host-authenticated data and never reaches a public response.
   */
  @Get('event-types/:id/one-off-links')
  async listEventTypeOneOffLinks(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const et = await getEventTypeById(this.db, p.accountId, id);
    if (!et) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    assertOwnsOrAdmin(p, et.memberId);
    return (await listOneOffLinks(this.db, p.accountId, id)).map(toOneOffLinkView);
  }

  /**
   * Mint one.
   *
   * No body: a one-off link has no options. It is a grant over the event type
   * in the path and nothing else — no duration, no availability, no title —
   * because an ad-hoc meeting that exists only as a link would be a second kind
   * of bookable object, and that stays deferred at #69.
   *
   * `createdByMemberId` is the principal, so a shared team event records WHICH
   * host handed the link out.
   */
  @Post('event-types/:id/one-off-links')
  @HttpCode(201)
  async createEventTypeOneOffLink(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const et = await getEventTypeById(this.db, p.accountId, id);
    if (!et) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    assertOwnsOrAdmin(p, et.memberId);
    const link = await mintOneOffLink(this.db, {
      accountId: p.accountId,
      eventTypeId: id,
      createdByMemberId: p.memberId,
    });
    // Unreachable in practice — the ownership read above already passed — but
    // the repository re-checks the account itself, and a null here must not
    // become a 500 shaped like a crash.
    if (!link) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    return toOneOffLinkView(link);
  }

  /**
   * Kill one by hand.
   *
   * ADR 0003 makes revocation a CONDITION of storing the token in clear rather
   * than a nicety: a re-readable token that cannot be withdrawn is a link a
   * host can never take back out of the wrong thread.
   *
   * 204 whether or not the link was still live, like `deleteEventType` above:
   * revoking an already-dead link is a request whose desired state already
   * holds, and reporting that as a failure would make the button lie after a
   * double click or a stale list.
   */
  @Delete('event-types/:id/one-off-links/:linkId')
  @HttpCode(204)
  async revokeEventTypeOneOffLink(
    @Req() req: ReqLike,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
  ) {
    const p = await this.auth.resolveHost(req);
    const et = await getEventTypeById(this.db, p.accountId, id);
    if (!et) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    assertOwnsOrAdmin(p, et.memberId);
    // The event type travels into the WRITE, not just into the permission check
    // above. Without it, `assertOwnsOrAdmin` would be vacuous with respect to
    // the row this mutates: a member could pair their own event's id in the path
    // with a link id belonging to a colleague's event — or to a team event that
    // check makes admin-only — and revoke it. Both rows are in one account, so
    // account scoping alone does not catch it.
    await revokeOneOffLink(this.db, p.accountId, id, linkId);
  }

  // --- Schedules ---------------------------------------------------------
  @Get('schedules')
  async listSchedules(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    return listSchedules(this.db, p.memberId);
  }

  @Get('schedules/:id')
  async getSchedule(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const s = await getSchedule(this.db, p.accountId, id);
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    assertOwnsOrAdmin(p, s.memberId);
    return s;
  }

  @Post('schedules')
  @HttpCode(201)
  async createSchedule(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(scheduleInputSchema, body);
    // A schedule is always created under the caller — nothing cross-member here.
    return createSchedule(this.db, p.accountId, p.memberId, input);
  }

  @Patch('schedules/:id')
  async updateSchedule(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const existing = await getSchedule(this.db, p.accountId, id);
    if (!existing) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    assertOwnsOrAdmin(p, existing.memberId);
    const input = parse(scheduleInputSchema.partial(), body);
    return unwrapCrud(await updateSchedule(this.db, p.accountId, id, input));
  }

  @Delete('schedules/:id')
  @HttpCode(204)
  async deleteSchedule(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const existing = await getSchedule(this.db, p.accountId, id);
    if (!existing) return; // idempotent — already gone (204)
    assertOwnsOrAdmin(p, existing.memberId);
    await deleteSchedule(this.db, p.accountId, id);
  }

  // --- Teams -------------------------------------------------------------
  @Get('teams')
  async listTeams(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    return listTeams(this.db, p.accountId);
  }

  @Post('teams')
  @HttpCode(201)
  async createTeam(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const input = parse(teamInputSchema, body);
    const team = unwrapCrud(await createTeam(this.db, p.accountId, input));
    // The creator is the first OWNER (so a team always has ≥1 owner — F14).
    await addTeamMember(this.db, p.accountId, team.id, p.memberId, 'owner');
    return team;
  }

  @Patch('teams/:id')
  async updateTeam(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const input = parse(teamInputSchema.partial(), body);
    return unwrapCrud(await updateTeam(this.db, p.accountId, id, input));
  }

  @Delete('teams/:id')
  @HttpCode(200)
  async deleteTeam(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return unwrapCrud(await deleteTeam(this.db, p.accountId, id));
  }

  @Get('teams/:id/members')
  async teamMembers(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    const team = await getTeamById(this.db, p.accountId, id);
    if (!team) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Not found.' });
    return listTeamMembers(this.db, p.accountId, id);
  }

  @Post('teams/:id/members')
  @HttpCode(201)
  async addMember(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const input = parse(teamMemberInputSchema, body);
    unwrapCrud(await addTeamMember(this.db, p.accountId, id, input.memberId, input.role));
    return { ok: true };
  }

  @Patch('teams/:id/members/:memberId')
  async updateMemberRole(
    @Req() req: ReqLike,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: { role?: 'owner' | 'member' },
  ) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const role = body?.role === 'owner' ? 'owner' : 'member';
    unwrapCrud(await updateTeamMemberRole(this.db, p.accountId, id, memberId, role));
    return { ok: true };
  }

  @Delete('teams/:id/members/:memberId')
  async removeTeamMember(@Req() req: ReqLike, @Param('id') id: string, @Param('memberId') memberId: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    // Owner-protection: refuses to remove the last owner (409 LAST_OWNER).
    unwrapCrud(await removeTeamMember(this.db, p.accountId, id, memberId));
    return { ok: true };
  }

  @Get('teams/:id/event-types')
  async teamEventTypes(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    return listEventTypes(this.db, p.accountId, { teamId: id });
  }
}
