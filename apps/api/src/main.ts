import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadServerEnv } from '@slate/config/env';
import { AppModule } from './app.module';

async function bootstrap() {
  const env = loadServerEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  // Public booking pages call this API from the web app / any origin.
  app.enableCors({ origin: true });
  await app.listen(env.API_PORT);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${env.API_PORT} (db=${env.DATABASE_URL})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] failed to start:', err);
  process.exit(1);
});
