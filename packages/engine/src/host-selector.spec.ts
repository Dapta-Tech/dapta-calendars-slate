import { HostCandidate, selectLuckyHost } from './host-selector';

const host = (memberId: string, over: Partial<HostCandidate> = {}): HostCandidate => ({
  memberId,
  bookingCount: 0,
  ...over,
});

describe('selectLuckyHost', () => {
  it('returns null for an empty pool', () => {
    expect(selectLuckyHost([])).toBeNull();
  });

  it('prefers the highest-priority host outright', () => {
    const picked = selectLuckyHost([
      host('a', { priority: 0, bookingCount: 0 }),
      host('b', { priority: 5, bookingCount: 99 }), // busiest but top priority
    ]);
    expect(picked?.memberId).toBe('b');
  });

  it('among equal priority, picks the least-loaded (weight-normalized)', () => {
    const picked = selectLuckyHost([
      host('a', { bookingCount: 10, weight: 100 }), // load 0.10
      host('b', { bookingCount: 15, weight: 200 }), // load 0.075 → wins
    ]);
    expect(picked?.memberId).toBe('b');
  });

  it('tie-breaks equal load by least-recently-booked', () => {
    const picked = selectLuckyHost([
      host('a', { bookingCount: 1, lastBookedAt: new Date('2026-07-01T00:00:00Z') }),
      host('b', { bookingCount: 1, lastBookedAt: new Date('2026-06-01T00:00:00Z') }), // staler → wins
    ]);
    expect(picked?.memberId).toBe('b');
  });

  it('treats a never-booked host as the most stale', () => {
    const picked = selectLuckyHost([
      host('a', { bookingCount: 0, lastBookedAt: new Date('2026-07-01T00:00:00Z') }),
      host('b', { bookingCount: 0, lastBookedAt: null }), // never booked → wins
    ]);
    expect(picked?.memberId).toBe('b');
  });

  it('is deterministic on a full tie (stable by memberId)', () => {
    const pool = [host('z'), host('a'), host('m')];
    expect(selectLuckyHost(pool)?.memberId).toBe('a');
    expect(selectLuckyHost([...pool].reverse())?.memberId).toBe('a');
  });

  it('defaults missing weight to 100', () => {
    const picked = selectLuckyHost([
      host('a', { bookingCount: 1 }), // weight→100, load 0.01
      host('b', { bookingCount: 3, weight: 100 }), // load 0.03
    ]);
    expect(picked?.memberId).toBe('a');
  });
});
