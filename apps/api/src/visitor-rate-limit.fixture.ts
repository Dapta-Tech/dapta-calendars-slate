import 'reflect-metadata';
import { Controller, Get, Module, Param, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { loadServerEnv } from '@slate/config/env';
import { RateLimitGuard, createRateLimiter } from './rate-limit';
import { ENV, RATE_LIMITER } from './tokens';

/**
 * A public API with the real rate-limit guard and limiter, for specs only: the
 * two calls a booking page view makes (profile, then availability), served on
 * an ephemeral local port. Shared by this app's 40-visitor spec and by the web
 * app's spec that drives its real API client against it.
 */
@Controller('v1')
@UseGuards(RateLimitGuard)
class PublicFixture {
  @Get('profiles/:accountCode/:handle')
  profile(@Param('handle') handle: string) {
    return { handle };
  }

  @Get('availability')
  availability() {
    return { slots: [] };
  }
}

export interface PublicApiFixture {
  base: string;
  guard: RateLimitGuard;
  close: () => Promise<void>;
}

export async function startPublicApi(apiEnv: Record<string, string>): Promise<PublicApiFixture> {
  const env = loadServerEnv(apiEnv);
  @Module({
    controllers: [PublicFixture],
    providers: [
      { provide: ENV, useValue: env },
      { provide: RATE_LIMITER, useValue: createRateLimiter(env) },
      RateLimitGuard,
    ],
  })
  class FixtureModule {}
  const app = await NestFactory.create<NestExpressApplication>(FixtureModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return {
    base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`,
    guard: app.get(RateLimitGuard),
    close: () => app.close(),
  };
}
