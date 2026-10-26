import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { EMAIL_COLORS, renderBrandedHtml, type EmailKind } from './email-layout';
import type { TemplateVariable } from './templates';

const MANAGE = 'https://calendar.example.test/manage/x?token=t';
const AGAIN = 'https://calendar.example.test/northwind/riley-chen/intro';

const vars = (over: Partial<Record<TemplateVariable, string>> = {}): Record<TemplateVariable, string> => ({
  attendee_name: 'Sam Visitor',
  attendee_email: 'sam@example.com',
  host_name: 'Riley Chen',
  event_title: 'Intro call',
  start_time: 'Fri, Jul 17 · 9:30 AM',
  end_time: 'Fri, Jul 17 · 10:00 AM',
  location: 'Online meeting',
  meeting_url: '',
  manage_url: MANAGE,
  cancel_link: MANAGE,
  reschedule_link: MANAGE,
  cancellation_reason: '',
  previous_start_time: '',
  reminder_lead: '',
  pending_note: '',
  booking_link: AGAIN,
  ...over,
});

const KINDS: EmailKind[] = ['confirmation', 'pending', 'reschedule', 'cancellation', 'declined', 'reminder', 'follow_up'];

/** Filled buttons: the ink cell the one action sits in. */
const filledButtons = (html: string) =>
  html.split(`<td style="background:${EMAIL_COLORS.ink};border-radius:10px;">`).length - 1;

describe('renderBrandedHtml', () => {
  it('lists the facts for every kind, in both languages', () => {
    for (const k of KINDS) {
      for (const locale of ['en', 'es']) {
        const html = renderBrandedHtml(k, vars(), locale);
        expect(html).toContain('Intro call');
        expect(html).toContain('Online meeting');
        expect(html).toContain('Fri, Jul 17');
        expect(html).toContain('Riley Chen');
      }
    }
  });

  it('draws at most one filled button, for every kind', () => {
    for (const k of KINDS) {
      const html = renderBrandedHtml(k, vars({ meeting_url: 'https://meet.example.test/abc' }), 'en');
      expect(filledButtons(html)).toBeLessThanOrEqual(1);
    }
  });

  it('the confirmation: one primary, Manage your booking, and the meeting link as a fact', () => {
    const html = renderBrandedHtml('confirmation', vars({ meeting_url: 'https://meet.example.test/abc' }), 'en');
    expect(filledButtons(html)).toBe(1);
    expect(html).toContain(`href="${MANAGE}"`);
    expect(html).toContain('Manage your booking');
    expect(html).toContain('Join the meeting');
    expect(html).toContain('https://meet.example.test/abc');
    expect(renderBrandedHtml('confirmation', vars(), 'es')).toContain('Gestionar tu reserva');
  });

  it('no lime, no slab badge, no mono', () => {
    for (const k of KINDS) {
      const html = renderBrandedHtml(k, vars(), 'en');
      expect(html.toLowerCase()).not.toContain('#cbe84f');
      expect(html).not.toMatch(/>(CONFIRMED|PENDING|CANCELLED|RESCHEDULED)</);
      expect(html).not.toMatch(/monospace/i);
    }
  });

  it('names the product only with a signup destination, and only to the invitee', () => {
    const none = renderBrandedHtml('confirmation', vars(), 'en');
    expect(none).not.toContain('Dapta Calendars');
    expect(none).not.toContain('Create your free calendar');

    const url = 'https://signup.example.test/?utm_medium=email';
    const withUrl = renderBrandedHtml('confirmation', vars(), 'en', 'attendee', { signupUrl: url, daptaBrand: true });
    expect(withUrl.match(/dCal\.ai by Dapta/g)).toHaveLength(1);
    // A fork names its own product, never dCal or Dapta.
    const fork = renderBrandedHtml('confirmation', vars(), 'en', 'attendee', { signupUrl: url, productName: 'Acme Scheduling' });
    expect(fork).toContain('Made with Acme Scheduling');
    expect(fork).not.toContain('dCal');
    expect(fork).not.toContain('Dapta');
    expect(withUrl).toContain('Create your free calendar');
    expect(withUrl).toContain(`href="${url}"`);
    expect(renderBrandedHtml('confirmation', vars(), 'es', 'attendee', { signupUrl: url, daptaBrand: true })).toContain(
      'Crea tu calendario gratis',
    );

    const host = renderBrandedHtml('confirmation', vars(), 'en', 'host', { signupUrl: url, daptaBrand: true });
    expect(host).not.toContain('Dapta Calendars');
  });

  it('a reschedule shows the old time struck through', () => {
    const html = renderBrandedHtml('reschedule', vars({ previous_start_time: 'Thu, Jul 16 · 9:30 AM' }), 'en');
    expect(html).toContain('Thu, Jul 16');
    expect(html).toContain('line-through');
  });

  it('cancellation offers to book again, in Spanish too', () => {
    const html = renderBrandedHtml('cancellation', vars(), 'es');
    expect(html).toContain('Reservar otra hora');
    expect(html).toContain(AGAIN);
    expect(html).not.toContain('Gestionar tu reserva');
  });

  it('host audience labels the counterparty as the guest', () => {
    const html = renderBrandedHtml('confirmation', vars(), 'en', 'host');
    expect(html).toContain('Guest');
    expect(html).toContain('Sam Visitor');
  });

  it('HTML-escapes interpolated values (no injection via title, name or URL)', () => {
    const html = renderBrandedHtml(
      'confirmation',
      vars({ host_name: '<script>x</script>', meeting_url: 'javascript:alert(1)' }),
      'en',
      'attendee',
      { signupUrl: 'javascript:alert(2)' },
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
  });

  it('drops the action whose url is missing (no empty or # button)', () => {
    const html = renderBrandedHtml('confirmation', vars({ manage_url: '' }), 'en');
    expect(html).not.toContain('Manage your booking');
    expect(filledButtons(html)).toBe(0);
  });
});

describe('the email palette', () => {
  // An email cannot read a stylesheet, so the paper tokens are restated; this
  // holds the copy to `@slate/shared/tokens.css`.
  const tokens = readFileSync(new URL('../../shared/src/tokens.css', import.meta.url), 'utf8');
  // The block itself, not the header comment that names its selector.
  const start = tokens.indexOf(":root[data-theme='light'],\n[data-theme='light'] {");
  const paper = tokens.slice(start, tokens.indexOf('\n}', start));
  const token = (name: string) => paper.match(new RegExp(`--${name}:\\s*([^;]+);`))![1]!.trim();

  it('is the product paper palette', () => {
    expect(EMAIL_COLORS).toEqual({
      ground: token('muted'),
      paper: token('background'),
      ink: token('foreground'),
      muted: token('muted-foreground'),
      faint: token('faint'),
      border: token('border'),
      signal: token('signal-ink'),
      warning: token('warning-ink'),
      destructive: token('destructive'),
      onInk: token('primary-foreground'),
    });
  });
});
