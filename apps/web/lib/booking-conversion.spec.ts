// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCHEDULE_DATALAYER_EVENT,
  SCHEDULE_PIXEL_EVENT,
  conversionKey,
  reportBookingConversion,
  resetConversionsForTests,
} from '@/lib/booking-conversion';

type W = Window & { fbq?: (...args: unknown[]) => void; dataLayer?: unknown[] };
const w = () => window as W;

afterEach(() => {
  delete w().fbq;
  delete w().dataLayer;
  window.sessionStorage.clear();
  resetConversionsForTests();
  vi.restoreAllMocks();
});

describe('reportBookingConversion', () => {
  it('does nothing and creates nothing on a page without the host’s tags', () => {
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(w().fbq).toBeUndefined();
    expect(w().dataLayer).toBeUndefined();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('tells Meta a Schedule and GTM a booking_scheduled, once per booking', () => {
    const fbq = vi.fn();
    w().fbq = fbq;
    w().dataLayer = [];
    expect(reportBookingConversion('bk_1')).toBe(true);
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(fbq.mock.calls).toEqual([['track', SCHEDULE_PIXEL_EVENT]]);
    expect(w().dataLayer).toEqual([{ event: SCHEDULE_DATALAYER_EVENT }]);
    expect(SCHEDULE_PIXEL_EVENT).toBe('Schedule');
    expect(SCHEDULE_DATALAYER_EVENT).toBe('booking_scheduled');
    // Another booking is another conversion.
    expect(reportBookingConversion('bk_2')).toBe(true);
    expect(fbq).toHaveBeenCalledTimes(2);
  });

  it('holds the once-per-booking mark across a reload of the same tab (sessionStorage)', () => {
    w().dataLayer = [];
    reportBookingConversion('bk_1');
    expect(window.sessionStorage.getItem(conversionKey('bk_1'))).toBe('1');
    resetConversionsForTests(); // a new document, same tab
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(w().dataLayer).toHaveLength(1);
  });

  it('still reports once when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    w().dataLayer = [];
    expect(reportBookingConversion('bk_1')).toBe(true);
    expect(reportBookingConversion('bk_1')).toBe(false);
    expect(w().dataLayer).toHaveLength(1);
  });

  it('a pixel stub that throws neither throws here nor stops the dataLayer event', () => {
    w().fbq = () => {
      throw new Error('broken stub');
    };
    w().dataLayer = [];
    expect(() => reportBookingConversion('bk_1')).not.toThrow();
    expect(w().dataLayer).toEqual([{ event: SCHEDULE_DATALAYER_EVENT }]);
  });

  it('sends nothing about the invitee or the booking', () => {
    const fbq = vi.fn();
    w().fbq = fbq;
    w().dataLayer = [];
    reportBookingConversion('bk_secret_uid');
    expect(JSON.stringify([fbq.mock.calls, w().dataLayer])).not.toContain('bk_secret_uid');
  });
});
