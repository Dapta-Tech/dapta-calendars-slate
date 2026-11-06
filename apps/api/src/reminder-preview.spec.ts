import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { EmailEffects } from './email-effects';

const REQ: ReqLike = { headers: {} };

/**
 * The event editor's reminder preview: the email an invitee would get, from
 * the editor's unsaved copy and a sample booking, rendered by the notifier's
 * own builders (so the HTML is the real branded layout), and never sent.
 */
describe('reminder preview', () => {
  let db: Db;
  let fx: EmailEffects;
  let principal: HostPrincipal;
  let sent: number;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`))!;
    principal = { accountId: m.account_id, memberId: m.id, role: 'owner' };
    sent = 0;
    const provider = new NoopEmailProvider();
    const send = provider.send.bind(provider);
    provider.send = async (msg) => {
      sent += 1;
      return send(msg);
    };
    fx = new EmailEffects(new BookingNotifier(provider), db);
  });

  const input = (over: Record<string, unknown> = {}) => ({
    kind: 'reminder' as const,
    leadMinutes: 1440,
    subject: null,
    body: null,
    title: 'Discovery call',
    lengthMinutes: 30,
    location: { kind: 'conferencing', detail: null },
    questions: [{ name: 'company', label: 'Company' }],
    ...over,
  });

  it('renders the host’s subject with sample values and the branded HTML, and sends nothing', async () => {
    const r = await fx.previewReminder(principal, input({ subject: 'See you {{reminder_lead}}, {{attendee_name}} from {{form.company}}' }));
    expect(r.subject).toBe('See you in 1 day(s), Sam Taylor from Company');
    expect(r.html).toContain('<table');
    expect(r.html).toContain('Discovery call');
    expect(r.html).toContain('https://meet.example.com/abc-defg-hij');
    expect(sent).toBe(0);
  });

  it('a blank subject and body use the shipped default wording', async () => {
    const r = await fx.previewReminder(principal, input());
    expect(r.subject).toMatch(/^Reminder: Discovery call — /);
    expect(r.text).toContain('Reminder: "Discovery call" starts in 1 day(s).');
  });

  it('previews a follow-up too', async () => {
    const r = await fx.previewReminder(principal, input({ kind: 'follow_up', leadMinutes: 60, subject: 'Thanks, {{attendee_name}}' }));
    expect(r.subject).toBe('Thanks, Sam Taylor');
    expect(r.html).toContain('Discovery call');
  });

  it('the route resolves the host and refuses out-of-range input', async () => {
    const crud = new AdminCrudController(
      db,
      { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService,
      undefined,
      undefined,
      undefined,
      fx,
    );
    const ok = await crud.previewReminder(REQ, input({ subject: 'Hi {{attendee_name}}' }));
    expect(ok.subject).toBe('Hi Sam Taylor');
    await expect(crud.previewReminder(REQ, input({ leadMinutes: 0 }))).rejects.toBeInstanceOf(BadRequestException);
  });
});
