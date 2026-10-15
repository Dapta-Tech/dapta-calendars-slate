import { describe, expect, it } from 'vitest';
import { BookingNotifier, type BookingNotification } from './booking-notifier';
import type { EmailMessage, EmailProvider, EmailResult } from './email.port';
import { resolveTemplate, type EmailTemplateKey } from './templates';

/**
 * Every lifecycle email, rendered end to end by the notifier (subject, text,
 * branded HTML, calendar attachment), pinned as a snapshot per kind, locale
 * and audience. A change to any of them shows up as a reviewable diff instead
 * of reaching an inbox unseen. Everything here is invented and the instants
 * are fixed, so the snapshots are stable.
 *
 * Rendered the way the API renders them: with the default template of the
 * kind and side, in the locale the API passes (the HOST's, today).
 */
class Recorder implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

const base: BookingNotification = {
  accountId: '11111111-1111-4111-8111-111111111111',
  uid: 'bk-snapshot',
  title: 'Intro Call',
  startUtc: '2026-08-03T15:00:00.000Z',
  endUtc: '2026-08-03T15:30:00.000Z',
  // The two sides live in different zones, so every host snapshot pins the
  // host's time and every invitee snapshot the invitee's.
  host: { name: 'Alex Rivera', email: 'alex@example.com', timeZone: 'America/Bogota' },
  attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/New_York' },
  location: 'Online meeting',
  locationKind: 'conferencing',
  meetingUrl: 'https://meet.example.test/room-1',
  manageUrl: 'https://app.example.com/manage/bk-snapshot?token=tok',
  stamp: '2026-07-09T12:00:00.000Z',
};

type Kind = 'confirmation' | 'pending' | 'cancellation' | 'reschedule' | 'reminder';
const KINDS: Kind[] = ['confirmation', 'pending', 'cancellation', 'reschedule', 'reminder'];

/** The template key the API resolves for each kind and side (KIND_SIDES in apps/api). */
const KEYS: Record<Kind, Record<'attendee' | 'host', EmailTemplateKey>> = {
  confirmation: { attendee: 'attendee_confirmation', host: 'host_booked' },
  pending: { attendee: 'attendee_pending', host: 'host_booked' },
  cancellation: { attendee: 'attendee_cancellation', host: 'host_cancelled' },
  reschedule: { attendee: 'attendee_reschedule', host: 'host_rescheduled' },
  reminder: { attendee: 'attendee_reminder', host: 'host_reminder' },
};

async function render(kind: Kind, locale: 'en' | 'es', audience: 'attendee' | 'host'): Promise<EmailMessage> {
  const rec = new Recorder();
  const notifier = new BookingNotifier(rec);
  const template = resolveTemplate(KEYS[kind][audience], null, locale);
  const n: BookingNotification = { ...base, templateLocale: locale, audience, template, pending: kind === 'pending' };
  if (kind === 'confirmation') await notifier.sendConfirmation(n);
  if (kind === 'pending') await notifier.sendPendingRequest(n);
  if (kind === 'cancellation') await notifier.sendCancellation({ ...n, cancellationReason: 'Plans changed' });
  if (kind === 'reschedule') await notifier.sendReschedule({ ...n, previousStartUtc: '2026-08-02T15:00:00.000Z' });
  if (kind === 'reminder') await notifier.sendReminder({ ...n, reminderLeadMinutes: 60 });
  expect(rec.sent).toHaveLength(1);
  return rec.sent[0]!;
}

describe.each(['en', 'es'] as const)('lifecycle emails (%s)', (locale) => {
  describe.each(['attendee', 'host'] as const)('to the %s', (audience) => {
    it.each(KINDS)('%s', async (kind) => {
      const m = await render(kind, locale, audience);
      const attachment = m.attachments?.[0];
      // The deployment's support address is product config, not what these
      // snapshots pin; it stays out of the public repo's fixtures.
      const html = String(m.html).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?=["<])/g, (a) =>
        a.endsWith('@example.com') ? a : '<support address>',
      );
      expect({
        to: m.to,
        subject: m.subject,
        text: m.text,
        html,
        attachment: attachment ? { filename: attachment.filename, contentType: attachment.contentType } : null,
        ics: attachment ? String(attachment.content) : null,
      }).toMatchSnapshot();
    });
  });
});

describe('what the lifecycle emails promise', () => {
  it('an online meeting carries its join link in every email that has one to give', async () => {
    for (const kind of ['confirmation', 'reschedule', 'reminder'] as const) {
      const m = await render(kind, 'en', 'attendee');
      expect(`${m.text}\n${m.html}`, kind).toContain(base.meetingUrl!);
    }
  });

  it('pending and cancellation carry no calendar invite to accept', async () => {
    const pending = await render('pending', 'en', 'attendee');
    expect(pending.attachments ?? []).toHaveLength(0);
    const cancel = await render('cancellation', 'en', 'attendee');
    expect(String(cancel.attachments?.[0]?.content ?? '')).toMatch(/METHOD:CANCEL|^$/);
  });

  it("the host's copy of a request asks the host, and carries no invitee button", async () => {
    for (const locale of ['en', 'es'] as const) {
      const m = await render('pending', locale, 'host');
      // Not the invitee's words, and not the invitee's manage link: a button on
      // it withdrew the very request the host was asked to accept.
      expect(m.html).not.toMatch(/sent your request|Enviamos tu solicitud|Cancel request|Cancelar solicitud/);
      expect(m.html).not.toContain(base.manageUrl!);
      expect(m.html).toContain(locale === 'es' ? 'Por confirmar' : 'Needs your OK');
      expect(m.html).toContain(locale === 'es' ? 'pidió esta hora' : 'asked for this time');
      expect(m.text).toMatch(/confirm|confirma/i);
    }
  });

  it("no host copy of ANY kind carries the invitee's manage link, with or without a template", async () => {
    // The manage link reschedules or cancels the INVITEE's booking. A host copy
    // used to offer it as Reschedule and Cancel buttons; it must not appear in
    // the host's HTML or text even if a caller still hands it over.
    const all = ['confirmation', 'pending', 'declined', 'cancellation', 'reschedule', 'reminder', 'follow_up'] as const;
    const hostKey: Record<(typeof all)[number], EmailTemplateKey> = {
      confirmation: 'host_booked',
      pending: 'host_booked',
      declined: 'host_declined',
      cancellation: 'host_cancelled',
      reschedule: 'host_rescheduled',
      reminder: 'host_reminder',
      follow_up: 'follow_up',
    };
    for (const locale of ['en', 'es'] as const) {
      for (const withTemplate of [true, false]) {
        for (const kind of all) {
          const rec = new Recorder();
          const notifier = new BookingNotifier(rec);
          const n: BookingNotification & { reminderLeadMinutes?: number } = {
            ...base,
            templateLocale: locale,
            audience: 'host',
            template: withTemplate ? resolveTemplate(hostKey[kind], null, locale) : null,
            pending: kind === 'pending',
            reminderLeadMinutes: 60,
          };
          const send = {
            confirmation: () => notifier.sendConfirmation(n),
            pending: () => notifier.sendPendingRequest(n),
            declined: () => notifier.sendDeclined(n),
            cancellation: () => notifier.sendCancellation(n),
            reschedule: () => notifier.sendReschedule({ ...n, previousStartUtc: '2026-08-02T15:00:00.000Z' }),
            reminder: () => notifier.sendReminder(n),
            follow_up: () => notifier.sendFollowUp(n),
          }[kind];
          await send();
          const m = rec.sent[0]!;
          const label = `${kind} ${locale} ${withTemplate ? 'template' : 'legacy'}`;
          expect(String(m.html), label).not.toContain(base.manageUrl!);
          expect(String(m.text), label).not.toContain(base.manageUrl!);
          expect(String(m.html), label).not.toMatch(/Manage your booking|Gestionar tu reserva|Manage your request/);
        }
      }
    }
    // The invitee's copy still has it.
    expect((await render('confirmation', 'en', 'attendee')).html).toContain(base.manageUrl!);
  });

  it('Spanish emails speak Spanish', async () => {
    const m = await render('confirmation', 'es', 'attendee');
    expect(m.html).toContain('Cuándo');
    expect(m.html).not.toContain('When');
  });

  it('with no signup destination, no email carries a signup line', async () => {
    for (const kind of KINDS) {
      const m = await render(kind, 'en', 'attendee');
      expect(m.html, kind).not.toMatch(/utm_medium=email|signup/i);
    }
  });
});
