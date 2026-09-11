import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadServerEnv } from '@slate/config/env';
import { MAX_REQUEST_BODY } from '@slate/types';
import { json, type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module';

/**
 * The only routes that carry an inline `data:` image, and therefore the only
 * ones allowed a large JSON body.
 *
 * `PATCH /v1/booking-page` takes a host's avatar and cover; the team routes
 * take a logo. Everything else — including every UNAUTHED public booking
 * endpoint — keeps Express's 100kb default, because a body is read and parsed
 * by middleware BEFORE `RateLimitGuard` (a Nest guard) can refuse it, so a
 * global raise would hand every IP a far larger burst against the public
 * surface and the limiter could not mitigate it.
 */
const INLINE_IMAGE_ROUTES = [/^\/v1\/booking-page\/?$/, /^\/v1\/teams(\/[^/]+)?\/?$/];

/**
 * The residual, stated rather than hidden: body parsing runs before EVERY Nest
 * guard, auth included, so an unauthenticated caller can still push
 * `MAX_REQUEST_BODY` at those two routes, and neither carries a rate limiter
 * (`RateLimitGuard` is applied only to the public controller). That is two
 * paths at 3MB instead of 100kb.
 *
 * Gating the large parser on an identity header was tried and does not work
 * here: the local auth provider resolves a host from `DEV_LOGIN_EMAIL` when no
 * header is present, so a correctly authenticated request on a bare fork
 * carries no credential to test, and the gate refuses a legitimate save.
 */
const DEFAULT_BODY_LIMIT = '100kb';

async function bootstrap() {
  const env = loadServerEnv();
  // Own the body parsers outright: Nest's defaults are registered during
  // `init()`, i.e. AFTER `enableCors` below, and letting them stand would also
  // apply one limit everywhere.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });
  const large = json({ limit: MAX_REQUEST_BODY });
  const small = json({ limit: DEFAULT_BODY_LIMIT });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const parse = INLINE_IMAGE_ROUTES.some((re) => re.test(req.path)) ? large : small;
    return parse(req, res, next);
  });
  console.log(
    `[api] JSON body limit: ${DEFAULT_BODY_LIMIT} (${MAX_REQUEST_BODY} for inline-image routes)`,
  );
  // CORS (P1-4): NEVER reflect an arbitrary origin. Use the explicit allowlist
  // (CORS_ORIGINS="https://a.com,https://b.com") when set; otherwise default to
  // the app's OWN web origin (PUBLIC_APP_URL) so clone-and-run works
  // (web:3000 → api) without opening the authed surface to every site. Embed the
  // public widget on other domains by adding them to CORS_ORIGINS.
  const configured = env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  const origins = configured && configured.length > 0 ? configured : [env.PUBLIC_APP_URL];
  app.enableCors({ origin: origins, credentials: true });
  console.log(`[api] CORS allowlist: ${origins.join(', ')}`);
  await app.listen(env.API_PORT);
  console.log(`[api] listening on http://localhost:${env.API_PORT} (db=${env.DATABASE_URL.replace(/\/\/([^:@/]+):[^@]+@/, '//$1:***@')})`);
}

bootstrap().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
