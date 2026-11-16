/**
 * The starting values a booking page takes from its own address: the three
 * attendee fields by name, every custom field under `answer_`, the first value
 * of each, cleaned. Nothing else in the query is a prefill — the parameters
 * this page already owns (`embed`, `lang`, `theme`, `brand_color`, the embed
 * style axes, the `utm_*`) must survive it untouched, which is the whole
 * reason custom fields are prefixed rather than named bare.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BOOKING_PREFILL_ANSWERS,
  MAX_BOOKING_PREFILL_NAME,
  MAX_BOOKING_PREFILL_VALUE,
} from '@slate/types';
import { isPlainNumber, prefillFromQuery } from '@/lib/booking-prefill';

describe('prefillFromQuery', () => {
  it('takes name, email and notes, and every answer_ key', () => {
    expect(
      prefillFromQuery({
        name: 'Sam Visitor',
        email: 'sam@example.com',
        notes: 'Sent from the form',
        answer_company: 'Example Co',
        answer_phone: '+57 300 1234567',
      }),
    ).toEqual({
      name: 'Sam Visitor',
      email: 'sam@example.com',
      notes: 'Sent from the form',
      answers: { company: 'Example Co', phone: '+57 300 1234567' },
    });
  });

  it('takes the first value of a repeated key, trimmed', () => {
    expect(prefillFromQuery({ name: ['  Sam  ', 'Other'], answer_company: ['  Example Co  '] })).toEqual({
      name: 'Sam',
      answers: { company: 'Example Co' },
    });
  });

  it('leaves the parameters the page already owns alone', () => {
    expect(
      prefillFromQuery({ embed: '1', lang: 'es', theme: 'dark', brand_color: '#3DDC84', utm_source: 'google' }),
    ).toBeNull();
  });

  it('is null for a page with no prefill at all', () => {
    expect(prefillFromQuery({})).toBeNull();
    expect(prefillFromQuery(undefined)).toBeNull();
  });

  it('drops a blank value instead of seeding an empty field', () => {
    expect(prefillFromQuery({ name: '   ', email: 'sam@example.com', answer_company: '' })).toEqual({
      email: 'sam@example.com',
    });
  });

  it('drops a value with an invisible formatting character, as a campaign is dropped', () => {
    expect(prefillFromQuery({ name: '‮mas', email: 'sam@example.com', answer_company: 'Exa​mple' })).toEqual({
      email: 'sam@example.com',
    });
  });

  it('keeps line breaks, the one control character that belongs in a value', () => {
    // `notes` and a long-text question are exactly where a prefilled message
    // carries them; dropping the value over one newline loses the whole text.
    expect(prefillFromQuery({ notes: 'Line one\r\nLine two', answer_topic: 'a\nb' })).toEqual({
      notes: 'Line one\nLine two',
      answers: { topic: 'a\nb' },
    });
  });

  it('drops a value with any other control character', () => {
    expect(prefillFromQuery({ name: 'Sam\u0007Visitor', email: 'sam@example.com' })).toEqual({
      email: 'sam@example.com',
    });
  });

  it('caps name where the booking write caps it, not at the notes limit', () => {
    // A 500-character name would pass the prefill and the form's required
    // check, then fail createBookingSchema after the visitor picked a time.
    const long = 'a'.repeat(MAX_BOOKING_PREFILL_NAME + 1);
    expect(prefillFromQuery({ name: long, notes: long })).toEqual({ notes: long });
    expect(prefillFromQuery({ name: 'a'.repeat(MAX_BOOKING_PREFILL_NAME) })).toEqual({
      name: 'a'.repeat(MAX_BOOKING_PREFILL_NAME),
    });
  });

  it(`drops a value over ${MAX_BOOKING_PREFILL_VALUE} characters`, () => {
    const long = 'a'.repeat(MAX_BOOKING_PREFILL_VALUE + 1);
    expect(prefillFromQuery({ notes: long, answer_company: long, name: 'Sam' })).toEqual({ name: 'Sam' });
  });

  it('keeps a malformed email, so the field flags it and the visitor fixes it', () => {
    expect(prefillFromQuery({ email: 'sam@' })).toEqual({ email: 'sam@' });
  });

  it('ignores a bare answer_ with no field name after it', () => {
    expect(prefillFromQuery({ answer_: 'x', name: 'Sam' })).toEqual({ name: 'Sam' });
  });

  it('ignores a field name longer than a field name can be', () => {
    expect(prefillFromQuery({ [`answer_${'f'.repeat(65)}`]: 'x', name: 'Sam' })).toEqual({ name: 'Sam' });
  });

  it(`keeps at most ${MAX_BOOKING_PREFILL_ANSWERS} answers, so a crafted address cannot grow the map`, () => {
    const query: Record<string, string> = {};
    for (let i = 0; i < MAX_BOOKING_PREFILL_ANSWERS + 10; i++) query[`answer_f${i}`] = 'x';
    const prefill = prefillFromQuery(query);
    expect(Object.keys(prefill!.answers!)).toHaveLength(MAX_BOOKING_PREFILL_ANSWERS);
  });
});

describe('isPlainNumber', () => {
  it.each(['0', '12', '-3', '3.5', '-0.25', '.5'])('accepts %s', (v) => {
    expect(isPlainNumber(v)).toBe(true);
  });
  it.each(['', ' ', ' 5', '5 ', '0x10', '0b10', '1e3', 'Infinity', '-Infinity', 'NaN', '+5', '5.', '1,5', 'a few'])(
    'rejects %j',
    (v) => {
      expect(isPlainNumber(v)).toBe(false);
    },
  );
});
