import { describe, expect, it } from 'vitest';
import { buildCalendarFile, calendarFileHref, calendarFileName } from './ics';

const input = {
  uid: 'bk_123',
  title: 'Design review; with notes, please',
  startUtc: '2026-03-02T14:30:00.000Z',
  endUtc: '2026-03-02T15:15:00.000Z',
  location: 'Online meeting',
  url: 'https://meet.example.com/abc?pwd=a,b;c',
  stamp: '2026-03-01T10:00:00.000Z',
};

describe('buildCalendarFile', () => {
  it('is one published event in UTC, with the booking uid', () => {
    const ics = buildCalendarFile(input);
    expect(ics).toContain('METHOD:PUBLISH\r\n');
    expect(ics).toContain('UID:bk_123\r\n');
    expect(ics).toContain('DTSTART:20260302T143000Z\r\n');
    expect(ics).toContain('DTEND:20260302T151500Z\r\n');
    expect(ics).toContain('DTSTAMP:20260301T100000Z\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('is a file, not an invitation: no organizer, no attendee', () => {
    const ics = buildCalendarFile(input);
    expect(ics).not.toContain('ORGANIZER');
    expect(ics).not.toContain('ATTENDEE');
  });

  it('writes the join link verbatim as URL, and as the location a calendar opens', () => {
    const ics = buildCalendarFile(input);
    expect(ics).toContain('URL:https://meet.example.com/abc?pwd=a,b;c\r\n');
    expect(ics).toContain('LOCATION:https://meet.example.com/abc?pwd=a\\,b\\;c\r\n');
    expect(buildCalendarFile({ ...input, url: 'javascript:alert(1)' })).not.toContain('URL:');
    expect(buildCalendarFile({ ...input, url: null })).toContain('LOCATION:Online meeting\r\n');
  });

  it('escapes TEXT values', () => {
    expect(buildCalendarFile(input)).toContain('SUMMARY:Design review\\; with notes\\, please\r\n');
  });

  it('folds long lines at 75 octets', () => {
    const ics = buildCalendarFile({ ...input, title: 'x'.repeat(200), location: null, url: null });
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics).not.toContain('LOCATION');
  });
});

describe('calendarFileHref and calendarFileName', () => {
  it('encodes the file into a data URL', () => {
    const href = calendarFileHref(input);
    expect(href.startsWith('data:text/calendar;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(href.split(',').slice(1).join(','))).toContain('UID:bk_123');
  });

  it('names the file after the event', () => {
    expect(calendarFileName('Revisión de diseño')).toBe('revision-de-diseno.ics');
    expect(calendarFileName('***')).toBe('booking.ics');
  });
});
