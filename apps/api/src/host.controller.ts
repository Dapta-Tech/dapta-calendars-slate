import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Body,
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
import {
  apiScope,
  attributionClaimSchema,
  brandingSchema,
  integrationConnectSchema,
  onboardingQualificationSchema,
  onboardingSetupSchema,
} from '@slate/types';
import { isValidTimeZone } from '@slate/shared';
import { checkWebhookUrl } from '@slate/db';
import { isAccountTemplateKey, isEmailTemplateKey, type EmailTemplateKey } from '@slate/notifications';
import { ZodError } from 'zod';
import { AdminService } from './admin.service';
import { OnboardingService } from './onboarding.service';
import { GrowthService } from './growth.service';
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
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(GrowthService) private readonly growth: GrowthService,
  ) {}

  /**
   * Identity + the two onboarding gates on ONE response. The web app's admin
   * guard needs the verdicts on the same request it already makes to establish
   * identity — a second round-trip is a second chance to paint the dashboard
   * before the verdict lands, which is the flicker ADR 0002 set out to avoid.
   */
  @Get('me')
  async me(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    const [me, gates] = await Promise.all([this.admin.me(p), this.onboarding.gatesFor(p)]);
    return me ? { ...me, ...gates } : me;
  }

  /**
   * Called once by the browser on first admin mount to report its real IANA
   * timezone (the server never knows this). No-op once the member has an
   * explicit (non-'UTC') timezone — see AdminService.syncClientTimeZone.
   */
  @Post('me/timezone-sync')
  @HttpCode(200)
  async syncTimeZone(@Req() req: ReqLike, @Body() body: { timeZone?: string }) {
    const p = await this.auth.resolveHost(req);
    return this.admin.syncClientTimeZone(p, body?.timeZone ?? '');
  }

  /** The Home "Get bookable" checklist status (real data, not a static nag). */
  @Get('me/setup-status')
  async setupStatus(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    return this.admin.setupStatus(p);
  }

  /**
   * Onboarding's two gates (ADR 0002) — which are owed, this cohort's question
   * set, and the template registry, in ONE payload so the wizard renders its
   * first step without a second round-trip.
   */
  @Get('me/onboarding')
  async onboardingState(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    return this.onboarding.getState(p);
  }

  /**
   * Gate 1 — the account's qualification answers. Owner/admin only: these
   * describe the WORKSPACE, and a plain member answering would send
   * contradictory facts about one business to the growth funnel (ADR 0002).
   * `assertAdmin` is what makes that a rule rather than a UI convention.
   */
  @Post('me/onboarding/qualification')
  @HttpCode(200)
  async submitQualification(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const parsed = onboardingQualificationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    return this.onboarding.submitQualification(p, parsed.data);
  }

  /**
   * Gate 2 — create this host's first event type from a named template. Every
   * active member may call this for themselves, invited members included: the
   * gate is about one host's own public page, not about the workspace.
   */
  @Post('me/onboarding/setup')
  @HttpCode(200)
  async submitSetup(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const parsed = onboardingSetupSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    return this.onboarding.submitSetup(p, parsed.data);
  }

  /**
   * O2 — the wizard's FIRST answer (#65 → Growth funnel).
   *
   * Enqueues the early contact push so someone who types one answer and closes
   * the tab still reaches the funnel. Idempotent per account, so re-opening the
   * wizard cannot push the same lead again.
   *
   * Owner/admin only, matching gate 1: this fires from the qualification step,
   * which only they are ever shown. Returns a plain verdict — the wizard shows
   * nothing either way, and a growth push must never be able to fail a signup.
   */
  @Post('me/onboarding/early')
  @HttpCode(200)
  async onboardingEarly(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.growth.enqueueEarly(p);
  }

  /**
   * O2 — claim the attribution blob parked at the front door, WRITE-ONCE.
   *
   * Called once by the web app's auth callback, right after the identity
   * round-trip. Refused silently (`claimed: false`) when the account already
   * has attribution or is older than the ten-minute window — neither is
   * something the browser can act on.
   *
   * NO role gate, deliberately. The first member of a self-serve account is its
   * owner, but an invited member's very first request could also carry a parked
   * click, and refusing them would lose the attribution that invite arrived
   * under. Both guards that matter are in the write itself: it fires once ever,
   * and only inside the account's first ten minutes.
   */
  @Post('me/attribution')
  @HttpCode(200)
  async claimAttribution(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    const parsed = attributionClaimSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    return this.growth.claim(p, parsed.data.attribution);
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
    // A persisted zone must always format — a bad one used to brick every
    // page that renders times for this member (QA fix 1: "UT}fg").
    if (body?.timeZone !== undefined && !isValidTimeZone(body.timeZone)) {
      throw new BadRequestException({
        error: 'INVALID_TIMEZONE',
        message: 'Unknown time zone (must be a valid IANA zone, e.g. America/Mexico_City).',
      });
    }
    await this.admin.updateSettings(p, body);
    return { ok: true };
  }

  // --- Vanity account slug (premium — included with the Dapta AI subscription).
  @Get('account/vanity')
  async vanityStatus(@Req() req: ReqLike) {
    return this.admin.vanityStatus(await this.auth.resolveHost(req));
  }

  @Patch('account/vanity')
  async setVanity(@Req() req: ReqLike, @Body() body: { vanitySlug?: string | null }) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    if (body?.vanitySlug !== null && typeof body?.vanitySlug !== 'string')
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'vanitySlug (string or null) required' });
    const out = await this.admin.setVanity(p, body.vanitySlug);
    if (!out.ok) {
      if (out.reason === 'NOT_ENTITLED')
        throw new ForbiddenException({
          error: 'DAPTA_SUBSCRIPTION_REQUIRED',
          message: 'Vanity links are included with your Dapta AI subscription.',
        });
      if (out.reason === 'taken')
        throw new ConflictException({ error: 'VANITY_TAKEN', message: 'That link is already in use.' });
      throw new BadRequestException({
        error: out.reason === 'reserved' ? 'VANITY_RESERVED' : 'VANITY_INVALID',
        message:
          out.reason === 'reserved'
            ? 'That word is reserved.'
            : 'Use 3-30 lowercase letters, numbers, or hyphens.',
      });
    }
    return { ok: true, vanitySlug: out.vanitySlug };
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
  /**
   * The host's own availability, resolved by the authenticated member — works
   * before a public handle is set (the public /v1/availability requires one).
   */
  @Get('me/availability')
  async myAvailability(@Req() req: ReqLike, @Query() q: Record<string, string>) {
    const p = await this.auth.resolveHost(req);
    if (!q.slug || !q.from || !q.to)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'slug, from, to required' });
    const r = await this.admin.myAvailability(p, { slug: q.slug, from: q.from, to: q.to, timeZone: q.timeZone });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No such event.' });
    return r;
  }

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
      if (out.reason === 'CALENDAR_UNAVAILABLE')
        throw new ConflictException({
          error: 'CALENDAR_UNAVAILABLE',
          message: 'Could not reach the connected calendar — booking blocked to avoid a double-booking. Check the Calendars page and retry.',
        });
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

  // --- Integrations (H1a / #63). No UI here — that is H1b / #93. ------------
  //
  // Account-level credential, so admin/owner only: a plain member must not be
  // able to repoint or unplug the workspace's CRM. `assertAdmin` is what makes
  // that a rule rather than a UI convention.
  //
  // NOTHING these routes return carries the token or its ciphertext. The
  // service projects each row through `IntegrationStatusView`, so a credential
  // cannot reach a browser by someone forgetting to strip a field.

  @Get('integrations')
  async listIntegrations(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.listIntegrations(p);
  }

  /**
   * What this DEPLOYMENT can do, for a UI that must not offer an action which
   * cannot succeed (H1b / #93).
   *
   * Declared BEFORE `integrations/:provider`-shaped routes so a literal segment
   * is never eaten by a parameter. (`:provider` is only on DELETE today, so
   * there is no live collision — the ordering is here so adding a GET one later
   * cannot quietly shadow this.)
   */
  @Get('integrations/capabilities')
  async integrationCapabilities(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.integrationCapabilities(p);
  }

  /**
   * Connect a pasted private-app token. Fail-closed: the credential is VERIFIED
   * by using it before anything is stored, so a bad token is rejected here
   * rather than surfacing as a silently failing booking a week later.
   *
   * A rejection carries `requiredGranularScopes` — the scope NAME list the
   * provider returned (#74) — so H1b can name the exact checkbox that was
   * missed instead of saying something went wrong.
   */
  @Post('integrations')
  @HttpCode(201)
  async connectIntegration(@Req() req: ReqLike, @Body() body: unknown) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    const parsed = integrationConnectSchema.safeParse(body);
    if (!parsed.success) {
      // Field paths only. The one field that could be echoed here is the token
      // itself, and zod issues carry paths rather than values — which is what
      // keeps a rejected credential out of a 400 body and out of any log that
      // records one.
      throw new BadRequestException({
        error: 'BAD_REQUEST',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    return this.admin.connectIntegration(p, parsed.data);
  }

  /** Disconnect: the credential is scrubbed, nothing is deleted in the CRM. */
  @Delete('integrations/:provider')
  async disconnectIntegration(@Req() req: ReqLike, @Param('provider') provider: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.disconnectIntegration(p, provider);
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
  async connectionToken(@Req() req: ReqLike, @Body() body: { provider?: string; email?: string }) {
    const p = await this.auth.resolveHost(req);
    return this.admin.connectionToken(p, body?.provider ?? 'google', body?.email);
  }

  /**
   * After the OAuth popup completes, discover + persist the tenant's connection(s)
   * for the provider (idempotent) and return the current connection list.
   */
  @Post('connections/discover')
  @HttpCode(200)
  async discoverConnections(@Req() req: ReqLike, @Body() body: { provider?: string; email?: string }) {
    const p = await this.auth.resolveHost(req);
    return this.admin.discoverConnections(p, body?.provider ?? 'google', body?.email);
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

  /**
   * "Test / Run check" — the trust-building self-test. Unlike `/ping`, this
   * actually reads real busy events for the next 14 days (the exact call the
   * booking engine makes) so the host sees proof the pipeline works, not
   * just a health dot.
   */
  @Post('connections/:id/test')
  @HttpCode(200)
  async testConnection(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    return this.admin.testConnection(p, id);
  }

  /**
   * Disconnect any calendar, including the sole/destination one — a host is
   * always allowed to walk down to zero connections; the booking engine
   * already falls back cleanly to availability-only (see deleteConnection).
   */
  @Delete('connections/:id')
  async deleteConnection(@Req() req: ReqLike, @Param('id') id: string) {
    await this.admin.deleteConnection(await this.auth.resolveHost(req), id);
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
    if (body.scopes.some((scope) => !apiScope.includes(scope as (typeof apiScope)[number])))
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'Unknown API-key scope.' });
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

  /** Latest real delivery attempts (QA fix 10) — the dashboard's proof that a
   *  webhook is landing, beyond the manual test ping. */
  @Get('webhooks/:id/deliveries')
  async webhookDeliveries(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return { items: await this.admin.listWebhookDeliveries(p, id) };
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  async deleteWebhook(@Req() req: ReqLike, @Param('id') id: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    await this.admin.deleteWebhook(p, id);
  }

  // Notification settings (Settings → Notifications) — admin/owner only.
  @Get('notification-settings')
  async listNotificationSettings(@Req() req: ReqLike) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    return this.admin.listNotificationSettings(p);
  }

  @Patch('notification-settings/:key')
  async updateNotificationSetting(
    @Req() req: ReqLike,
    @Param('key') key: string,
    @Body() body: { enabled?: boolean; subject?: string | null; body?: string | null },
  ) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    assertAccountTemplateKey(key);
    const patch = parseNotificationPatch(body);
    return this.admin.updateNotificationSetting(p, key, patch);
  }

  /** Render a (possibly unsaved) template against sample data — preview === reality. */
  @Post('notification-settings/:key/preview')
  @HttpCode(200)
  async previewNotificationTemplate(
    @Req() req: ReqLike,
    @Param('key') key: string,
    @Body() body: { subject?: string | null; body?: string | null },
  ) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    assertAccountTemplateKey(key);
    return this.admin.previewNotificationTemplate(p, key, {
      subject: cleanTemplateField(body?.subject, MAX_SUBJECT),
      body: cleanTemplateField(body?.body, MAX_BODY),
    });
  }

  /** Reset to the shipped default template (toggle untouched). */
  @Delete('notification-settings/:key/template')
  @HttpCode(200)
  async resetNotificationTemplate(@Req() req: ReqLike, @Param('key') key: string) {
    const p = await this.auth.resolveHost(req);
    assertAdmin(p);
    assertAccountTemplateKey(key);
    return this.admin.resetNotificationTemplate(p, key);
  }
}

/**
 * Settings → Notifications edits ACCOUNT-WIDE transactional mail only. The
 * reminder and follow-up keys moved to the event type (#68) — one place per
 * thing — so they are refused here with a message that says where they went,
 * rather than silently accepting a write nothing would read.
 */
function assertAccountTemplateKey(key: string): asserts key is EmailTemplateKey {
  if (isAccountTemplateKey(key)) return;
  throw new BadRequestException({
    error: 'BAD_REQUEST',
    message: isEmailTemplateKey(key)
      ? 'Reminders and the follow-up are configured on the event type.'
      : 'Unknown notification key.',
  });
}

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

/** Empty/whitespace template fields mean "back to default" (NULL). */
function cleanTemplateField(v: string | null | undefined, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string')
    throw new BadRequestException({ error: 'BAD_REQUEST', message: 'Template fields must be strings.' });
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max)
    throw new BadRequestException({ error: 'BAD_REQUEST', message: `Template field too long (max ${max}).` });
  return trimmed;
}

/**
 * The account-wide template patch. Lead times are deliberately absent: they
 * live on the event type now (#68), and `assertAccountTemplateKey` has already
 * rejected the only two keys that ever carried one — so there is nothing left
 * for this to key off, and no lead field to accept.
 */
function parseNotificationPatch(
  body: { enabled?: unknown; subject?: unknown; body?: unknown },
): { enabled?: boolean; subject?: string | null; body?: string | null } {
  const patch: ReturnType<typeof parseNotificationPatch> = {};
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'enabled must be a boolean.' });
    patch.enabled = body.enabled;
  }
  if (body?.subject !== undefined)
    patch.subject = cleanTemplateField(body.subject as string | null, MAX_SUBJECT);
  if (body?.body !== undefined)
    patch.body = cleanTemplateField(body.body as string | null, MAX_BODY);
  return patch;
}
