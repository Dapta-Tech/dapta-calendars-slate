import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_MESSAGE_MAX,
  SCRUB_RULES,
  createErrorReporter,
  describeError,
  errorFingerprint,
  exceptionEvent,
  REPORTABLE_MESSAGE,
  hostOfUrl,
  parseStackFrames,
  reportableHost,
  reportableRequestId,
  scrubErrorText,
  scrubFrameFilename,
  sendAnalyticsEvent,
  type ErrorReport,
  type ErrorReporterOptions,
} from './error-reporting';

/**
 * Error tracking's privacy filter and its server-side reporter. Every scrubber
 * rule has its own group; `every rule is needed` then removes each rule in
 * turn and proves its own sample leaks without it, so no rule can rot into a
 * no-op without a red test.
 */

/**
 * Credential-shaped fixtures are assembled at run time, so the secret
 * scanners of the publish gate never read one in this file's source.
 */
const fake = (...parts: string[]) => parts.join('');
const STRIPE_LIKE = fake('sk', '_live_', 'abcdef123456');
const CREDENTIAL_URL = fake('https://user', ':', 'hunter2', '@app.example.test/callback#state=abcxyzq');

/** One sample per rule: text that only that rule makes safe, and what must not survive. */
const RULE_SAMPLES: Record<string, { text: string; leaks: RegExp }> = {
  'query-params': {
    text: 'Failed query: insert into "booking" ("name", "email") values ($1, $2)\nparams: Ana Perez,ana@example.com',
    leaks: /Ana Perez/,
  },
  'quoted-input': {
    text: 'invalid input syntax for type uuid: "Ana Perez"',
    leaks: /Ana Perez/,
  },
  'url-query': {
    text: `fetch failed: ${CREDENTIAL_URL}`,
    leaks: /hunter2|abcxyzq/,
  },
  'path-query': {
    text: 'API /v1/availability?from=2026-10-23&tz=America/Bogota failed: 500',
    leaks: /America\/Bogota/,
  },
  bearer: { text: 'upstream refused Bearer abc.def.ghi-123', leaks: /abc\.def\.ghi/ },
  jwt: { text: 'bad session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJl', leaks: /eyJzdWIiOiJhbmEifQ/ },
  'prefixed-key': { text: `invalid key ${STRIPE_LIKE} or ${fake('dcl', '_Zx9yW8vU7t')}`, leaks: /_live_abcdef|_Zx9yW8/ },
  'named-secret': {
    text: 'config key=abcdefgh password: hunter2 body {"token": "opaque value"}',
    leaks: /abcdefgh|hunter2|opaque value/,
  },
  email: { text: 'no member ana.perez@example.com or bob%40example.org', leaks: /ana\.perez|bob%40/ },
  'phone-international': { text: 'call +57 300 123 4567 today', leaks: /\+\d/ },
  'phone-national': { text: 'call 300 123 4567 or (11) 98765-4321', leaks: /123 4567|98765-4321/ },
  'digit-run': { text: 'account 30012345678901 was refused', leaks: /30012345678901/ },
};

describe('scrubErrorText: one group per rule', () => {
  it('database params: everything after `params:` goes, whatever it spans', () => {
    const out = scrubErrorText('Failed query: select 1\nparams: Ana,\nline two, +57 300');
    expect(out).toBe('Failed query: select 1\nparams: [redacted]');
  });

  it('URLs keep scheme, host and path; credentials, query and fragment go', () => {
    expect(scrubErrorText('GET https://app.example.test/acme/ana/intro?prefill=x&utm_source=y failed')).toBe(
      'GET https://app.example.test/acme/ana/intro failed',
    );
    expect(scrubErrorText(`at ${fake('https://a', ':b', '@db.example.test/p#frag')}`)).toBe('at https://db.example.test/p');
    expect(scrubErrorText('see http://x.example.test/?')).toBe('see http://x.example.test/');
  });

  it('a path with a query loses the query', () => {
    expect(scrubErrorText('API /v1/bookings/abc?token=t0k3n failed: 500')).toBe('API /v1/bookings/abc failed: 500');
    expect(scrubErrorText('API /v1/search?&name=ana failed')).toBe('API /v1/search failed');
    expect(scrubErrorText('What went wrong? Nothing.')).toBe('What went wrong? Nothing.');
  });

  it('bearer and basic credentials', () => {
    expect(scrubErrorText('upstream said Bearer abc.def')).toBe('upstream said Bearer [token]');
    expect(scrubErrorText('Authorization: Bearer abc.def')).not.toContain('abc.def');
    expect(scrubErrorText('sent Basic dXNlcjpwYXNz')).toBe('sent Basic [token]');
  });

  it('a JWT anywhere', () => {
    expect(scrubErrorText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-part')).toBe('jwt [token]');
  });

  it('prefixed keys: payment, analytics, this app, webhooks, code hosts', () => {
    for (const [prefix, rest] of [
      ['sk', '_test_abc123def'],
      ['pk', '_live_abc123def'],
      ['phc', '_abcdef12'],
      ['phx', '_abcdef12'],
      ['dcl', '_abcdef12'],
      ['whsec', '_abcdef12'],
      ['ghp', '_abcdef12'],
      ['sk', '-abcdefghij12'],
    ]) {
      const key = fake(prefix!, rest!);
      expect([key, scrubErrorText(`key ${key} refused`)]).toEqual([key, 'key [token] refused']);
    }
  });

  it('a credential header quoted whole loses everything after it on the line', () => {
    expect(scrubErrorText('sent Authorization: Token abc123\nnext line')).toBe('sent Authorization: [redacted]\nnext line');
    expect(scrubErrorText('Cookie: sid=abc; theme=dark')).toBe('Cookie: [redacted]');
  });

  it('the shapes of common mail and cloud keys', () => {
    for (const key of [fake('re', '_abcdefghij123456'), fake('SG', '.abcdefghij12', '.klmnopqrst34'), fake('AIza', 'SyAbcdefghij1234567890'), fake('ya29', '.a0AbcdefGhij12')]) {
      expect([key, scrubErrorText(`key ${key} refused`)]).toEqual([key, 'key [token] refused']);
    }
  });

  it('a secret by its name, assigned or as a JSON key; a parse error keeps its "token"', () => {
    expect(scrubErrorText('url had api_key=abc&x=1')).toBe('url had api_key=[redacted]&x=1');
    expect(scrubErrorText('client_secret=s3cr3t, code=xyz')).toBe('client_secret=[redacted], code=[redacted]');
    expect(scrubErrorText('{"password":"two words","ok":1}')).toBe('{"password":"[redacted]","ok":1}');
    expect(scrubErrorText("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")).toBe(
      "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    );
    expect(scrubErrorText('Unexpected token: <')).toBe('Unexpected token: <');
  });

  it('email addresses, plain and URL-encoded, any script', () => {
    expect(scrubErrorText('duplicate key (email)=(ana@example.com)')).toBe('duplicate key (email)=([email])');
    expect(scrubErrorText('to josé.núñez@ejemplo.co')).toBe('to [email]');
    expect(scrubErrorText('to ana%40example.com')).toBe('to [email]');
  });

  it('international phone numbers, with or without separators', () => {
    expect(scrubErrorText('call +57 300 123 4567')).toBe('call [phone]');
    expect(scrubErrorText('call +1 (555) 123-4567.')).toBe('call [phone].');
    expect(scrubErrorText('sms to +573001234567 failed')).toBe('sms to [phone] failed');
  });

  it('national phone formats', () => {
    expect(scrubErrorText('call 300 123 4567')).toBe('call [phone]');
    expect(scrubErrorText('call (11) 98765-4321')).toBe('call [phone]');
    expect(scrubErrorText('call 555.123.4567')).toBe('call [phone]');
  });

  it('long digit runs', () => {
    expect(scrubErrorText('card 4111111111111111 declined')).toBe('card [number] declined');
    expect(scrubErrorText('epoch 1792777132944')).toBe('epoch [number]');
  });

  it("what a caller typed, quoted back by the database's invalid-input message", () => {
    expect(scrubErrorText('invalid input syntax for type uuid: "ana perez"')).toBe('invalid input syntax for type uuid: "[redacted]"');
    expect(scrubErrorText('invalid input value for enum role: "owner x"')).toBe('invalid input value for enum role: "[redacted]"');
  });

  it('dotted phones and ids are not mistaken for an IP address and kept', () => {
    expect(scrubErrorText('call 06.12.34.56.78')).toBe('call [phone]');
    expect(scrubErrorText('call 079.123.45.67')).toBe('call [phone]');
    expect(scrubErrorText('cedula 1.023.456.789')).toBe('cedula [phone]');
    expect(scrubErrorText('connect 192.168.100.200:5432 refused')).toBe('connect 192.168.100.200:5432 refused');
  });

  it('a grouped run past fifteen digits is a number, not left alone', () => {
    expect(scrubErrorText('card 4111 1111 1111 1111 declined')).toBe('card [number] declined');
    expect(scrubErrorText('call 300 123 4567 2024 11')).toBe('call [number]');
  });

  it('full-width, other-script digits, no-break spaces, en dashes and a doubly encoded @ are read as what they are', () => {
    expect(scrubErrorText('to ana\uFF20example.com')).toBe('to [email]');
    expect(scrubErrorText('to ana%2540example.com')).toBe('to [email]');
    expect(scrubErrorText('call \uFF13\uFF10\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17')).toBe('call [number]');
    expect(scrubErrorText('call \u0663\u0660\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667')).toBe('call [number]');
    expect(scrubErrorText('call 300\u00a0123\u00a04567')).toBe('call [phone]');
    expect(scrubErrorText('call 300\u2013123\u20134567')).toBe('call [phone]');
  });

  it('every rule is needed: without it, its own sample leaks', () => {
    expect(Object.keys(RULE_SAMPLES).sort()).toEqual(SCRUB_RULES.map((r) => r.name).sort());
    for (const rule of SCRUB_RULES) {
      const sample = RULE_SAMPLES[rule.name]!;
      const without = SCRUB_RULES.filter((r) => r !== rule);
      expect([rule.name, sample.leaks.test(scrubErrorText(sample.text))]).toEqual([rule.name, false]);
      expect([rule.name, sample.leaks.test(scrubErrorText(sample.text, without))]).toEqual([rule.name, true]);
    }
  });
});

describe('scrubErrorText: what it leaves alone', () => {
  it('keeps what an error needs to be read and grouped', () => {
    for (const text of [
      'connect ECONNREFUSED 10.1.2.3:5432',
      'booking 0198a1b2-c3d4-7e89-a1b2-c3d4e5f60718 not found',
      'slot 2026-10-23T17:00:00.000Z is taken',
      'Next 16.4.2 on Node 22.13.0',
      'API /v1/event-types failed: 500',
      "Cannot read properties of undefined (reading 'map')",
      'Body exceeded 3mb limit',
      'between 10 and 20 hosts',
    ]) {
      expect(scrubErrorText(text)).toBe(text);
    }
  });

  it('is empty for anything but a string, and caps a long message', () => {
    expect(scrubErrorText(undefined)).toBe('');
    expect(scrubErrorText({ email: 'ana@example.com' })).toBe('');
    const long = scrubErrorText(`${'word '.repeat(ERROR_MESSAGE_MAX)}`);
    expect(long.length).toBe(ERROR_MESSAGE_MAX + 3);
  });

  it('never keeps half of an address cut at the reading edge, even when scrubbing shortens what is before it', () => {
    // A long query before the address is removed, pulling the address's
    // first half from past the edge into what is sent.
    const before = `https://x.example.test/p?${'q'.repeat(ERROR_MESSAGE_MAX * 2 - 40)} `;
    const text = `${before}ana.perez@example.com and more`;
    expect(scrubErrorText(text)).not.toMatch(/ana|perez/);
  });

  it('a long message with no spaces (minified JSON) keeps what precedes the reading edge', () => {
    const json = `{"error":"upstream","items":[${'{"id":1},'.repeat(400)}]}`;
    const out = scrubErrorText(json);
    expect(out.startsWith('{"error":"upstream","items":[')).toBe(true);
    expect(out.length).toBe(ERROR_MESSAGE_MAX + 3);
  });

  it('costs linear time on long runs of address-like characters', () => {
    for (const text of ['a.'.repeat(5000), '1-'.repeat(5000), 'http://' + 'a'.repeat(9990), 'a%40'.repeat(2500)]) {
      const started = performance.now();
      scrubErrorText(text);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe('scrubFrameFilename', () => {
  it('drops a query and fragment, the file scheme, and the working directory', () => {
    expect(scrubFrameFilename('https://cal.example.test/_next/static/chunks/a.js?dpl=abc#x')).toBe(
      'https://cal.example.test/_next/static/chunks/a.js',
    );
    expect(scrubFrameFilename('file:///srv/app/src/main.ts', '/srv/app')).toBe('src/main.ts');
    expect(scrubFrameFilename('/srv/app/src/a.ts', '/srv/app/')).toBe('src/a.ts');
    expect(scrubFrameFilename('/elsewhere/a.ts', '/srv/app')).toBe('/elsewhere/a.ts');
    expect(scrubFrameFilename(undefined)).toBeUndefined();
  });
});

const STACK = [
  'Error: boom for ana@example.com',
  '    at BookingService.create (/srv/app/src/booking.service.ts:120:11)',
  '    at async HostController.book (/srv/app/src/host.controller.ts:40:5)',
  '    at /srv/app/node_modules/@nestjs/core/router/router-execution-context.js:46:28',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
  '    at file:///srv/app/src/main.ts:10:3',
].join('\n');

describe('parseStackFrames', () => {
  it('reads V8 frames oldest first, relative to the root, dependencies and the runtime not in app', () => {
    expect(parseStackFrames(STACK, '/srv/app')).toEqual([
      { filename: 'src/main.ts', lineno: 10, colno: 3, in_app: true },
      { filename: 'node:internal/process/task_queues', function: 'process.processTicksAndRejections', lineno: 105, colno: 5, in_app: false },
      { filename: 'node_modules/@nestjs/core/router/router-execution-context.js', lineno: 46, colno: 28, in_app: false },
      { filename: 'src/host.controller.ts', function: 'HostController.book', lineno: 40, colno: 5, in_app: true },
      { filename: 'src/booking.service.ts', function: 'BookingService.create', lineno: 120, colno: 11, in_app: true },
    ]);
  });

  it("names this repo's own packages as app code, however a deployed bundle installs them", () => {
    const stack = [
      'Error: x',
      '    at createDb (/app/node_modules/.pnpm/@slate+db@file+packages+db_x@1/node_modules/@slate/db/src/client.ts:12:3)',
      '    at load (/app/node_modules/@slate/shared/src/time.ts:4:1)',
      '    at Router.handle (/app/node_modules/.pnpm/express@4.22.3/node_modules/express/lib/router/index.js:1:1)',
    ].join('\n');
    expect(parseStackFrames(stack, '/app').map((f) => [f.filename, f.in_app])).toEqual([
      ['node_modules/.pnpm/express@4.22.3/node_modules/express/lib/router/index.js', false],
      ['@slate/shared/src/time.ts', true],
      ['@slate/db/src/client.ts', true],
    ]);
  });

  it('is empty for anything that is not a stack', () => {
    expect(parseStackFrames(undefined)).toEqual([]);
    expect(parseStackFrames('just a message')).toEqual([]);
  });

  it('reads a path holding " (", a Windows path and a frame with no function the way V8 writes them', () => {
    const stack = [
      'Error: x',
      '    at Object.run (/srv/app/my (copy)/a.ts:3:4)',
      '    at C:\\srv\\app\\b.ts:5:6',
      '    at async Promise.all (index 0)',
      '    at Array.map (<anonymous>)',
    ].join('\n');
    expect(parseStackFrames(stack, '/srv/app')).toEqual([
      expect.objectContaining({ lineno: 5, colno: 6 }),
      expect.objectContaining({ function: 'Object.run', filename: 'my (copy)/a.ts', lineno: 3, colno: 4 }),
    ]);
  });

  it('takes time linear in a crafted stack, never a backtracking blow-up', () => {
    const crafted = [
      `at ${' (a'.repeat(50_000)}`,
      `    at x (${'/node_modules/@slate/'.repeat(20_000)}`,
      `    at f (${'a:1'.repeat(30_000)})`,
    ].join('\n');
    // Under the 2000-character cap too, so the scan itself is what is timed.
    const underCap = Array.from({ length: 15_000 }, () => `    at ${' (a'.repeat(600)}`).join('\n');
    const started = performance.now();
    expect(parseStackFrames(crafted.repeat(20))).toEqual([]);
    expect(parseStackFrames(underCap)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('reads an unnamed async callback and an unnamed frame whose path holds " (", relative to the root', () => {
    const stack = ['Error: x', '    at async /srv/app/dist/x.js:3:51', '    at /srv/app/my (copy)/a.ts:3:4'].join('\n');
    expect(parseStackFrames(stack, '/srv/app')).toEqual([
      { filename: 'my (copy)/a.ts', lineno: 3, colno: 4, in_app: true },
      { filename: 'dist/x.js', lineno: 3, colno: 51, in_app: true },
    ]);
  });

  it('keeps the newest 50 frames and stops reading there', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `    at f${i} (/srv/app/a.ts:${i + 1}:1)`);
    const frames = parseStackFrames(['Error: x', ...lines].join('\n'), '/srv/app');
    expect(frames).toHaveLength(50);
    expect(frames.at(-1)).toMatchObject({ function: 'f0', lineno: 1 });
    expect(frames[0]).toMatchObject({ function: 'f49', lineno: 50 });
  });
});

describe('describeError', () => {
  it('scrubs the message and follows the cause chain, outermost first', () => {
    const root = new TypeError('socket hang up at +57 300 123 4567');
    const outer = new Error('booking for ana@example.com failed', { cause: root });
    const [first, second] = describeError(outer);
    expect(first).toMatchObject({ type: 'Error', value: 'booking for [email] failed' });
    expect(second).toMatchObject({ type: 'TypeError', value: 'socket hang up at [phone]' });
    expect(first!.frames.at(-1)?.in_app).toBe(true);
  });

  it('sends what an error says may be reported, never its raw message', () => {
    const upstream = Object.assign(new Error('calendar backend listCalendars failed (502): {"summary":"Jane Smith personal"}'), {
      [REPORTABLE_MESSAGE]: 'calendar backend listCalendars failed (502)',
    });
    expect(describeError(upstream)[0]!.value).toBe('calendar backend listCalendars failed (502)');
    expect(JSON.stringify(describeError(upstream))).not.toContain('Jane');
  });

  it('never reads a line of the message as a stack frame, and scrubs function names', () => {
    const e = new Error('boom\n    at secret (ana@example.com:1:1)');
    expect(JSON.stringify(describeError(e)[0]!.frames)).not.toContain('ana@');
    const named = new Error('x');
    named.stack = 'Error: x\n    at Object.ana@example.com (/srv/app/a.ts:1:1)';
    expect(describeError(named, '/srv/app')[0]!.frames[0]).toMatchObject({ function: '[email]', filename: 'a.ts' });
  });

  it('a cause that throws when read ends the chain, never the report', () => {
    const e = new Error('outer');
    Object.defineProperty(e, 'cause', {
      get() {
        throw new Error('trap');
      },
    });
    expect(describeError(e).map((x) => x.value)).toEqual(['outer']);
  });

  it('names a thrown non-Error without serializing it', () => {
    expect(describeError('plain ana@example.com')).toEqual([{ type: 'string', value: 'plain [email]', frames: [] }]);
    expect(describeError({ email: 'ana@example.com', name: 'Ana' })).toEqual([
      { type: 'Object', value: 'Non-Error value thrown', frames: [] },
    ]);
    expect(describeError(null)).toEqual([{ type: 'null', value: 'null', frames: [] }]);
  });

  it('stops at a cycle and at three causes', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeError(b).map((e) => e.value)).toEqual(['b', 'a']);
    let deep: Error = new Error('0');
    for (let i = 1; i < 10; i++) deep = new Error(String(i), { cause: deep });
    expect(describeError(deep)).toHaveLength(4);
  });

  it('never throws, whatever it is handed', () => {
    const hostile = new Proxy(new Error('x'), {
      get(target, key) {
        if (key === 'message' || key === 'stack') throw new Error('trap');
        return Reflect.get(target, key);
      },
    });
    expect(() => describeError(hostile)).not.toThrow();
  });
});

/** A reporter on a hand-driven clock and scheduler. */
function harness(over: Partial<ErrorReporterOptions> = {}) {
  let t = 1_000_000;
  const queued: Array<() => void> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: ErrorReport[] = [];
  const drops: string[] = [];
  let n = 0;
  const reporter = createErrorReporter({
    deliver: async (r) => void sent.push(r),
    now: () => t,
    schedule: (fn) => void queued.push(fn),
    setTimer: (fn, ms) => void timers.push({ at: t + ms, fn }),
    uuid: () => `u${++n}`,
    onDrop: (reason) => void drops.push(reason),
    ...over,
  });
  return {
    reporter,
    sent,
    drops,
    run: () => queued.splice(0).forEach((fn) => fn()),
    advance(ms: number) {
      t += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= t) timer.fn();
        else timers.push(timer);
      }
    },
  };
}

/** The same error, raised from the same line every time. */
function sameError(message = 'db down'): Error {
  const e = new Error(message);
  e.stack = `Error: ${message}\n    at Repo.save (/srv/app/src/repo.ts:10:5)`;
  return e;
}

describe('createErrorReporter', () => {
  it('queues and returns at once; building and sending happen off the caller path', async () => {
    const h = harness({ properties: { surface: 'api' } });
    h.reporter.report(sameError(), { properties: { route: '/v1/x', status: 500 }, mechanism: 'filter' });
    expect(h.sent).toHaveLength(0);
    h.run();
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      uuid: 'u1',
      handled: false,
      mechanism: 'filter',
      count: 1,
      properties: { surface: 'api', route: '/v1/x', status: 500 },
    });
  });

  it('holds at most maxQueue reports; the rest are dropped and counted', () => {
    const h = harness({ maxQueue: 3 });
    for (let i = 0; i < 5; i++) h.reporter.report(sameError(`e${i}`));
    expect(h.drops).toEqual(['queue_full', 'queue_full']);
    h.run();
    expect(h.sent.map((r) => r.exceptions[0]!.value)).toEqual(['e0', 'e1', 'e2']);
    expect(h.reporter.stats.dropped).toBe(2);
  });

  it('sends at most maxPerMinute a rolling minute', () => {
    const h = harness({ maxPerMinute: 60 });
    for (let i = 0; i < 61; i++) h.reporter.report(sameError(`distinct ${String.fromCharCode(97 + (i % 26))}${i}`));
    h.run();
    expect(h.sent).toHaveLength(60);
    expect(h.drops).toEqual(['rate_limited']);
    h.advance(60_000);
    h.reporter.report(sameError('after the minute'));
    h.run();
    expect(h.sent).toHaveLength(61);
  });

  it('the same error within the window is sent once, then once more with how many followed', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.reporter.report(sameError());
    h.run();
    expect(h.sent.map((r) => r.count)).toEqual([1]);
    expect(h.reporter.stats.folded).toBe(4);
    h.advance(60_000);
    expect(h.sent.map((r) => r.count)).toEqual([1, 4]);
    expect(h.sent[1]!.uuid).not.toBe(h.sent[0]!.uuid);
    // A new window opens with the next occurrence, sent at once.
    h.reporter.report(sameError());
    h.run();
    expect(h.sent.map((r) => r.count)).toEqual([1, 4, 1]);
  });

  it('counts emails apart as the same error, and a different line or type as another', () => {
    const h = harness();
    h.reporter.report(sameError('no member ana@example.com'));
    h.reporter.report(sameError('no member bob@example.com'));
    const other = new Error('db down');
    other.stack = 'Error: db down\n    at Repo.load (/srv/app/src/repo.ts:20:5)';
    h.reporter.report(other);
    h.reporter.report(new TypeError('db down'));
    h.run();
    expect(h.sent.map((r) => `${r.exceptions[0]!.type}:${r.exceptions[0]!.value}`)).toEqual([
      'Error:no member [email]',
      'Error:db down',
      'TypeError:db down',
    ]);
    expect(errorFingerprint(h.sent[0]!.exceptions)).toBe('Error|no member [email]|src/repo.ts:Repo.save:10'.replace('src/', '/srv/app/src/'));
  });

  it('flush sends what is queued and every pending repeat, and never waits past its timeout', async () => {
    const h = harness();
    h.reporter.report(sameError());
    h.reporter.report(sameError());
    await h.reporter.flush(50);
    expect(h.sent.map((r) => r.count)).toEqual([1, 1]);

    const hung = createErrorReporter({ deliver: () => new Promise<void>(() => undefined), schedule: () => undefined });
    hung.report(new Error('x'));
    const started = Date.now();
    await hung.flush(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a failing provider is swallowed, never thrown into the caller', async () => {
    const rejecting = createErrorReporter({ deliver: () => Promise.reject(new Error('down')), schedule: (fn) => fn() });
    expect(() => rejecting.report(new Error('x'))).not.toThrow();
    const throwing = createErrorReporter({
      deliver: () => {
        throw new Error('sync');
      },
      schedule: (fn) => fn(),
    });
    expect(() => throwing.report(new Error('x'))).not.toThrow();
    await expect(throwing.flush(10)).resolves.toBeUndefined();
  });

  it('says when a delivery fails, so a refused key is not silent forever', async () => {
    const failures: unknown[] = [];
    const reporter = createErrorReporter({
      deliver: () => Promise.reject(new Error('refused: HTTP 401')),
      schedule: (fn) => fn(),
      onFailure: (e) => void failures.push(e),
    });
    reporter.report(new Error('x'));
    await reporter.flush(50);
    expect(String(failures[0])).toContain('401');
  });

  it("reads a runtime's better stack only for reports it sends, never for the repeats it counts", async () => {
    const stackOf = vi.fn((e: Error) => e.stack);
    const h = harness({ stackOf });
    for (let i = 0; i < 5; i++) h.reporter.report(sameError());
    h.run();
    expect(h.sent).toHaveLength(1);
    expect(stackOf).toHaveBeenCalledTimes(1);
  });

  it('defaults run the drain on the next turn, off the caller', async () => {
    const deliver = vi.fn(async () => undefined);
    const reporter = createErrorReporter({ deliver });
    reporter.report(new Error('x'));
    expect(deliver).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('a fresh id with no randomUUID', () => {
  it('comes from getRandomValues as a v4 UUID, and never from Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    try {
      const id = reportableRequestId(undefined);
      expect(id).toMatch(/^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(reportableRequestId(undefined)).not.toBe(id);
      vi.stubGlobal('crypto', undefined);
      const v4 = /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      const first = reportableRequestId(undefined);
      expect(first).toMatch(v4);
      expect(reportableRequestId(undefined)).not.toBe(first);
      expect(random).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      random.mockRestore();
    }
  });
});

describe('reportableRequestId', () => {
  it('echoes a short, boring id and mints one for anything else', () => {
    expect(reportableRequestId('req_abc-123')).toBe('req_abc-123');
    expect(reportableRequestId(['first', 'second'])).toBe('first');
    expect(reportableRequestId('ana@example.com', () => 'n')).toBe('req_n');
    expect(reportableRequestId('x'.repeat(101), () => 'n')).toBe('req_n');
    expect(reportableRequestId(undefined, () => 'n')).toBe('req_n');
  });
});

describe('reportableHost and hostOfUrl', () => {
  it('keeps a public host name (and local development), never an address internal to the deployment', () => {
    expect(reportableHost('App.Example.Test')).toBe('app.example.test');
    expect(reportableHost(['localhost:3411'])).toBe('localhost:3411');
    for (const outside of ['203.0.113.7', '100.63.0.1', '100.128.0.1', '172.32.0.1']) expect(reportableHost(outside)).toBe(outside);
    for (const internal of ['10.0.1.2', '172.20.0.5:3000', '192.168.1.10', '127.0.0.1:3000', '100.64.0.9', '100.127.255.1', 'calendars-api.ns.svc.cluster.local', 'calendars-api.ns.svc', 'db.internal', 'printer.local', 'calendars-api']) {
      expect([internal, reportableHost(internal)]).toEqual([internal, null]);
    }
    for (const junk of ['a b', 'host/path', 'user@host', '', undefined, 42]) expect(reportableHost(junk)).toBeNull();
    // A fully qualified name's trailing dot changes nothing.
    expect(reportableHost('calendars-api.ns.svc.cluster.local.')).toBeNull();
    expect(reportableHost('db.internal.:5432')).toBeNull();
    expect(reportableHost('app.example.test.')).toBe('app.example.test');
  });

  it('reads the host of a configured public URL', () => {
    expect(hostOfUrl('https://api.example.test/v1')).toBe('api.example.test');
    expect(hostOfUrl('http://localhost:3000')).toBe('localhost:3000');
    expect(hostOfUrl('not a url')).toBeNull();
    expect(hostOfUrl(undefined)).toBeNull();
  });
});

describe('exceptionEvent and sendAnalyticsEvent', () => {
  const report: ErrorReport = {
    uuid: '0198a1b2-0000-7000-8000-000000000001',
    timestamp: Date.UTC(2026, 9, 23, 17, 0, 0),
    exceptions: [
      { type: 'Error', value: 'outer', frames: [{ filename: 'src/a.ts', function: 'f', lineno: 1, colno: 2, in_app: true }] },
      { type: 'TypeError', value: 'inner', frames: [] },
    ],
    handled: false,
    mechanism: 'filter',
    count: 3,
    properties: { surface: 'api', route: '/v1/x', status: 500 },
  };

  it('is an $exception event with no person, its causes linked, frames tagged with the platform', () => {
    expect(exceptionEvent(report, { distinctId: 'calendars-api' })).toEqual({
      event: '$exception',
      distinct_id: 'calendars-api',
      uuid: report.uuid,
      timestamp: '2026-10-23T17:00:00.000Z',
      properties: {
        product: 'calendars',
        surface: 'api',
        route: '/v1/x',
        status: 500,
        count: 3,
        $exception_level: 'error',
        $exception_list: [
          {
            type: 'Error',
            value: 'outer',
            mechanism: { type: 'filter', handled: false, synthetic: false, exception_id: 0 },
            stacktrace: {
              type: 'raw',
              frames: [{ platform: 'node:javascript', filename: 'src/a.ts', function: 'f', lineno: 1, colno: 2, in_app: true }],
            },
          },
          {
            type: 'TypeError',
            value: 'inner',
            mechanism: { type: 'filter', handled: false, synthetic: false, exception_id: 1, parent_id: 0 },
            stacktrace: { type: 'raw', frames: [] },
          },
        ],
        $process_person_profile: false,
      },
    });
  });

  it('always says it is this product, whatever a caller passed', () => {
    const forged = { ...report, properties: { ...report.properties, product: 'other' } };
    expect((exceptionEvent(forged, { distinctId: 'x' })['properties'] as Record<string, unknown>)['product']).toBe('calendars');
  });

  it('posts to the capture endpoint with the key in the body, a timeout and no redirects', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const config = { provider: 'posthog' as const, key: 'phc_test', host: 'https://ingest.example.test', errors: true };
    await expect(sendAnalyticsEvent(config, { event: '$exception' }, fetchImpl)).resolves.toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string; redirect: string; signal: unknown }];
    expect(url).toBe('https://ingest.example.test/capture/');
    expect(JSON.parse(init.body)).toEqual({ api_key: 'phc_test', event: '$exception' });
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
});
