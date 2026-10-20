import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-stringify';
import { LEGACY_STRINGIFIERS } from './stable-stringify.fixture';

/**
 * The serializer behind every idempotency request hash. A stored hash is
 * compared against a fresh one on every retry (`api_idempotency.request_hash`,
 * and `_idempotency.requestHash` on a `/v2` booking, which never expires), so
 * its output is a stored format: it may not change for any value a caller can
 * pass. Every `expected` string below was produced by the copies this helper
 * replaced (`stable-stringify.fixture.ts`), and every `sha256` is the digest
 * those callers stored for that value. A row that fails here means retries of
 * requests made before the change would be refused as IDEMPOTENCY_KEY_REUSED.
 */
const GOLDEN: { name: string; input: unknown; expected: string; sha256?: string }[] = [
  {
    name: 'v2 create, optional fields left out (schema defaults filled)',
    input: { eventTypeId: '0b6f3c1e-8d2a-4f7b-9c3d-5e6f7a8b9c0d', start: '2026-11-02T15:00:00.000Z', attendee: { name: 'Ana Pérez', email: 'ana@example.com', timeZone: 'America/Bogota', language: 'en' }, guests: [], bookingFieldsResponses: {}, metadata: {} },
    expected: '{"attendee":{"email":"ana@example.com","language":"en","name":"Ana P\u00e9rez","timeZone":"America/Bogota"},"bookingFieldsResponses":{},"eventTypeId":"0b6f3c1e-8d2a-4f7b-9c3d-5e6f7a8b9c0d","guests":[],"metadata":{},"start":"2026-11-02T15:00:00.000Z"}',
    sha256: '2efd127b50f6f52dfb1e3201e4f9364883957ca9c504dea5854d475d8402182d',
  },
  {
    name: 'v2 create, every field the create path accepts',
    input: { eventTypeId: '42', organizationSlug: 'acme', start: '2026-11-02T10:00:00-05:00', attendee: { name: 'Ana Pérez', email: 'ana@example.com', timeZone: 'America/Bogota', phoneNumber: '+57 300 000 0000', language: 'es' }, guests: ['b@example.com', 'C@example.com'], bookingFieldsResponses: { company: 'Acme "Labs"', consent: true, topics: ['pricing', 'api'], Zeta: '' }, metadata: { flowRunId: 'run-1', Campaign: 'Q4' }, lengthInMinutes: 30, destinationCalendarId: 'cal_1', allowConflicts: false, allowBookingOutOfBounds: false, skipBookingLimits: false, instant: false },
    expected: '{"allowBookingOutOfBounds":false,"allowConflicts":false,"attendee":{"email":"ana@example.com","language":"es","name":"Ana P\u00e9rez","phoneNumber":"+57 300 000 0000","timeZone":"America/Bogota"},"bookingFieldsResponses":{"company":"Acme \\"Labs\\"","consent":true,"topics":["pricing","api"],"Zeta":""},"destinationCalendarId":"cal_1","eventTypeId":"42","guests":["b@example.com","C@example.com"],"instant":false,"lengthInMinutes":30,"metadata":{"Campaign":"Q4","flowRunId":"run-1"},"organizationSlug":"acme","skipBookingLimits":false,"start":"2026-11-02T10:00:00-05:00"}',
    sha256: '042133c723be6ce470d40c72443370980ca5dbb1223cb36b29b56b23bcd8ec15',
  },
  {
    name: 'v2 create, team slug selector',
    input: { eventTypeSlug: 'team-demo', teamSlug: 'sales', start: '2026-11-02T15:00:00Z', attendee: { name: 'Tess Team', email: 'tess@example.org', timeZone: 'UTC', language: 'en' }, guests: [], bookingFieldsResponses: { notes: 'línea 1\nlínea 2' }, metadata: {} },
    expected: '{"attendee":{"email":"tess@example.org","language":"en","name":"Tess Team","timeZone":"UTC"},"bookingFieldsResponses":{"notes":"l\u00ednea 1\\nl\u00ednea 2"},"eventTypeSlug":"team-demo","guests":[],"metadata":{},"start":"2026-11-02T15:00:00Z","teamSlug":"sales"}',
    sha256: 'fc9fa860b7925c771c062e50b9814bb52c3becc6d2f38f0be76c3871f920ddce',
  },
  {
    name: 'v2 cancel, empty body',
    input: {},
    expected: '{}',
    sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  },
  {
    name: 'v2 cancel, every field',
    input: { cancellationReason: 'Customer asked', cancelSubsequentBookings: false },
    expected: '{"cancellationReason":"Customer asked","cancelSubsequentBookings":false}',
    sha256: 'c390f018c8df7e007f317acfa228b9cf00f4dce13ffcd01a7c479fdb0ea76df9',
  },
  {
    name: 'v2 reschedule, start only',
    input: { start: '2026-11-03T15:30:00.000Z' },
    expected: '{"start":"2026-11-03T15:30:00.000Z"}',
    sha256: '71c815737e0a8f4f64f8e98494b70cbb75777f1a539193d69b7aa82bdea97c9f',
  },
  {
    name: 'v2 reschedule, every field',
    input: { start: '2026-11-03T10:30:00-05:00', rescheduledBy: 'host@example.com', reschedulingReason: 'Conflict' },
    expected: '{"rescheduledBy":"host@example.com","reschedulingReason":"Conflict","start":"2026-11-03T10:30:00-05:00"}',
    sha256: '5b912d491f48919ae8fd3f7209721ee9c9463afafc21ea97206e0946debedb20',
  },
  {
    name: 'v2 add guests',
    input: { guests: [{ email: 'new-guest@example.com', name: 'New Guest', timeZone: 'America/Bogota' }, { email: 'NEW-GUEST@example.com' }] },
    expected: '{"guests":[{"email":"new-guest@example.com","name":"New Guest","timeZone":"America/Bogota"},{"email":"NEW-GUEST@example.com"}]}',
    sha256: 'bc0dc84cf47bf24966c5e889a14fbada8a055e6677d7dfcad680ddd39be99b50',
  },
  {
    name: 'MCP book_meeting, personal page with answers',
    input: { page: { accountCode: 'acme', kind: 'personal', owner: 'alex-rivera', slug: 'intro-call' }, startUtc: '2026-11-02T15:00:00.000Z', language: 'es', attendee: { name: 'Pat Public', email: 'pat@example.org', timeZone: 'America/New_York' }, answers: { company: 'Initech', consent: false, topics: [] } },
    expected: '{"answers":{"company":"Initech","consent":false,"topics":[]},"attendee":{"email":"pat@example.org","name":"Pat Public","timeZone":"America/New_York"},"language":"es","page":{"accountCode":"acme","kind":"personal","owner":"alex-rivera","slug":"intro-call"},"startUtc":"2026-11-02T15:00:00.000Z"}',
    sha256: 'd19244d00b380c0baa3f80c5f9fc6298d37b155a049bcaf17a011f98599032f3',
  },
  {
    name: 'MCP book_meeting, team page, no answers',
    input: { page: { accountCode: 'acme', kind: 'team', owner: 'sales', slug: 'team-demo' }, startUtc: '2026-11-02T15:00:00.000Z', language: 'en', attendee: { name: 'Tess Team', email: 'tess@example.org', timeZone: 'UTC' }, answers: {} },
    expected: '{"answers":{},"attendee":{"email":"tess@example.org","name":"Tess Team","timeZone":"UTC"},"language":"en","page":{"accountCode":"acme","kind":"team","owner":"sales","slug":"team-demo"},"startUtc":"2026-11-02T15:00:00.000Z"}',
    sha256: 'fd3182953e2fe894ba520e9ecbc1cdc50a0262e3c7fa87390abf9f62bca7ce98',
  },
  {
    name: 'null at the top level',
    input: null,
    expected: 'null',
  },
  {
    name: 'null inside objects and arrays',
    input: { a: null, b: [null, { c: null }] },
    expected: '{"a":null,"b":[null,{"c":null}]}',
  },
  {
    name: 'empty and nested containers',
    input: [[], {}, [[]], [{}], { a: [], b: {} }],
    expected: '[[],{},[[]],[{}],{"a":[],"b":{}}]',
  },
  {
    name: 'key order is normalized at every depth',
    input: { b: 1, a: { d: 2, c: 3 } },
    expected: '{"a":{"c":3,"d":2},"b":1}',
  },
  {
    name: 'keys sort with localeCompare, not by code unit',
    input: { b: 1, B: 2, a: 3, A: 4, _x: 5, '10': 6, '9': 7, 'é': 8, e: 9, f: 10, 'z-a': 11, za: 12 },
    expected: '{"_x":5,"10":6,"9":7,"a":3,"A":4,"b":1,"B":2,"e":9,"\u00e9":8,"f":10,"z-a":11,"za":12}',
  },
  {
    name: 'strings that need escaping',
    input: { quote: 'say "hi"', backslash: 'a\\b', newline: 'a\nb', tab: '\t', control: '\u0001', separator: '\u2028', emoji: '\u{1F600}', accent: 'Ñandú' },
    expected: '{"accent":"\u00d1and\u00fa","backslash":"a\\\\b","control":"\\u0001","emoji":"\u{1F600}","newline":"a\\nb","quote":"say \\"hi\\"","separator":"\u2028","tab":"\\t"}',
  },
  {
    name: 'numbers',
    input: [0, -0, 1.5, -7, 1e21, 1e-7, 9007199254740991],
    expected: '[0,0,1.5,-7,1e+21,1e-7,9007199254740991]',
  },
  {
    name: 'booleans and strings',
    input: [true, false, '', 'x'],
    expected: '[true,false,"","x"]',
  },
  {
    name: 'a Date serializes as an empty object (no caller passes one)',
    input: { at: new Date(0) },
    expected: '{"at":{}}',
  },
  {
    name: 'an undefined array element (same in every copy)',
    input: [1, undefined, 2],
    expected: '[1,,2]',
  },
];

/**
 * Values only the MCP door hashes, with a property set to `undefined` (an
 * optional argument left out). The MCP copy left such a property out, and the
 * shared helper must keep doing so: the `/v2` copies would have written
 * `"holdId":undefined`, which is why the MCP variant is the one kept.
 */
const MCP_GOLDEN: { name: string; input: unknown; expected: string; sha256: string }[] = [
  {
    name: 'MCP book_meeting without a hold (holdId undefined)',
    input: { page: { accountCode: 'acme', kind: 'personal', owner: 'alex-rivera', slug: 'intro-call' }, startUtc: '2026-11-02T15:00:00.000Z', language: 'en', attendee: { name: 'Pat Public', email: 'pat@example.org', timeZone: 'America/New_York' }, answers: { company: 'Initech' }, holdId: undefined },
    expected: '{"answers":{"company":"Initech"},"attendee":{"email":"pat@example.org","name":"Pat Public","timeZone":"America/New_York"},"language":"en","page":{"accountCode":"acme","kind":"personal","owner":"alex-rivera","slug":"intro-call"},"startUtc":"2026-11-02T15:00:00.000Z"}',
    sha256: '9917a564981062b256e03eaaef2eea9ba81124548257afeae1bfd420b70c7ad8',
  },
  {
    name: 'MCP book_meeting with a hold',
    input: { page: { accountCode: 'acme', kind: 'personal', owner: 'alex-rivera', slug: 'intro-call' }, startUtc: '2026-11-02T15:00:00.000Z', language: 'en', attendee: { name: 'Pat Public', email: 'pat@example.org', timeZone: 'America/New_York' }, answers: { company: 'Initech' }, holdId: 'hold-7f3a' },
    expected: '{"answers":{"company":"Initech"},"attendee":{"email":"pat@example.org","name":"Pat Public","timeZone":"America/New_York"},"holdId":"hold-7f3a","language":"en","page":{"accountCode":"acme","kind":"personal","owner":"alex-rivera","slug":"intro-call"},"startUtc":"2026-11-02T15:00:00.000Z"}',
    sha256: '7f6f59289433755d07fa8901e177ac9b552d8a510eb4244309180c8120a2eb75',
  },
  {
    name: 'MCP confirm or decline without a reason (reason undefined)',
    input: { uid: 'b6d1c3a0-2f4e-4c1b-9a7d-3e5f6a7b8c9d', reason: undefined },
    expected: '{"uid":"b6d1c3a0-2f4e-4c1b-9a7d-3e5f6a7b8c9d"}',
    sha256: '8713e573af5a0e7de728ada75b308a01b66780dcb392be63dfd477f3fe1a8047',
  },
  {
    name: 'MCP hold_slot',
    input: { eventTypeId: '0b6f3c1e-8d2a-4f7b-9c3d-5e6f7a8b9c0d', startUtc: '2026-11-02T15:00:00.000Z' },
    expected: '{"eventTypeId":"0b6f3c1e-8d2a-4f7b-9c3d-5e6f7a8b9c0d","startUtc":"2026-11-02T15:00:00.000Z"}',
    sha256: '6c586c0378ae7ce00c1c8005f1ed2bc64cc0fc093183091a22eed4ed4c36f13a',
  },
];

/**
 * Keys a caller chooses (`metadata`, `bookingFieldsResponses`) are ordered by
 * `localeCompare`, which follows the runtime's default ICU locale. Every stored
 * hash was made under en-US (also what Node falls back to under `LANG=C`).
 * These keys sort differently under another locale or under code-unit order,
 * so a container or CI `LANG` change that would invalidate stored hashes fails
 * here (each name says where the order would differ).
 */
const LOCALE_GOLDEN: { name: string; input: unknown; expected: string; sha256?: string }[] = [
  {
    name: 'locale: ñ sorts with n (en-US), not after it (es)',
    input: { nz: 1, 'ño': 2, oa: 3 },
    expected: '{"\u00f1o":2,"nz":1,"oa":3}',
  },
  {
    name: 'locale: lower case first on a case tie (en-US), not upper first (da)',
    input: { A: 1, a: 2 },
    expected: '{"a":2,"A":1}',
  },
  {
    name: 'locale: case is ignored first (en-US), not upper before lower (code units)',
    input: { a: 1, B: 2 },
    expected: '{"a":1,"B":2}',
  },
  {
    name: 'locale: an accent is a secondary difference (en-US), not after z (code units)',
    input: { f: 1, 'é': 2 },
    expected: '{"\u00e9":2,"f":1}',
  },
  {
    name: 'locale: ä sorts with a (en-US), not after z (sv, da)',
    input: { z: 1, 'ä': 2, b: 3 },
    expected: '{"\u00e4":2,"b":3,"z":1}',
  },
  {
    name: 'v2 create with caller-chosen metadata and answer keys',
    input: { eventTypeId: '0b6f3c1e-8d2a-4f7b-9c3d-5e6f7a8b9c0d', start: '2026-11-02T15:00:00.000Z', attendee: { name: 'Ana Pérez', email: 'ana@example.com', timeZone: 'America/Bogota', language: 'es' }, guests: [], bookingFieldsResponses: { 'ñame': 'Ana', nz: 'Bogotá', empresa: 'Acme' }, metadata: { Zeta: '1', 'ä': '2', b: '3', 'é': '4', f: '5', A: '6', a: '7' } },
    expected: '{"attendee":{"email":"ana@example.com","language":"es","name":"Ana P\u00e9rez","timeZone":"America/Bogota"},"bookingFieldsResponses":{"empresa":"Acme","\u00f1ame":"Ana","nz":"Bogot\u00e1"},"eventTypeId":"0b6f3c1e-8d2a-4f7b-9c3d-5e6f7a8b9c0d","guests":[],"metadata":{"a":"7","A":"6","\u00e4":"2","b":"3","\u00e9":"4","f":"5","Zeta":"1"},"start":"2026-11-02T15:00:00.000Z"}',
    sha256: 'f95bc1ab18099ec36c358d087e4a876b4c29458eaba33f5e456f1cd3ca6d6408',
  },
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('stableStringify golden output', () => {
  it.each(GOLDEN)('$name', ({ input, expected, sha256: digest }) => {
    expect(stableStringify(input)).toBe(expected);
    for (const legacy of Object.values(LEGACY_STRINGIFIERS)) expect(legacy(input)).toBe(expected);
    if (digest) expect(sha256(stableStringify(input))).toBe(digest);
  });

  it.each(LOCALE_GOLDEN)('$name', ({ input, expected, sha256: digest }) => {
    expect(stableStringify(input)).toBe(expected);
    for (const legacy of Object.values(LEGACY_STRINGIFIERS)) expect(legacy(input)).toBe(expected);
    if (digest) expect(sha256(stableStringify(input))).toBe(digest);
  });

  it.each(MCP_GOLDEN)('$name', ({ input, expected, sha256: digest }) => {
    expect(stableStringify(input)).toBe(expected);
    expect(LEGACY_STRINGIFIERS['mcp/support.ts'](input)).toBe(expected);
    expect(sha256(stableStringify(input))).toBe(digest);
  });

  it('agrees byte for byte with every replaced copy on 2,000 random JSON request bodies', () => {
    const random = mulberry32(0x5eed);
    for (let i = 0; i < 2000; i++) {
      // A round trip through JSON is what a request body is by the time a
      // schema sees it.
      const body: unknown = JSON.parse(JSON.stringify(randomJson(random, 4)));
      const shared = stableStringify(body);
      for (const [file, legacy] of Object.entries(LEGACY_STRINGIFIERS))
        expect(legacy(body), `${file} on ${JSON.stringify(body)}`).toBe(shared);
    }
  });

  it('leaves out a property set to undefined, as the MCP copy did and the /v2 copies did not', () => {
    // The only input on which the replaced copies disagree. No `/v2` caller can
    // produce it: a JSON body has no `undefined`, and zod v3 leaves an absent
    // optional key out of its output. `stable-stringify.callers.spec.ts` drives
    // every caller and checks that no hashed value carries one.
    const input = { a: 1, b: undefined, c: { d: undefined } };
    expect(stableStringify(input)).toBe('{"a":1,"c":{}}');
    expect(stableStringify(input)).toBe(stableStringify({ a: 1, c: {} }));
    expect(LEGACY_STRINGIFIERS['mcp/support.ts'](input)).toBe('{"a":1,"c":{}}');
    expect(LEGACY_STRINGIFIERS['cal-v2.service.ts'](input)).toBe('{"a":1,"b":undefined,"c":{"d":undefined}}');
    expect(LEGACY_STRINGIFIERS['cal-v2-pilot.service.ts'](input)).toBe('{"a":1,"b":undefined,"c":{"d":undefined}}');
  });
});

/** A small seeded PRNG, so a failure names a body that reproduces. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['a', 'A', 'b', 'B', '_x', '10', '9', '', 'e', 'é', 'start', 'startUtc', 'timeZone', 'time_zone', 'z-a', 'za', 'cancellationReason', 'cancelSubsequentBookings'];
const STRINGS = ['', 'x', 'Ana Pérez', 'say "hi"', 'a\\b', 'line\nbreak', '\t', '\u0001', ' ', '\u{1F600}', '2026-11-02T15:00:00.000Z', 'ana@example.com'];
const NUMBERS = [0, 1, -7, 1.5, 30, 1e21, 1e-7, 9007199254740991];

function randomJson(random: () => number, depth: number): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const roll = random();
  if (depth > 0 && roll < 0.25) return Array.from({ length: Math.floor(random() * 4) }, () => randomJson(random, depth - 1));
  if (depth > 0 && roll < 0.55) {
    const object: Record<string, unknown> = {};
    for (let i = Math.floor(random() * 5); i > 0; i--) object[pick(KEYS)] = randomJson(random, depth - 1);
    return object;
  }
  if (roll < 0.7) return pick(STRINGS);
  if (roll < 0.85) return pick(NUMBERS);
  if (roll < 0.95) return random() < 0.5;
  return null;
}
