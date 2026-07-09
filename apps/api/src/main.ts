import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadServerEnv } from '@slate/config/env';
import { AppModule } from './app.module';

async function bootstrap() {
  const env = loadServerEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  // CORS: default open (clone-and-run / public embedding), but honor an explicit
  // allowlist in prod via CORS_ORIGINS="https://a.com,https://b.com" (E12).
  const origins = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins && origins.length > 0 ? origins : true });
  if (env.NODE_ENV === 'production' && !(origins && origins.length > 0)) {
    console.warn('[api] CORS_ORIGINS not set in production — reflecting any origin. Set an allowlist.');
  }
  await app.listen(env.API_PORT);
  console.log(`[api] listening on http://localhost:${env.API_PORT} (db=${env.DATABASE_URL})`);
}

bootstrap().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
