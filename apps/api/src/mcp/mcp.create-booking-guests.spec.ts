import { describe, expect, it } from 'vitest';
import * as z from 'zod4';
import {
  BookingNotifier,
  resolveTemplate,
  type BookingNotification,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from '@slate/notifications';
import { TOOLS } from './tools';

/**
 * What create_booking says about `guests` matches what happens to them: dCal's
 * own emails go to the invitee only (and the hosts), never to an extra guest;
 * the host's connected calendar is what invites the guests. The tool used to
 * say each guest is emailed, which no code path does.
 */

class Recorder implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

const booking: BookingNotification = {
  accountId: '11111111-1111-4111-8111-111111111111',
  uid: 'bk-guests',
  title: 'Intro Call',
  startUtc: '2026-08-03T15:00:00.000Z',
  endUtc: '2026-08-03T15:30:00.000Z',
  host: { name: 'Alex Rivera', email: 'alex@example.com', timeZone: 'America/Bogota' },
  attendee: { name: 'Sam Invitee', email: 'sam@example.com', timeZone: 'America/New_York' },
  guests: [{ name: 'Ana Ruiz', email: 'ana@example.com' }, { email: 'bo@example.com' }],
};

describe('create_booking and its guests', () => {
  const tool = TOOLS.find((t) => t.name === 'create_booking')!;
  const guestsText = JSON.stringify(z.toJSONSchema(tool.input.shape['guests'] as z.ZodType, { unrepresentable: 'any' }));

  it('says dCal emails the invitee only, and never that a guest is emailed', () => {
    for (const text of [tool.description, guestsText]) {
      expect(text).not.toMatch(/each is emailed|\(and guests\)/i);
      expect(text).toMatch(/connected calendar/);
    }
    expect(guestsText).toContain('dCal emails the invitee only');
    expect(tool.description).toContain('not emailed by dCal');
  });

  it("is true: no copy of a booking email goes to an extra guest, the invitee's or the host's", async () => {
    const rec = new Recorder();
    const notifier = new BookingNotifier(rec);
    await notifier.sendConfirmation({ ...booking, audience: 'attendee', template: resolveTemplate('attendee_confirmation', null, 'en') });
    await notifier.sendConfirmation({ ...booking, audience: 'host', template: resolveTemplate('host_booked', null, 'en') });
    await notifier.sendCancellation({ ...booking, audience: 'attendee', template: resolveTemplate('attendee_cancellation', null, 'en') });
    expect(rec.sent.map((m) => m.to)).toEqual([['sam@example.com'], ['alex@example.com'], ['sam@example.com']]);
    expect(JSON.stringify(rec.sent.map((m) => m.to))).not.toMatch(/ana@example\.com|bo@example\.com/);
  });
});
