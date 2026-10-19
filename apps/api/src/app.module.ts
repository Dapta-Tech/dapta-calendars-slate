import { Logger, Module } from '@nestjs/common';
import { createDb } from '@slate/db';
import {
  createEmailProvider,
  BookingNotifier,
  mailSupportAddress,
  type EmailProvider,
} from '@slate/notifications';
import { ANALYTICS_GROUP_TYPE, badgeHidden, buildSignupUrl } from '@slate/shared';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import {
  ANALYTICS,
  AUTH_PROVIDER,
  CALENDAR,
  CRM,
  DB,
  EMAIL,
  ENTITLEMENTS,
  ENV,
  NOTIFIER,
  PREMIUM_MODE,
  RATE_LIMITER,
} from './tokens';
import { BookingService } from './booking.service';
import { AdminService } from './admin.service';
import { OnboardingService } from './onboarding.service';
import { AuthService } from './auth.service';
import { CalendarEffects } from './calendar-effects';
import { CrmEffects } from './crm-effects';
import { CrmPropertyCatalogService } from './crm-property-catalog';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { GrowthService } from './growth.service';
import { OutboxWorker } from './outbox.worker';
import { RateLimitGuard, createRateLimiter } from './rate-limit';
import { createCalendarProviderAsync } from './calendar.provider';
import { resolveEntitlementsProvider } from './entitlements.provider';
import { entitlementGateProvider } from './entitlement-gate';
import { resolveCrmProvider } from '@slate/crm';
import { createAuthProvider } from './auth.provider';
import { createAnalyticsProvider } from './analytics.provider';
import { AnalyticsEffects } from './analytics-effects';
import type { Db } from '@slate/db';
import { HealthController, DocsController } from './controllers';
import { PublicController } from './public.controller';
import { HostController } from './host.controller';
import { MachineController } from './machine.controller';
import { AdminCrudController } from './admin-crud.controller';
import { CalV2Controller, CalV2RequestIdInterceptor } from './cal-v2.controller';
import { CalV2Service } from './cal-v2.service';
import { CalV2PilotService } from './cal-v2-pilot.service';
import { McpController } from './mcp/mcp.controller';
import { McpGateway } from './mcp/mcp.gateway';
import {
  OAuthHostController,
  OAuthInteractionController,
  OAuthMetadataController,
  OAuthProviderController,
} from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';

@Module({
  controllers: [
    HealthController,
    DocsController,
    PublicController,
    HostController,
    MachineController,
    CalV2Controller,
    McpController,
    // OAuth for the MCP endpoint (off unless OAUTH_ENABLED). The interaction
    // routes MUST stay before the provider's catch-all mount under /oauth.
    OAuthMetadataController,
    OAuthInteractionController,
    OAuthHostController,
    OAuthProviderController,
    AdminCrudController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadServerEnv() },
    { provide: DB, useFactory: () => createDb() },
    {
      provide: EMAIL,
      useFactory: (env: ServerEnv) =>
        createEmailProvider({
          provider: env.EMAIL_PROVIDER,
          fromEmail: env.MAIL_FROM_EMAIL,
          fromName: env.MAIL_FROM_NAME,
          smtp: {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          },
          http: {
            endpoint: env.EMAIL_HTTP_ENDPOINT,
            profile: env.EMAIL_HTTP_PROFILE,
            token: env.EMAIL_HTTP_TOKEN,
            clientId: env.EMAIL_HTTP_CLIENT_ID,
            signingSecret: env.EMAIL_HTTP_SIGNING_SECRET,
            apiKey: env.EMAIL_HTTP_API_KEY,
            category: env.EMAIL_HTTP_CATEGORY,
          },
        }),
      inject: [ENV],
    },
    {
      provide: NOTIFIER,
      // The invitee's footer line ("Made with ... Create your free calendar")
      // follows the same open-core switch as the page's badge: no destination,
      // or the hide flag, and the email names no product. The "Need help?"
      // line names the deployment's own support address, or nothing (F10).
      useFactory: (email: EmailProvider, env: ServerEnv) => {
        const supportEmail = mailSupportAddress(env.MAIL_SUPPORT_EMAIL);
        // Never a reason to refuse to boot, but never silent either: a set
        // value that is not a bare address would otherwise just vanish.
        if (env.MAIL_SUPPORT_EMAIL && !supportEmail) {
          new Logger('Notifications').warn(
            'MAIL_SUPPORT_EMAIL is not a bare email address; booking emails carry no support line.',
          );
        }
        return new BookingNotifier(email, {
          signupUrl: badgeHidden(env.HIDE_BADGE ?? env.NEXT_PUBLIC_HIDE_BADGE)
            ? null
            : buildSignupUrl({ baseUrl: env.SIGNUP_URL ?? env.NEXT_PUBLIC_SIGNUP_URL, medium: 'email' }),
          supportEmail,
        });
      },
      inject: [EMAIL, ENV],
    },
    // CalendarProvider selected by CALENDAR_PROVIDER: the OSS default is
    // `disabled` (no external calendar); a private overlay ships the `external`
    // adapter. See calendar.provider.ts.
    {
      provide: CALENDAR,
      useFactory: (env: ServerEnv) => createCalendarProviderAsync(env),
      inject: [ENV],
    },
    // CrmProvider selected by CRM_PROVIDER: the OSS default is `disabled` (no
    // CRM at all, nothing enqueued). Unlike the calendar seam this adapter is
    // committed in-repo and names its vendor — ADR 0001 carves CRM out of R15.
    {
      provide: CRM,
      useFactory: (env: ServerEnv) => resolveCrmProvider(env),
      inject: [ENV],
    },
    // Premium entitlements (vanity slug…): Calendars is always free — the gate
    // is the customer's Dapta AI subscription via the upstream service. OSS
    // default: disabled provider + PREMIUM_FEATURES=open (everything unlocked).
    {
      provide: ENTITLEMENTS,
      useFactory: (env: ServerEnv) => resolveEntitlementsProvider(env),
      inject: [ENV],
    },
    {
      provide: PREMIUM_MODE,
      useFactory: (env: ServerEnv) => env.PREMIUM_FEATURES,
      inject: [ENV],
    },
    // ONE cached-verdict gate for the whole app: the public pages, the emails
    // and Settings share its in-flight map and failure backoff, so a burst
    // anywhere makes one upstream call per account.
    entitlementGateProvider,
    // Product analytics (the deployment's own telemetry). OSS default: no
    // provider, so nothing is enqueued or sent. A provider set without a usable
    // key or host is OFF, said once here, and never a reason to refuse to boot.
    {
      provide: ANALYTICS,
      useFactory: (env: ServerEnv) => {
        const provider = createAnalyticsProvider(env, ANALYTICS_GROUP_TYPE);
        const asked = env.PRODUCT_ANALYTICS_PROVIDER?.trim().toLowerCase();
        if (!provider && asked && asked !== 'none') {
          new Logger('Analytics').warn(
            'PRODUCT_ANALYTICS_PROVIDER is set but the provider, key or host is not usable; analytics is off.',
          );
        }
        return provider;
      },
      inject: [ENV],
    },
    AnalyticsEffects,
    // Host auth backend selected by AUTH_PROVIDER (local stub / WorkOS overlay).
    // Signups are reported through a plain callback, because accounts and
    // members are created just in time inside the provider: there is no signup
    // endpoint to instrument, and the providers stay ignorant of analytics.
    {
      provide: AUTH_PROVIDER,
      useFactory: (env: ServerEnv, db: Db, analytics: AnalyticsEffects) =>
        createAuthProvider(env, db, analytics.onSignup),
      inject: [ENV, DB, AnalyticsEffects],
    },
    // Rate limiter for the public surface (P1-5): token bucket by default, noop
    // when RATE_LIMIT_ENABLED=false; swappable for a distributed limiter.
    {
      provide: RATE_LIMITER,
      useFactory: (env: ServerEnv) => createRateLimiter(env),
      inject: [ENV],
    },
    RateLimitGuard,
    BookingService,
    CalV2Service,
    CalV2PilotService,
    CalV2RequestIdInterceptor,
    McpGateway,
    OAuthService,
    AdminService,
    OnboardingService,
    GrowthService,
    AuthService,
    CalendarEffects,
    CrmEffects,
    CrmPropertyCatalogService,
    EmailEffects,
    DaptaSyncEffects,
    // Drains the durable outbox (calendar write-out + CRM write-out + webhook
    // delivery + booking emails) with retry+backoff — no silent loss on a provider outage (B1/B7/DM1).
    OutboxWorker,
  ],
})
export class AppModule {}
