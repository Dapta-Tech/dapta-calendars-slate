import { describe, it, expect } from 'vitest';
import { DisabledCalendarProvider, InMemoryCalendarProvider } from './index';

describe('DisabledCalendarProvider', () => {
  it('is disabled and returns no busy / no-ops writes', async () => {
    const p = new DisabledCalendarProvider();
    expect(p.enabled).toBe(false);
    expect(await p.listBusy({ connectionRefs: ['x'], fromUtc: 'a', toUtc: 'b' })).toEqual([]);
    const evt = await p.createEvent({
      connectionRef: 'x',
      title: 't',
      startUtc: '2026-08-01T14:00:00.000Z',
      endUtc: '2026-08-01T14:30:00.000Z',
      attendeeEmails: [],
    });
    expect(evt.externalEventId).toContain('disabled');
  });
});

describe('InMemoryCalendarProvider', () => {
  it('returns seeded busy overlapping the window and records writes', async () => {
    const p = new InMemoryCalendarProvider();
    p.seedBusy('cal-1', [{ startUtc: '2026-08-01T14:00:00.000Z', endUtc: '2026-08-01T15:00:00.000Z' }]);
    const busy = await p.listBusy({
      connectionRefs: ['cal-1'],
      fromUtc: '2026-08-01T00:00:00.000Z',
      toUtc: '2026-08-02T00:00:00.000Z',
    });
    expect(busy).toHaveLength(1);
    await p.createEvent({
      connectionRef: 'cal-1',
      title: 't',
      startUtc: '2026-08-01T14:00:00.000Z',
      endUtc: '2026-08-01T14:30:00.000Z',
      attendeeEmails: ['a@example.com'],
    });
    expect(p.created).toHaveLength(1);
  });
});
