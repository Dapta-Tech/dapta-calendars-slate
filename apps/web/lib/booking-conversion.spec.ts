// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DATE_SELECTED_EVENT,
  DATE_SELECTED_PIXEL_EVENT,
  SCHEDULE_DATALAYER_EVENT,
  SCHEDULE_PIXEL_EVENT,
  TIME_SELECTED_EVENT,
  TIME_SELECTED_PIXEL_EVENT,
  conversionKey,
  reportBookingConversion,
  reportBookingStep,
  resetConversionsForTests,
  type BookingEventDetails,
} from '@/lib/booking-conversion';
import { EVENT_OWNER_POSTHOG, GA4_GTAG } from '@/lib/event-tracking';

type W = Window & {
  fbq?: (...args: unknown[]) => void;
  dataLayer?: unknown[];
  [GA4_GTAG]?: (...args: unknown[]) => void;
  posthog?: Record<string, unknown>;
};
const w = () => window as W;

/** What the GTM loader leaves on the page: a dataLayer that starts with `gtm.js`. */
const withContainer = () => {
  w().dataLayer = [{ 'gtm.start': 1, event: 'gtm.js' }];
};
const containerEvents = () => (w().dataLayer ?? []).slice(1);

const DETAILS: BookingEventDetails = { eventTypeSlug: 'intro-call', durationMinutes: 30, isTeam: false };

afterEach(() => {
  delete w().fbq;
  delete w().dataLayer;
  delete w()[GA4_GTAG];
  delete w().posthog;
  window.sessionStorage.clear();
  resetConversionsForTests();
  vi.restoreAllMocks();
});

describe('reportBookingConversion', () => {
  it('does nothing and creates nothing on a page without the host’s tags', () => {
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(w().fbq).toBeUndefined();
    expect(w().dataLayer).toBeUndefined();
    expect(w()[GA4_GTAG]).toBeUndefined();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('tells Meta a Schedule and GTM a booking_scheduled, once per booking', () => {
    const fbq = vi.fn();
    w().fbq = fbq;
    withContainer();
    expect(reportBookingConversion('bk_1')).toBe(true);
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(fbq.mock.calls).toEqual([['track', SCHEDULE_PIXEL_EVENT]]);
    expect(containerEvents()).toEqual([{ event: SCHEDULE_DATALAYER_EVENT }]);
    expect(SCHEDULE_PIXEL_EVENT).toBe('Schedule');
    expect(SCHEDULE_DATALAYER_EVENT).toBe('booking_scheduled');
    // Another booking is another conversion.
    expect(reportBookingConversion('bk_2')).toBe(true);
    expect(fbq).toHaveBeenCalledTimes(2);
  });

  it('carries the booking’s details to every tag: Meta, GTM under dcal, GA4 and the host’s PostHog', () => {
    const fbq = vi.fn();
    const gtag = vi.fn();
    const capture = vi.fn();
    w().fbq = fbq;
    withContainer();
    w()[GA4_GTAG] = gtag;
    w().posthog = { [EVENT_OWNER_POSTHOG]: { capture } };
    const booked = { ...DETAILS, isTeam: true, startUtc: '2026-11-03T15:00:00.000Z', status: 'accepted' };
    expect(reportBookingConversion('bk_1', window, booked)).toBe(true);
    const props = {
      event_type: 'intro-call',
      duration_minutes: 30,
      is_team: true,
      start_time: '2026-11-03T15:00:00.000Z',
      booking_status: 'accepted',
    };
    expect(fbq.mock.calls).toEqual([['track', 'Schedule', { content_name: 'intro-call' }]]);
    expect(containerEvents()).toEqual([{ event: 'booking_scheduled', dcal: props }]);
    expect(gtag.mock.calls).toEqual([['event', 'booking_scheduled', props]]);
    expect(capture.mock.calls).toEqual([['booking_scheduled', props]]);
  });

  it('GA4 alone counts as a tag, and a dataLayer some other script made gets no container event', () => {
    const gtag = vi.fn();
    w().dataLayer = [];
    w()[GA4_GTAG] = gtag;
    expect(reportBookingConversion('bk_1', window, DETAILS)).toBe(true);
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(w().dataLayer).toEqual([]);
  });

  it('holds the once-per-booking mark across a reload of the same tab (sessionStorage)', () => {
    withContainer();
    reportBookingConversion('bk_1');
    expect(window.sessionStorage.getItem(conversionKey('bk_1'))).toBe('1');
    resetConversionsForTests(); // a new document, same tab
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(containerEvents()).toHaveLength(1);
  });

  it('still reports once when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    withContainer();
    expect(reportBookingConversion('bk_1')).toBe(true);
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(containerEvents()).toHaveLength(1);
  });

  it('a stub that throws neither throws here nor stops the other tags', () => {
    w().fbq = () => {
      throw new Error('broken stub');
    };
    w().posthog = {
      [EVENT_OWNER_POSTHOG]: {
        capture: () => {
          throw new Error('broken');
        },
      },
    };
    withContainer();
    w()[GA4_GTAG] = () => {
      throw new Error('broken gtag');
    };
    expect(() => reportBookingConversion('bk_1', window, DETAILS)).not.toThrow();
    expect(containerEvents()).toEqual([expect.objectContaining({ event: SCHEDULE_DATALAYER_EVENT })]);
  });

  it('sends nothing about the invitee or the booking’s uid', () => {
    const fbq = vi.fn();
    const gtag = vi.fn();
    const capture = vi.fn();
    w().fbq = fbq;
    withContainer();
    w()[GA4_GTAG] = gtag;
    w().posthog = { [EVENT_OWNER_POSTHOG]: { capture } };
    reportBookingConversion('bk_secret_uid', window, { ...DETAILS, startUtc: '2026-11-03T15:00:00.000Z', status: 'pending' });
    expect(JSON.stringify([fbq.mock.calls, w().dataLayer, gtag.mock.calls, capture.mock.calls])).not.toContain('bk_secret_uid');
  });
});

describe('reportBookingStep', () => {
  it('a day picked: a custom Meta event and booking_date_selected everywhere else, with the day', () => {
    const fbq = vi.fn();
    const gtag = vi.fn();
    const capture = vi.fn();
    w().fbq = fbq;
    withContainer();
    w()[GA4_GTAG] = gtag;
    w().posthog = { [EVENT_OWNER_POSTHOG]: { capture } };
    expect(reportBookingStep('date_selected', { ...DETAILS, date: '2026-11-03' })).toBe(true);
    const props = { event_type: 'intro-call', duration_minutes: 30, is_team: false, date: '2026-11-03' };
    expect(fbq.mock.calls).toEqual([['trackCustom', DATE_SELECTED_PIXEL_EVENT, { content_name: 'intro-call' }]]);
    expect(containerEvents()).toEqual([{ event: DATE_SELECTED_EVENT, dcal: props }]);
    expect(gtag.mock.calls).toEqual([['event', DATE_SELECTED_EVENT, props]]);
    expect(capture.mock.calls).toEqual([[DATE_SELECTED_EVENT, props]]);
    expect([DATE_SELECTED_EVENT, DATE_SELECTED_PIXEL_EVENT]).toEqual(['booking_date_selected', 'BookingDateSelected']);
  });

  it('a time picked: the start, every time one is picked', () => {
    const fbq = vi.fn();
    w().fbq = fbq;
    withContainer();
    reportBookingStep('time_selected', { ...DETAILS, startUtc: '2026-11-03T15:00:00.000Z' });
    reportBookingStep('time_selected', { ...DETAILS, startUtc: '2026-11-03T15:30:00.000Z' });
    expect(fbq.mock.calls.map((c) => c[1])).toEqual([TIME_SELECTED_PIXEL_EVENT, TIME_SELECTED_PIXEL_EVENT]);
    expect(containerEvents()).toEqual([
      { event: TIME_SELECTED_EVENT, dcal: expect.objectContaining({ start_time: '2026-11-03T15:00:00.000Z' }) },
      { event: TIME_SELECTED_EVENT, dcal: expect.objectContaining({ start_time: '2026-11-03T15:30:00.000Z' }) },
    ]);
    expect([TIME_SELECTED_EVENT, TIME_SELECTED_PIXEL_EVENT]).toEqual(['booking_time_selected', 'BookingTimeSelected']);
  });

  it('does nothing on a page without the host’s tags', () => {
    expect(reportBookingStep('date_selected', { ...DETAILS, date: '2026-11-03' })).toBe(false);
    expect(w().dataLayer).toBeUndefined();
  });
});
