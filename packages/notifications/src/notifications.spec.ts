import { describe, it, expect, vi } from 'vitest';
import { createEmailProvider } from './factory';
import { LogOnlyEmailProvider } from './adapters/log-only';
import { BookingNotifier } from './booking-notifier';
import { buildIcs } from './ics';

describe('buildIcs', () => {
  const base = {
    uid: 'booking-1',
    startUtc: '2026-08-01T14:00:00.000Z',
    endUtc: '2026-08-01T14:30:00.000Z',
    title: 'Intro; Call',
    attendees: [{ name: 'Sam', email: 'sam@example.com' }],
    organizer: { name: 'Alex', email: 'alex@example.com' },
    stamp: '2026-07-08T00:00:00.000Z',
  };

  it('emits REQUEST with SEQUENCE 0, CRLF, stable UID, escaped TEXT', () => {
    const ics = buildIcs({ ...base, method: 'REQUEST', sequence: 0 });
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:booking-1');
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain('DTSTART:20260801T140000Z');
    expect(ics).toContain('SUMMARY:Intro\\; Call'); // escaped semicolon
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics.includes('\r\n')).toBe(true);
  });

  it('emits CANCEL with SEQUENCE 2 and the SAME UID', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', sequence: 2 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('UID:booking-1');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('STATUS:CANCELLED');
  });
});

describe('createEmailProvider', () => {
  it('defaults to log-only and reports not-delivered', async () => {
    const logger = { log: vi.fn() };
    const provider = new LogOnlyEmailProvider(logger);
    const result = await provider.send({ to: 'a@example.com', subject: 'Hi' });
    expect(result.delivered).toBe(false);
    expect(result.driver).toBe('log-only');
    expect(logger.log).toHaveBeenCalledOnce();
  });

  it('falls back to log-only when smtp host is missing', () => {
    const provider = createEmailProvider({ provider: 'smtp', fromEmail: 'x@example.com' });
    expect(provider).toBeInstanceOf(LogOnlyEmailProvider);
  });

  it('throws on a message with no recipient', async () => {
    const provider = createEmailProvider({ provider: 'log-only', fromEmail: 'x@example.com' });
    await expect(provider.send({ to: '', subject: 'x' })).rejects.toThrow(/recipient/);
  });
});

describe('BookingNotifier', () => {
  it('renders and sends a confirmation through the port', async () => {
    const sent: unknown[] = [];
    const provider = {
      send: (m: unknown) => {
        sent.push(m);
        return Promise.resolve({ delivered: false, driver: 'log-only' as const });
      },
    };
    const notifier = new BookingNotifier(provider);
    await notifier.sendConfirmation({
      uid: 'u1',
      title: 'Intro Call',
      startUtc: '2026-08-01T14:00:00.000Z',
      endUtc: '2026-08-01T14:30:00.000Z',
      host: { name: 'Alex Rivera' },
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      manageUrl: 'http://localhost:3000/manage/tok',
    });
    expect(sent).toHaveLength(1);
    const msg = sent[0] as { subject: string; text: string };
    expect(msg.subject).toContain('Intro Call');
    expect(msg.text).toContain('Alex Rivera');
  });

  it('collective/fixed-RR: every assigned host is a recipient (attendee + host + co-hosts)', async () => {
    const sent: Array<{ to: string[] }> = [];
    const provider = {
      send: (m: { to: string[] }) => {
        sent.push(m);
        return Promise.resolve({ delivered: false, driver: 'log-only' as const });
      },
    };
    const notifier = new BookingNotifier(provider);
    await notifier.sendConfirmation({
      uid: 'u3',
      title: 'Team Demo',
      startUtc: '2026-08-01T14:00:00.000Z',
      endUtc: '2026-08-01T14:30:00.000Z',
      host: { name: 'Alex', email: 'alex@example.com' },
      coHosts: [
        { name: 'Jordan', email: 'jordan@example.com' },
        { name: 'Dana', email: 'dana@example.com' },
      ],
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
    });
    expect(sent[0]!.to.sort()).toEqual(
      ['alex@example.com', 'dana@example.com', 'jordan@example.com', 'sam@example.com'].sort(),
    );
  });

  it('E8 — HTML-escapes attacker-controlled values in the email body (no XSS)', async () => {
    const sent: Array<{ html?: string; text: string }> = [];
    const provider = {
      send: (m: { html?: string; text: string }) => {
        sent.push(m);
        return Promise.resolve({ delivered: false, driver: 'log-only' as const });
      },
    };
    const notifier = new BookingNotifier(provider);
    const payload = '<script>alert(1)</script>';
    await notifier.sendCancellation({
      uid: 'u2',
      title: payload,
      startUtc: '2026-08-01T14:00:00.000Z',
      endUtc: '2026-08-01T14:30:00.000Z',
      host: { name: 'Alex' },
      attendee: { name: payload, email: 'sam@example.com', timeZone: 'UTC' },
      cancellationReason: payload,
    });
    const html = sent[0]!.html!;
    // The raw script tag must NOT appear; its escaped form must.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // Plaintext body is unescaped by design (not an injection surface).
    expect(sent[0]!.text).toContain('<script>');
  });
});

describe('BookingNotifier: the footer line and the invite', () => {
  const booking = {
    accountId: 'acc_1',
    uid: 'bk_footer_1',
    title: 'Intro call',
    startUtc: '2026-08-01T14:00:00.000Z',
    endUtc: '2026-08-01T14:30:00.000Z',
    host: { name: 'Riley Chen', email: 'riley@example.com' },
    attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
    manageUrl: 'https://calendar.example.test/manage/bk_footer_1?token=t',
    audience: 'attendee' as const,
  };
  const capture = () => {
    const sent: Array<{ html?: string; headers?: Record<string, string>; attachments?: Array<{ content: unknown }> }> = [];
    const provider = {
      send: (m: (typeof sent)[number]) => {
        sent.push(m);
        return Promise.resolve({ delivered: false, driver: 'log-only' as const });
      },
    };
    return { sent, provider };
  };

  it('a deployment with a signup destination: the invitee reads it once, and keeps the invite', async () => {
    const { sent, provider } = capture();
    await new BookingNotifier(provider as never, { signupUrl: 'https://signup.example.test/' }).sendConfirmation(booking);
    const m = sent[0]!;
    expect(m.html!.match(/Dapta Calendars/g)).toHaveLength(1);
    expect(m.html).toContain('https://signup.example.test/');
    expect(m.headers?.['X-Booking-Uid']).toBe('bk_footer_1');
    expect(String(m.attachments?.[0]?.content)).toContain('UID:bk_footer_1');
  });

  it('an account that hid the branding while paying: no product line, the rest of the mail unchanged', async () => {
    const shown = capture();
    const hidden = capture();
    const notifier = (p: unknown) => new BookingNotifier(p as never, { signupUrl: 'https://signup.example.test/' });
    await notifier(shown.provider).sendConfirmation({ ...booking, showBranding: true });
    await notifier(hidden.provider).sendConfirmation({ ...booking, showBranding: false });
    expect(hidden.sent[0]!.html).not.toContain('Dapta Calendars');
    expect(hidden.sent[0]!.html).not.toContain('https://signup.example.test/');
    // Branding on renders exactly what a notification without the field renders.
    const absent = capture();
    await notifier(absent.provider).sendConfirmation(booking);
    expect(shown.sent[0]!.html).toBe(absent.sent[0]!.html);
    // Hiding removes the line and nothing else.
    const line = /<div style="margin:0 0 6px;">.*?<\/div>/;
    expect(shown.sent[0]!.html!.replace(line, '')).toBe(hidden.sent[0]!.html);
    expect(String(hidden.sent[0]!.attachments?.[0]?.content)).toContain('UID:bk_footer_1');
  });

  it('a bare fork (no destination): no product in the email at all', async () => {
    const { sent, provider } = capture();
    await new BookingNotifier(provider as never).sendConfirmation(booking);
    expect(sent[0]!.html).not.toContain('Dapta Calendars');
    expect(String(sent[0]!.attachments?.[0]?.content)).toContain('UID:bk_footer_1');
  });
});
