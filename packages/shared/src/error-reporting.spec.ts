import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_MESSAGE_MAX,
  SCRUB_RULES,
  createErrorReporter,
  describeError,
  errorFingerprint,
  exceptionEvent,
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
    expect(scrubErrorText('What went wrong? Nothing.')).toBe('What went wrong? Nothing.');
  });

  it('bearer and basic credentials', () => {
    expect(scrubErrorText('Authorization: Bearer abc.def')).toContain('[token]');
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
    const long = scrubErrorText('x'.repeat(ERROR_MESSAGE_MAX * 20));
    expect(long.length).toBe(ERROR_MESSAGE_MAX + 3);
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

  it('defaults run the drain on the next turn, off the caller', async () => {
    const deliver = vi.fn(async () => undefined);
    const reporter = createErrorReporter({ deliver });
    reporter.report(new Error('x'));
    expect(deliver).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(deliver).toHaveBeenCalledTimes(1);
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
    expect(reportableHost('127.0.0.1:4411')).toBe('127.0.0.1:4411');
    for (const internal of ['10.0.1.2', '172.20.0.5:3000', '192.168.1.10', 'calendars-api.lab.svc.cluster.local', 'calendars-api.lab.svc', 'db.internal', 'printer.local', 'calendars-api']) {
      expect([internal, reportableHost(internal)]).toEqual([internal, null]);
    }
    for (const junk of ['a b', 'host/path', 'user@host', '', undefined, 42]) expect(reportableHost(junk)).toBeNull();
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
