import { describe, it, expect, vi } from 'vitest';
import { createEmailProvider } from './factory';
import { LogOnlyEmailProvider } from './adapters/log-only';
import { BookingNotifier } from './booking-notifier';

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
});
