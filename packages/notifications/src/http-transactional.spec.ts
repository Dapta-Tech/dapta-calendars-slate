import { describe, it, expect } from 'vitest';
import {
  HttpEmailProvider,
  interpretTransactionalResponse,
} from './adapters/http';
import { BookingNotifier, type BookingNotification } from './booking-notifier';
import { icsContentType } from './ics';
import type { EmailMessage } from './email.port';

/** A fetch stub that records the request and returns a canned JSON response. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const readBody = (calls: Array<{ init: RequestInit }>) =>
  JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
const readHeaders = (calls: Array<{ init: RequestInit }>) =>
  (calls[0]!.init.headers ?? {}) as Record<string, string>;

const ENDPOINT = 'https://mail.example.test/v1/send';

const message: EmailMessage = {
  to: ['sam@example.com', 'alex@example.com'],
  replyTo: 'alex@example.com',
  subject: 'Confirmed: Intro Call',
  html: '<p>Hi Sam</p>',
  text: 'Hi Sam',
  from: 'ignored@example.com',
  headers: { 'X-Booking-Uid': 'bk-1' },
  idempotencyKey: 'calendar:bk-1:confirmation',
  attachments: [
    {
      filename: 'invite.ics',
      content: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n',
      contentType: icsContentType('REQUEST'),
    },
  ],
};

describe('transactional-v1 wire — request contract', () => {
  it('POSTs the managed contract: mode, to[], replyTo, subject, html/text, category, idempotencyKey', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted', messageId: 'm1' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'secret-key', fromEmail: 'x@example.com' },
      impl,
    );

    const result = await provider.send(message);

    expect(result).toEqual({ delivered: true, messageId: 'm1', driver: 'http' });
    const body = readBody(calls);
    expect(body.mode).toBe('html'); // html present → html mode
    expect(body.to).toEqual(['sam@example.com', 'alex@example.com']);
    expect(body.replyTo).toBe('alex@example.com');
    expect(body.subject).toBe('Confirmed: Intro Call');
    expect(body.html).toBe('<p>Hi Sam</p>');
    expect(body.text).toBe('Hi Sam');
    expect(body.category).toBe('lifecycle'); // default (Req 5)
    expect(body.idempotencyKey).toBe('calendar:bk-1:confirmation');
  });

  it('sends `mode:text` and no html field when only text is present', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', fromEmail: 'x@example.com' },
      impl,
    );
    await provider.send({ ...message, html: undefined });
    const body = readBody(calls);
    expect(body.mode).toBe('text');
    expect(body).not.toHaveProperty('html');
    expect(body.text).toBe('Hi Sam');
  });

  it('does NOT send unsupported from / fromName / headers fields', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', fromEmail: 'x@example.com', fromName: 'Calendars' },
      impl,
    );
    await provider.send(message);
    const body = readBody(calls);
    expect(body).not.toHaveProperty('from');
    expect(body).not.toHaveProperty('fromName');
    expect(body).not.toHaveProperty('headers');
  });

  it('maps ICS attachment to {filename, contentType (full MIME), contentBase64, disposition:"attachment"} (plural `attachments`)', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', fromEmail: 'x@example.com' },
      impl,
    );
    await provider.send(message);
    const body = readBody(calls);

    // Plural field name, per the backend contract.
    expect(body).toHaveProperty('attachments');
    expect(body).not.toHaveProperty('attachment');
    const att = (body.attachments as Array<Record<string, unknown>>)[0]!;
    expect(att.filename).toBe('invite.ics');
    // Full ICS MIME value is forwarded verbatim (backend commit 0e737f1).
    expect(att.contentType).toBe('text/calendar; method=REQUEST; charset=utf-8');
    expect(att.disposition).toBe('attachment');
    // contentBase64 is the base64 of the ICS text.
    expect(Buffer.from(String(att.contentBase64), 'base64').toString('utf8')).toBe(
      'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n',
    );
  });

  it('authenticates with X-API-Key and never puts the key in the body or a Bearer header', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'super-secret', fromEmail: 'x@example.com' },
      impl,
    );
    await provider.send(message);
    const headers = readHeaders(calls);
    expect(headers['x-api-key']).toBe('super-secret');
    expect(headers).not.toHaveProperty('authorization');
    expect(String(calls[0]!.init.body)).not.toContain('super-secret');
  });

  it('honors a configured category override', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', category: 'reminders', fromEmail: 'x@example.com' },
      impl,
    );
    await provider.send(message);
    expect(readBody(calls).category).toBe('reminders');
  });
});

describe('transactional-v1 wire — response interpretation', () => {
  it('accepted / delivered count as dispatched', () => {
    expect(interpretTransactionalResponse(202, { status: 'accepted', messageId: 'a' })).toEqual({
      delivered: true,
      messageId: 'a',
      driver: 'http',
    });
    expect(interpretTransactionalResponse(200, { status: 'delivered', id: 'b' })).toEqual({
      delivered: true,
      messageId: 'b',
      driver: 'http',
    });
  });

  it('a valid idempotent duplicate (accepted + duplicate:true) counts as dispatched', () => {
    expect(
      interpretTransactionalResponse(200, { status: 'accepted', duplicate: true, messageId: 'dup' }),
    ).toEqual({ delivered: true, messageId: 'dup', driver: 'http' });
  });

  it('blocked_by_policy THROWS (surfaced to the outbox, not a silent drop)', () => {
    expect(() =>
      interpretTransactionalResponse(200, { status: 'blocked_by_policy', blockedReason: 'suppressed recipient' }),
    ).toThrow(/blocked by policy: suppressed recipient/);
  });

  it('a malformed 2xx (no status) THROWS', () => {
    expect(() => interpretTransactionalResponse(200, { messageId: 'x' })).toThrow(/malformed/);
    expect(() => interpretTransactionalResponse(200, null)).toThrow(/malformed/);
  });

  it('enforces non-2xx failure BEFORE interpreting any body status', () => {
    // Even a body that "looks" accepted must fail if the HTTP status is non-2xx.
    expect(() => interpretTransactionalResponse(500, { status: 'accepted' })).toThrow(/HTTP 500/);
    expect(() => interpretTransactionalResponse(429, { status: 'accepted', messageId: 'm' })).toThrow(/HTTP 429/);
  });

  it('an unexpected status THROWS', () => {
    expect(() => interpretTransactionalResponse(200, { status: 'weird' })).toThrow(/unexpected status: weird/);
  });

  it('provider.send throws on a blocked response so the outbox retries/records it', async () => {
    const { impl } = stubFetch(200, { status: 'blocked_by_policy', blockedReason: 'bounced' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', fromEmail: 'x@example.com' },
      impl,
    );
    await expect(provider.send(message)).rejects.toThrow(/blocked by policy: bounced/);
  });
});

describe('generic wire — backwards compatibility (default profile)', () => {
  it('still POSTs the original provider-agnostic body with Bearer auth on a 2xx', async () => {
    const { impl, calls } = stubFetch(200, { messageId: 'g1' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, token: 'bearer-tok', fromEmail: 'from@example.com', fromName: 'Calendars' },
      impl,
    );

    const result = await provider.send(message);

    expect(result).toEqual({ delivered: true, messageId: 'g1', driver: 'http' });
    const headers = readHeaders(calls);
    expect(headers.authorization).toBe('Bearer bearer-tok');
    expect(headers).not.toHaveProperty('x-api-key');
    const body = readBody(calls);
    // The original shape is unchanged: from/fromName/headers/attachments{content,encoding}.
    expect(body.from).toBe('ignored@example.com'); // message.from override respected
    expect(body.fromName).toBe('Calendars');
    expect(body.headers).toEqual({ 'X-Booking-Uid': 'bk-1' });
    expect(body).not.toHaveProperty('mode');
    expect(body).not.toHaveProperty('idempotencyKey');
    const att = (body.attachments as Array<Record<string, unknown>>)[0]!;
    expect(att.content).toBe('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n');
    expect(att).not.toHaveProperty('contentBase64');
  });

  it('throws on a non-2xx (durable retry, never a silent drop)', async () => {
    const { impl } = stubFetch(503, {});
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, token: 't', fromEmail: 'from@example.com' },
      impl,
    );
    await expect(provider.send(message)).rejects.toThrow(/HTTP 503/);
  });
});

describe('BookingNotifier → transactional-v1 (end-to-end idempotency + attachment)', () => {
  const notification: BookingNotification = {
    uid: 'bk-42',
    title: 'Intro Call',
    startUtc: '2026-08-01T15:00:00.000Z',
    endUtc: '2026-08-01T15:30:00.000Z',
    host: { name: 'Alex Rivera', email: 'alex@example.com' },
    attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/New_York' },
    location: 'Google Meet',
    manageUrl: 'https://app.example.com/manage/bk-42?token=tok',
    stamp: '2026-07-09T12:00:00.000Z',
  };

  it('confirmation carries the namespaced key and a base64 ICS through the wire', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted', messageId: 'c1' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', fromEmail: 'x@example.com' },
      impl,
    );
    const notifier = new BookingNotifier(provider);

    const res = await notifier.sendConfirmation(notification);

    expect(res.delivered).toBe(true);
    const body = readBody(calls);
    expect(body.idempotencyKey).toBe('calendar:bk-42:confirmation');
    const att = (body.attachments as Array<Record<string, unknown>>)[0]!;
    expect(Buffer.from(String(att.contentBase64), 'base64').toString('utf8')).toContain('METHOD:REQUEST');
  });

  it('two distinct reschedules produce two distinct idempotency keys', async () => {
    const { impl, calls } = stubFetch(202, { status: 'accepted' });
    const provider = new HttpEmailProvider(
      { endpoint: ENDPOINT, profile: 'transactional-v1', apiKey: 'k', fromEmail: 'x@example.com' },
      impl,
    );
    const notifier = new BookingNotifier(provider);

    await notifier.sendReschedule({ ...notification, startUtc: '2026-08-02T15:00:00.000Z' });
    await notifier.sendReschedule({ ...notification, startUtc: '2026-08-03T15:00:00.000Z' });

    const key1 = (JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>).idempotencyKey;
    const key2 = (JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>).idempotencyKey;
    expect(key1).toBe('calendar:bk-42:reschedule:2026-08-02T15:00:00.000Z');
    expect(key2).toBe('calendar:bk-42:reschedule:2026-08-03T15:00:00.000Z');
    expect(key1).not.toBe(key2);
  });
});
