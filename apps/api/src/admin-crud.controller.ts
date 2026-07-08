import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
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
  addTeamMember,
  createEventType,
  createSchedule,
  createTeam,
  deleteEventType,
  deleteSchedule,
  deleteTeam,
  getEventTypeById,
  getSchedule,
  getTeamById,
  listAccountMembers,
  listEventTypes,
  listSchedules,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  updateEventType,
  updateSchedule,
  updateTeam,
  type CrudResult,
} from '@slate/db';
import {
  eventTypeInputSchema,
  scheduleInputSchema,
  teamInputSchema,
  teamMemberInputSchema,
} from '@slate/types';
import { ZodError } from 'zod';
import { AuthService, type ReqLike } from './auth.service';
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

/** Host-authed CRUD for event-types, schedules, teams, members. */
@Controller('v1')
export class AdminCrudController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // --- Members (for pickers) --------------------------------------------
  @Get('members')
  async members(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    return listAccountMembers(this.db, p.accountId);
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
    return et;
  }

  @Post('event-types')
  @HttpCode(201)
  async createEventType(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(eventTypeInputSchema, body);
    return unwrapCrud(await createEventType(this.db, p.accountId, p.memberId, input));
  }

  @Patch('event-types/:id')
  async updateEventType(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(eventTypeInputSchema.partial(), body);
    return unwrapCrud(await updateEventType(this.db, p.accountId, id, input));
  }

  @Delete('event-types/:id')
  @HttpCode(204)
  async deleteEventType(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    await deleteEventType(this.db, p.accountId, id);
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
    return s;
  }

  @Post('schedules')
  @HttpCode(201)
  async createSchedule(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(scheduleInputSchema, body);
    return createSchedule(this.db, p.accountId, p.memberId, input);
  }

  @Patch('schedules/:id')
  async updateSchedule(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(scheduleInputSchema.partial(), body);
    return unwrapCrud(await updateSchedule(this.db, p.accountId, id, input));
  }

  @Delete('schedules/:id')
  @HttpCode(204)
  async deleteSchedule(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
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
    const input = parse(teamInputSchema, body);
    return unwrapCrud(await createTeam(this.db, p.accountId, input));
  }

  @Patch('teams/:id')
  async updateTeam(@Req() req: ReqLike, @Param('id') id: string, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const input = parse(teamInputSchema.partial(), body);
    return unwrapCrud(await updateTeam(this.db, p.accountId, id, input));
  }

  @Delete('teams/:id')
  @HttpCode(200)
  async deleteTeam(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
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
    const input = parse(teamMemberInputSchema, body);
    unwrapCrud(await addTeamMember(this.db, p.accountId, id, input.memberId, input.role));
    return { ok: true };
  }

  @Delete('teams/:id/members/:memberId')
  @HttpCode(204)
  async removeMember(@Req() req: ReqLike, @Param('id') id: string, @Param('memberId') memberId: string) {
    const p = await this.auth.resolveHost(req);
    await removeTeamMember(this.db, p.accountId, id, memberId);
  }

  @Get('teams/:id/event-types')
  async teamEventTypes(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    return listEventTypes(this.db, p.accountId, { teamId: id });
  }
}
