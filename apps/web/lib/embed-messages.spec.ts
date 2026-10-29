// @vitest-environment jsdom
/**
 * The host-facing steps an embedded booking page posts to the framing page:
 * `event_type_viewed`, `date_selected`, `time_selected` and `booking_scheduled`
 * (Calendly's ladder), each with only what the URL already says and the day or
 * instant picked, because `targetOrigin` is `'*'`. Nothing at all outside a
 * frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKING_SCHEDULED_EVENT,
  DATE_SELECTED_EMBED_EVENT,
  EVENT_TYPE_VIEWED_EVENT,
  TIME_SELECTED_EMBED_EVENT,
  postBookingScheduled,
  postBookingStep,
} from '@/lib/embed-messages';

const parent = { postMessage: vi.fn() };

function framed() {
  Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
}

afterEach(() => {
  Object.defineProperty(window, 'parent', { configurable: true, get: () => window });
  parent.postMessage.mockReset();
});

describe('the host-facing booking steps', () => {
  it('names them the way the framing page listens for them', () => {
    expect([EVENT_TYPE_VIEWED_EVENT, DATE_SELECTED_EMBED_EVENT, TIME_SELECTED_EMBED_EVENT, BOOKING_SCHEDULED_EVENT]).toEqual([
      'dapta-calendars.event_type_viewed',
      'dapta-calendars.date_selected',
      'dapta-calendars.time_selected',
      'dapta-calendars.booking_scheduled',
    ]);
  });

  it('posts each step to the framing page with only the event and what was picked', () => {
    framed();
    postBookingStep('event_type_viewed', { eventTypeSlug: 'intro-call', date: '2026-11-03', startUtc: 'x' });
    postBookingStep('date_selected', { eventTypeSlug: 'intro-call', date: '2026-11-03', startUtc: 'x' });
    postBookingStep('time_selected', { eventTypeSlug: 'intro-call', date: '2026-11-03', startUtc: '2026-11-03T15:00:00.000Z' });
    postBookingScheduled({ uid: 'bk_1', startUtc: '2026-11-03T15:00:00.000Z', eventTypeSlug: 'intro-call' });
    expect(parent.postMessage.mock.calls).toEqual([
      [{ event: EVENT_TYPE_VIEWED_EVENT, payload: { eventTypeSlug: 'intro-call' } }, '*'],
      [{ event: DATE_SELECTED_EMBED_EVENT, payload: { eventTypeSlug: 'intro-call', date: '2026-11-03' } }, '*'],
      [{ event: TIME_SELECTED_EMBED_EVENT, payload: { eventTypeSlug: 'intro-call', startUtc: '2026-11-03T15:00:00.000Z' } }, '*'],
      [
        { event: BOOKING_SCHEDULED_EVENT, payload: { uid: 'bk_1', startUtc: '2026-11-03T15:00:00.000Z', eventTypeSlug: 'intro-call' } },
        '*',
      ],
    ]);
  });

  it('posts nothing outside a frame', () => {
    postBookingStep('date_selected', { eventTypeSlug: 'intro-call', date: '2026-11-03' });
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});
