import { Module } from '@nestjs/common';
import { createDb } from '@slate/db';
import { createEmailProvider, BookingNotifier, type EmailProvider } from '@slate/notifications';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { DB, EMAIL, ENV, NOTIFIER } from './tokens';
import { BookingService } from './booking.service';
import {
  AvailabilityController,
  BookingsController,
  HealthController,
  ProfilesController,
} from './controllers';

@Module({
  controllers: [HealthController, ProfilesController, AvailabilityController, BookingsController],
  providers: [
    { provide: ENV, useFactory: () => loadServerEnv() },
    {
      provide: DB,
      useFactory: () => createDb(),
    },
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
    BookingService,
  ],
})
export class AppModule {}
