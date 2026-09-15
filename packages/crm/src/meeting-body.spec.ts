import { describe, it, expect } from 'vitest';
import { prefixCancelledTitle, renderMeetingBody, type MeetingBodyLabels } from './meeting-body';

const EN: MeetingBodyLabels = {
  host: 'Host',
  bookingReference: 'Booking reference',
  yes: 'Yes',
  no: 'No',
};

describe('renderMeetingBody', () => {
  it('renders host, then label: answer lines, then the booking reference', () => {
    expect(
      renderMeetingBody({
        hostName: 'Alex Rivera',
        bookingUid: 'bk_123',
        answers: [
          { label: 'What would you like to discuss?', value: 'Pricing' },
          { label: 'Company', value: 'Acme' },
        ],
        labels: EN,
      }),
    ).toBe(
      [
        'Host: Alex Rivera',
        'What would you like to discuss?: Pricing',
        'Company: Acme',
        'Booking reference: bk_123',
      ].join('\n'),
    );
  });

  /**
   * The manage link is deliberately NOT here: it carries a token that cancels
   * and reschedules the invitee's booking, and every seat in a shared CRM (plus
   * anything the record is exported to) is the wrong audience for a capability
   * whose intended reader is the invitee's mailbox. The uid is traceable
   * without being a key.
   */
  it('carries the uid, never a manage link or a token', () => {
    const body = renderMeetingBody({
      hostName: null,
      bookingUid: 'bk_123',
      answers: [],
      labels: EN,
    });
    expect(body).toContain('bk_123');
    expect(body).not.toContain('token=');
    expect(body).not.toContain('/manage/');
  });

  it('omits the host line when there is no assigned host name', () => {
    const body = renderMeetingBody({
      hostName: null,
      bookingUid: 'bk_1',
      answers: [],
      labels: EN,
    });
    expect(body).toBe('Booking reference: bk_1');
  });

  it('renders booleans through the caller\'s locale labels', () => {
    const body = renderMeetingBody({
      hostName: null,
      bookingUid: 'bk_1',
      answers: [
        { label: 'First time?', value: true },
        { label: 'Existing customer?', value: false },
      ],
      labels: { host: 'Anfitrión', bookingReference: 'Referencia', yes: 'Sí', no: 'No' },
    });
    expect(body).toContain('First time?: Sí');
    expect(body).toContain('Existing customer?: No');
  });

  it('joins a multi-select answer with commas', () => {
    const body = renderMeetingBody({
      hostName: null,
      bookingUid: 'bk_1',
      answers: [{ label: 'Interests', value: ['Pricing', 'Onboarding'] }],
      labels: EN,
    });
    expect(body).toContain('Interests: Pricing, Onboarding');
  });

  it('drops empty, null and object answers rather than printing noise', () => {
    const body = renderMeetingBody({
      hostName: null,
      bookingUid: 'bk_1',
      answers: [
        { label: 'Empty', value: '' },
        { label: 'Blank', value: '   ' },
        { label: 'Missing', value: null },
        { label: 'Nested', value: { a: 1 } },
        { label: 'Kept', value: 'yes please' },
      ],
      labels: EN,
    });
    expect(body).toBe('Kept: yes please\nBooking reference: bk_1');
  });

  it('renders a numeric or zero answer rather than treating it as empty', () => {
    const body = renderMeetingBody({
      hostName: null,
      bookingUid: 'bk_1',
      answers: [{ label: 'Seats', value: 0 }],
      labels: EN,
    });
    expect(body).toContain('Seats: 0');
  });
});

describe('prefixCancelledTitle', () => {
  it('prefixes once', () => {
    expect(prefixCancelledTitle('Intro call', '[Canceled] ')).toBe('[Canceled] Intro call');
  });

  // A retried cancel re-runs the whole job; stacking prefixes would make the
  // CRM record uglier on every attempt.
  it('does not stack on a re-run', () => {
    const once = prefixCancelledTitle('Intro call', '[Canceled] ');
    expect(prefixCancelledTitle(once, '[Canceled] ')).toBe(once);
  });
});
