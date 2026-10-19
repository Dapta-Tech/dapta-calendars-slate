import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Inject, Optional } from '@nestjs/common';
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

/**
 * How many parameters the constructor declares. `Function.length` stops at the
 * first parameter with a default value, and several providers default their
 * optional ports, so count the top-level commas of the compiled signature.
 */
function constructorArity(cls: Ctor): number {
  const source = cls.toString();
  const start = source.indexOf('constructor(');
  if (start === -1) return cls.length;
  let depth = 0;
  let quote: string | null = null;
  let params = 0;
  let sawToken = false;
  for (let i = start + 'constructor('.length; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return sawToken ? params + 1 : 0;
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      params += 1;
      continue;
    }
    if (!/\s/.test(ch)) sawToken = true;
  }
  return cls.length;
}

function missingTokens(cls: Ctor): number[] {
  const declared: { index: number }[] = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) ?? [];
  const injected = new Set(declared.map((dep) => dep.index));
  return Array.from({ length: constructorArity(cls) }, (_, index) => index).filter((index) => !injected.has(index));
}

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
    expect(missingTokens(cls)).toEqual([]);
  });
});

describe('the guard itself', () => {
  it('counts parameters past a default value, even one holding commas and brackets', () => {
    class Defaults {
      constructor(_a: unknown, _b = new Map([[1, 'x,y']]), _c = { d: [1, 2] }, _e?: unknown) {}
    }
    expect(Defaults.length).toBe(1);
    expect(constructorArity(Defaults)).toBe(4);
  });

  it('flags a missing token that sits after a defaulted, injected parameter', () => {
    class Late {
      constructor(
        @Inject('A') readonly a: unknown,
        @Optional() @Inject('B') readonly b: string = 'open',
        readonly c?: unknown,
      ) {}
    }
    expect(missingTokens(Late)).toEqual([2]);
  });
});
