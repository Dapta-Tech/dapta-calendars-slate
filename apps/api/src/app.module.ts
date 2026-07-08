import { Module } from '@nestjs/common';
import { createDb } from '@slate/db';
import { createEmailProvider, BookingNotifier, type EmailProvider } from '@slate/notifications';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { AUTH_PROVIDER, CALENDAR, DB, EMAIL, ENV, NOTIFIER } from './tokens';
import { BookingService } from './booking.service';
import { AdminService } from './admin.service';
import { AuthService } from './auth.service';
import { createAuthProvider } from './auth.provider';
import type { Db } from '@slate/db';
import { HealthController } from './controllers';
import { PublicController } from './public.controller';
import { HostController } from './host.controller';
import { MachineController } from './machine.controller';
import { AdminCrudController } from './admin-crud.controller';

@Module({
  controllers: [
    HealthController,
    PublicController,
    HostController,
    MachineController,
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
          http: { endpoint: env.EMAIL_HTTP_ENDPOINT, token: env.EMAIL_HTTP_TOKEN },
        }),
      inject: [ENV],
    },
    {
      provide: NOTIFIER,
      useFactory: (email: EmailProvider) => new BookingNotifier(email),
      inject: [EMAIL],
    },
    // The OSS default CalendarProvider is disabled (no external calendar). A
    // private overlay swaps this for a concrete adapter.
    { provide: CALENDAR, useFactory: () => new DisabledCalendarProvider() },
    // Host auth backend selected by AUTH_PROVIDER (local stub / WorkOS overlay).
    {
      provide: AUTH_PROVIDER,
      useFactory: (env: ServerEnv, db: Db) => createAuthProvider(env, db),
      inject: [ENV, DB],
    },
    BookingService,
    AdminService,
    AuthService,
  ],
})
export class AppModule {}
