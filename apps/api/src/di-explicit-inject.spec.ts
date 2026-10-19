import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';

/**
 * The API runs on tsx (esbuild), which never emits `design:paramtypes`, so Nest
 * resolves a constructor parameter ONLY from an explicit `@Inject(token)`. A
 * class that forgets one still boots, gets `undefined` for that dependency, and
 * fails at request time (CalV2Controller answered 401 to every valid key this
 * way). Hand-built unit tests cannot see it, so this guard walks the real module.
 */
type Ctor = abstract new (...args: never[]) => unknown;

function classesOf(key: string): Ctor[] {
  const entries: unknown[] = Reflect.getMetadata(key, AppModule) ?? [];
  return entries.filter((entry): entry is Ctor => typeof entry === 'function');
}

describe('explicit @Inject on every AppModule class', () => {
  const classes = [...classesOf(MODULE_METADATA.CONTROLLERS), ...classesOf(MODULE_METADATA.PROVIDERS)];

  it('finds the controllers and providers to check', () => {
    expect(classes.length).toBeGreaterThan(10);
  });

  it.each(classes.map((cls) => [cls.name, cls] as const))('%s injects each constructor parameter by token', (_name, cls) => {
    const declared: { index: number }[] = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? [];
    const injected = new Set(declared.map((dep) => dep.index));
    const missing = Array.from({ length: cls.length }, (_, index) => index).filter((index) => !injected.has(index));
    expect(missing).toEqual([]);
  });
});
