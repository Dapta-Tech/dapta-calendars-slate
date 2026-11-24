import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';
import { startFakeAs, type FakeAs } from '../oauth/fake-as';
import { bootOAuth, callTool, connect, publicClient } from '../oauth/oauth-harness';

/**
 * `update_event_type` and `create_event_type` (GEN-1943): an agent edits the
 * safe part of an event type, under its own scope, behind a kill switch. What
 * it may touch is an allowlist; everything else is refused, never dropped.
 */

const RESOURCE = 'https://calendar.example.test/mcp';
const READ = ['event-types:read', 'availability:read', 'bookings:read', 'bookings:write'];
const WRITE = [...READ, 'event-types:write'];

type EventType = { id: string; title: string; slug: string; hidden: boolean; member_id: string | null; revision: string; questions: { name: string; label: string; type: string; required: boolean; options?: string[] }[] };

let as: FakeAs;
let h: Harness;
let off: Harness;
let introId: string;
let teamId: string;
let n = 0;
const key = () => idem(`et-write-${(n += 1).toString().padStart(4, '0')}`);

const boot = (enabled: boolean) =>
  bootHarness({
    OAUTH_ENABLED: 'true',
    OAUTH_AUTHORIZATION_SERVER: as.issuer,
    MCP_PUBLIC_URL: RESOURCE,
    MCP_EVENT_TYPE_WRITE_ENABLED: String(enabled),
    MCP_RATE_LIMIT_CAPACITY: '500',
    MCP_WRITE_RATE_LIMIT_CAPACITY: '500',
  });

async function call(token: string, name: string, args: Record<string, unknown>, on: Harness = h) {
  return (await on.connect(token)).callTool({ name, arguments: args });
}
async function read(token: string, id = introId): Promise<EventType> {
  return structured<{ event_type: EventType }>(await call(token, 'get_event_type', { event_type_id: id })).event_type;
}
const row = (id = introId) =>
  h.db.get<{ title: string; slug: string; booking_fields: unknown; description: string | null }>(
    sql`SELECT title, slug, booking_fields, description FROM event_type WHERE id = ${id}`,
  );

beforeAll(async () => {
  as = await startFakeAs({ audience: RESOURCE });
  // One at a time: a harness reads process.env while it boots.
  h = await boot(true);
  off = await boot(false);
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
  teamId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'team-demo'`))!.id;
});
afterAll(async () => {
  await Promise.all([h.close(), off.close()]);
  await as.close();
});

describe('update_event_type and create_event_type', () => {
  it('need event-types:write: a key without it is refused, a built-in OAuth connection is stepped up', async () => {
    const reader = await h.key(READ);
    expect(errorText(await call(reader, 'update_event_type', { event_type_id: introId, title: 'X', idempotency_key: key() }))).toMatch(/^INSUFFICIENT_SCOPE/);
    expect(errorText(await call(reader, 'create_event_type', { title: 'X', length_minutes: 30, idempotency_key: key() }))).toMatch(/^INSUFFICIENT_SCOPE/);

    const o = await bootOAuth({ MCP_EVENT_TYPE_WRITE_ENABLED: 'true' });
    try {
      const token = (await connect(o, await publicClient(o))).access_token;
      const res = await callTool(o, 'update_event_type', { event_type_id: introId, title: 'X', idempotency_key: key() }, token);
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      expect(res.headers.get('www-authenticate')).toContain('event-types:write');
    } finally {
      await o.close();
    }
  });

  it('an external sign-in holds the scope through its admin role, and can edit only while the switch is on', async () => {
    for (const on of [h, off]) {
      await on.db.run(sql`UPDATE member SET idp_subject = 'user_alex_et', login_seen_at = ${Date.now()} WHERE handle = 'alex-rivera'`);
    }
    const token = await as.mint({ sub: 'user_alex_et' });
    const who = structured<{ key: { scopes: string[] } }>(await call(token, 'whoami', {}));
    expect(who.key.scopes).toContain('event-types:write');
    const done = structured<{ event_type: EventType }>(await call(token, 'update_event_type', { event_type_id: introId, title: 'Intro Call', idempotency_key: key() }));
    expect(done.event_type.title).toBe('Intro Call');

    const offIntro = (await off.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
    const names = (await (await off.connect(token)).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('update_event_type');
    await expect(call(token, 'update_event_type', { event_type_id: offIntro, title: 'Nope', idempotency_key: key() }, off)).rejects.toThrow(/not found/);
    expect((await off.db.get<{ title: string }>(sql`SELECT title FROM event_type WHERE id = ${offIntro}`))!.title).toBe('Intro Call');
  });

  it('with the switch off, neither tool is listed for a key that holds the scope', async () => {
    const names = (await (await off.connect(await off.key(WRITE))).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('update_event_type');
    expect(names).not.toContain('create_event_type');
    const on = (await (await h.connect(await h.key(WRITE))).listTools()).tools.map((t) => t.name);
    expect(on).toEqual(expect.arrayContaining(['update_event_type', 'create_event_type']));
  });

  it('answers NOT_FOUND for another account or outside the allowlist, and an allowlisted key may not create', async () => {
    const writer = await h.key(WRITE);
    expect(errorText(await call(writer, 'update_event_type', { event_type_id: h.other.eventTypeId, title: 'Taken', idempotency_key: key() }))).toMatch(/^NOT_FOUND/);
    const limited = await h.key(WRITE, { eventTypeIds: [introId] });
    expect(errorText(await call(limited, 'update_event_type', { event_type_id: teamId, title: 'Taken', idempotency_key: key() }))).toMatch(/^NOT_FOUND/);
    expect(errorText(await call(limited, 'create_event_type', { title: 'New', length_minutes: 30, idempotency_key: key() }))).toMatch(/^INSUFFICIENT_SCOPE/);
    expect((await h.db.get<{ title: string }>(sql`SELECT title FROM event_type WHERE id = ${h.other.eventTypeId}`))!.title).toBe('Globex Chat');
  });

  it('refuses every field outside the allowlist, and the guests question type', async () => {
    const writer = await h.key(WRITE);
    const before = await row();
    for (const [field, value] of [
      ['successRedirectUrl', 'https://evil.example/x'],
      ['success_redirect_url', 'https://evil.example/x'],
      ['tracking', { ga4Id: 'G-ABC123' }],
      ['reminders', []],
      ['crmPropertyMappings', null],
      ['hosts', [{ memberId: 'm' }]],
      ['slug', 'stolen'],
    ] as const) {
      const text = errorText(await call(writer, 'update_event_type', { event_type_id: introId, [field]: value, idempotency_key: key() }));
      expect(text, field).toContain(field);
    }
    const { revision } = await read(writer);
    const guests = [{ name: 'cc', label: 'Who else?', type: 'guests' }];
    expect((await call(writer, 'update_event_type', { event_type_id: introId, questions: guests, if_revision: revision, idempotency_key: key() })) as { isError?: boolean }).toMatchObject({ isError: true });
    expect(await row()).toEqual(before);
  });

  it('refuses a link in any text field, naming the field', async () => {
    const writer = await h.key(WRITE);
    const { revision } = await read(writer);
    const q = (over: Record<string, unknown>) => [{ name: 'q1', label: 'Pick one', type: 'select', options: ['a'], ...over }];
    for (const [args, field] of [
      [{ description: 'Details at https://evil.example/form' }, 'description'],
      [{ description: 'Register at evil-example.com/register' }, 'description'],
      [{ location: { kind: 'in_person', detail: 'www.evil.example' } }, 'location.detail'],
      [{ questions: q({ label: 'Write to mailto:x@evil.example' }), if_revision: revision }, 'questions[0].label'],
      [{ questions: q({ options: ['ok', 'ftp://evil.example'] }), if_revision: revision }, 'questions[0].options[1]'],
    ] as const) {
      const text = errorText(await call(writer, 'update_event_type', { event_type_id: introId, ...args, idempotency_key: key() }));
      expect(text).toMatch(/^URL_NOT_ALLOWED/);
      expect(text).toContain(field);
    }
    expect((await row())!.description).toBe('A 30-minute introductory call.');
  });

  it('replaces questions only against a fresh revision', async () => {
    const writer = await h.key(WRITE);
    const questions = [{ name: 'company', label: 'Company', type: 'text', required: true }];
    expect(errorText(await call(writer, 'update_event_type', { event_type_id: introId, questions, idempotency_key: key() }))).toContain('if_revision');
    const { revision } = await read(writer);
    await call(writer, 'update_event_type', { event_type_id: introId, title: 'Intro Call, renamed', idempotency_key: key() });
    expect(errorText(await call(writer, 'update_event_type', { event_type_id: introId, questions, if_revision: revision, idempotency_key: key() }))).toMatch(/^CONFLICT/);
    expect((await read(writer)).questions.map((x) => x.name)).toEqual(['company', 'topic']);
    await call(writer, 'update_event_type', { event_type_id: introId, title: 'Intro Call', idempotency_key: key() });
  });

  it('adds a required question that every read shows and a booking must answer; a retry changes nothing twice', async () => {
    const writer = await h.key(WRITE);
    const current = await read(writer);
    const questions = [
      ...current.questions.map(({ name, label, type, required }) => ({ name, label, type, required })),
      { name: 'budget', label: 'Budget', type: 'select', required: true, options: ['Under 10k', '10k or more'] },
    ];
    const args = { event_type_id: introId, questions, if_revision: current.revision, idempotency_key: key() };
    const out = structured<{ event_type: EventType; changed: string[] }>(await call(writer, 'update_event_type', args));
    expect(out.changed).toEqual(['questions']);
    expect(out.event_type.revision).not.toBe(current.revision);
    expect(structured<{ event_type: EventType }>(await call(writer, 'update_event_type', args)).event_type.revision).toBe(out.event_type.revision);

    const budget = { name: 'budget', type: 'select', required: true, options: ['Under 10k', '10k or more'] };
    expect((await read(writer)).questions).toContainEqual(expect.objectContaining(budget));
    const listed = structured<{ event_types: EventType[] }>(await call(writer, 'list_event_types', {})).event_types.find((e) => e.id === introId)!;
    expect(listed.questions).toContainEqual(expect.objectContaining(budget));
    expect(listed.revision).toBe(out.event_type.revision);
    const slots = structured<{ event_type: EventType; days: { slots: { start: string }[] }[] }>(
      await call(writer, 'find_available_slots', { event_type_id: introId, time_zone: 'UTC' }),
    );
    expect(slots.event_type.questions).toContainEqual(expect.objectContaining(budget));
    const start = slots.days.flatMap((d) => d.slots)[0]!.start;
    const booking = await call(writer, 'create_booking', {
      event_type_id: introId,
      start,
      attendee: { name: 'Sam', email: 'sam@example.org', time_zone: 'UTC' },
      answers: { company: 'Co' },
      idempotency_key: key(),
    });
    expect(errorText(booking)).toMatch(/^BOOKING_FIELDS_INVALID/);
  });

  it('keeps a question the CRM mapping reads', async () => {
    const writer = await h.key(WRITE);
    const mappings = JSON.stringify({ crm: [{ source: { kind: 'question', name: 'company' }, properties: ['company'] }] });
    await h.db.run(sql`UPDATE event_type SET crm_property_mappings = ${mappings} WHERE id = ${introId}`);
    try {
      const { revision } = await read(writer);
      const questions = [{ name: 'topic', label: 'Topic', type: 'textarea' }];
      const text = errorText(await call(writer, 'update_event_type', { event_type_id: introId, questions, if_revision: revision, idempotency_key: key() }));
      expect(text).toMatch(/^CRM_MAPPED_QUESTION/);
      expect(text).toContain('company');
      expect((await read(writer)).questions.map((x) => x.name)).toContain('company');
    } finally {
      await h.db.run(sql`UPDATE event_type SET crm_property_mappings = NULL WHERE id = ${introId}`);
    }
  });

  it('keeps what a read cannot show whole: stored markup, a guests question, its CRM mapping, and refuses past the caps', async () => {
    const writer = await h.key(WRITE);
    const fields = [
      { name: 'company', label: 'Company <b>name</b>', type: 'text', required: true },
      { name: 'size', label: 'Size', type: 'select', required: false, options: ['<i>S</i>', 'M'] },
      { name: 'cc', label: 'Who else?', type: 'guests', required: false },
    ];
    const mapping = JSON.stringify({ crm: [{ source: { kind: 'question', name: 'cc' }, properties: ['cc'] }] });
    const store = (f: unknown) => h.db.run(sql`UPDATE event_type SET booking_fields = ${JSON.stringify(f)}, crm_property_mappings = ${mapping} WHERE id = ${introId}`);
    await store(fields);
    try {
      const { revision, questions } = await read(writer);
      const shown = questions.filter((x) => x.type !== 'guests').map(({ name, label, type, required, options }) => ({ name, label, type, required, options }));
      const edit = (qs: unknown[], rev = revision) => call(writer, 'update_event_type', { event_type_id: introId, questions: qs, if_revision: rev, idempotency_key: key() });
      const clash = errorText(await edit([...shown, { name: 'cc', label: 'Copy to', type: 'text' }]));
      expect(clash).toMatch(/^INVALID_ARGUMENT/);
      expect(clash).toContain('questions[2].name');
      structured(await edit([...shown, { name: 'budget', label: 'Budget', type: 'text' }]));
      const saved = JSON.parse((await row())!.booking_fields as string) as typeof fields;
      expect(saved.map((f) => [f.name, f.label, f.options])).toEqual([
        ['company', 'Company <b>name</b>', undefined],
        ['size', 'Size', ['<i>S</i>', 'M']],
        ['cc', 'Who else?', undefined],
        ['budget', 'Budget', undefined],
      ]);
      await store([{ ...fields[1], options: Array.from({ length: 51 }, (_, i) => `o${i}`) }]);
      expect(errorText(await edit(shown, (await read(writer)).revision))).toMatch(/^INVALID_ARGUMENT.*dashboard/);
    } finally {
      await h.db.run(sql`UPDATE event_type SET crm_property_mappings = NULL WHERE id = ${introId}`);
    }
  });

  it('writes the changed field names on the audit line, never their values', async () => {
    const writer = await h.key(WRITE);
    await call(writer, 'update_event_type', { event_type_id: introId, title: 'Secret Launch Name', minimum_notice_minutes: 120, idempotency_key: key() });
    const line = h.audit.filter((l) => l.includes('"update_event_type"')).at(-1)!;
    expect(JSON.parse(line)).toMatchObject({ tool: 'update_event_type', result: 'ok', changed: ['title'], affected: [introId] });
    expect(line).not.toContain('Secret Launch Name');
    await call(writer, 'update_event_type', { event_type_id: introId, title: 'Intro Call', idempotency_key: key() });
  });

  it('creates a hidden event type for the workspace owner, its slug from the title, once per idempotency key', async () => {
    const writer = await h.key(WRITE);
    const args = { title: 'Intro Call', length_minutes: 45, idempotency_key: key() };
    const out = structured<{ event_type: EventType & { booking_page_url: string | null }; already_created: boolean }>(await call(writer, 'create_event_type', args));
    const owner = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    expect(out.event_type).toMatchObject({ title: 'Intro Call', slug: 'intro-call-2', hidden: true, member_id: owner, booking_page_url: null });
    expect(out.already_created).toBe(false);
    const again = structured<{ event_type: EventType; already_created: boolean }>(await call(writer, 'create_event_type', args));
    expect(again).toMatchObject({ event_type: { id: out.event_type.id }, already_created: true });
    expect((await h.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM event_type WHERE slug LIKE 'intro-call%'`))!.n).toBe(2);
  });

  it('sets confirmation and a booking window on both tools, and a free link name on create only', async () => {
    type Out = { event_type: EventType & { requires_confirmation: boolean; booking_window_days: number | null }; changed: string[] };
    const writer = await h.key(WRITE);
    const before = await read(writer);
    const set = structured<Out>(await call(writer, 'update_event_type', { event_type_id: introId, requires_confirmation: true, booking_window_days: 30, idempotency_key: key() }));
    expect(set.changed).toEqual(['requires_confirmation', 'booking_window_days']);
    expect(set.event_type).toMatchObject({ requires_confirmation: true, booking_window_days: 30 });
    expect(set.event_type.revision).not.toBe(before.revision);
    const cleared = structured<Out>(await call(writer, 'update_event_type', { event_type_id: introId, requires_confirmation: false, booking_window_days: null, idempotency_key: key() }));
    expect(cleared.event_type).toMatchObject({ requires_confirmation: false, booking_window_days: null });
    for (const days of [0, 731])
      expect(errorText(await call(writer, 'update_event_type', { event_type_id: introId, booking_window_days: days, idempotency_key: key() }))).toContain('booking_window_days');
    const create = (slug: string) => call(writer, 'create_event_type', { title: 'Kickoff', length_minutes: 30, slug, requires_confirmation: true, booking_window_days: 14, idempotency_key: key() });
    const made = structured<Out>(await create('project-kickoff'));
    expect(made.event_type).toMatchObject({ slug: 'project-kickoff', requires_confirmation: true, booking_window_days: 14 });
    expect(made.changed).toEqual(expect.arrayContaining(['slug', 'requires_confirmation', 'booking_window_days']));
    const taken = errorText(await create('project-kickoff'));
    expect(taken).toMatch(/^CONFLICT/);
    expect(taken).toContain('project-kickoff');
    expect(errorText(await create('Bad Slug'))).toContain('slug');
  });
});
