import { describe, expect, it } from 'vitest';
import {
  LEGACY_CONFERENCING_VALUE,
  LOCATION_DETAIL_MAX,
  LOCATION_KINDS,
  isLocationKind,
  parseEventLocation,
} from './location';

describe('parseEventLocation — the both-shapes parse (C1)', () => {
  it('null / undefined / empty string mean "no location configured"', () => {
    expect(parseEventLocation(null)).toBeNull();
    expect(parseEventLocation(undefined)).toBeNull();
    expect(parseEventLocation('')).toBeNull();
    expect(parseEventLocation('   ')).toBeNull();
  });

  it('coerces the legacy conferencing literal to the conferencing kind', () => {
    expect(parseEventLocation(LEGACY_CONFERENCING_VALUE)).toEqual({ kind: 'conferencing', detail: null });
  });

  it('coerces any other non-empty legacy string to a custom location', () => {
    expect(parseEventLocation('Meeting room 4')).toEqual({ kind: 'custom', detail: 'Meeting room 4' });
    expect(parseEventLocation('Calle 93 #11-20, Bogotá')).toEqual({
      kind: 'custom',
      detail: 'Calle 93 #11-20, Bogotá',
    });
  });

  it('trims a legacy string before storing it as the custom detail', () => {
    expect(parseEventLocation('  Meeting room 4  ')).toEqual({ kind: 'custom', detail: 'Meeting room 4' });
  });

  it('accepts the new object shape for every kind', () => {
    for (const kind of LOCATION_KINDS) {
      expect(parseEventLocation({ kind })).toEqual({ kind, detail: null });
    }
  });

  it('keeps the detail on the kinds that carry one', () => {
    expect(parseEventLocation({ kind: 'in_person', detail: 'Calle 93 #11-20' })).toEqual({
      kind: 'in_person',
      detail: 'Calle 93 #11-20',
    });
    expect(parseEventLocation({ kind: 'phone', detail: '+57 300 000 0000' })).toEqual({
      kind: 'phone',
      detail: '+57 300 000 0000',
    });
    expect(parseEventLocation({ kind: 'custom', detail: 'Ask on the day' })).toEqual({
      kind: 'custom',
      detail: 'Ask on the day',
    });
  });

  it('drops a detail on conferencing — the link is minted at write-out, never typed', () => {
    expect(parseEventLocation({ kind: 'conferencing', detail: 'anything' })).toEqual({
      kind: 'conferencing',
      detail: null,
    });
  });

  it('normalizes a blank or non-string detail to null', () => {
    expect(parseEventLocation({ kind: 'phone', detail: '  ' })).toEqual({ kind: 'phone', detail: null });
    expect(parseEventLocation({ kind: 'phone', detail: null })).toEqual({ kind: 'phone', detail: null });
    expect(parseEventLocation({ kind: 'phone' })).toEqual({ kind: 'phone', detail: null });
    expect(parseEventLocation({ kind: 'phone', detail: 42 })).toEqual({ kind: 'phone', detail: null });
  });

  it('clamps an over-long detail instead of rejecting it', () => {
    // A legacy row (or a direct-SQL write) can exceed the contract cap; the
    // public availability response parses the same schema, so this must
    // degrade rather than 500 the endpoint.
    const long = 'x'.repeat(LOCATION_DETAIL_MAX + 50);
    expect(parseEventLocation(long)?.detail).toHaveLength(LOCATION_DETAIL_MAX);
    expect(parseEventLocation({ kind: 'in_person', detail: long })?.detail).toHaveLength(
      LOCATION_DETAIL_MAX,
    );
  });

  it('rejects an unknown kind rather than inventing one', () => {
    expect(parseEventLocation({ kind: 'teleport' })).toBeNull();
    expect(parseEventLocation({ kind: 'teleport', detail: 'x' })).toBeNull();
    expect(parseEventLocation({})).toBeNull();
  });

  it('rejects shapes that are neither a string nor a kind object', () => {
    expect(parseEventLocation(42)).toBeNull();
    expect(parseEventLocation(true)).toBeNull();
    expect(parseEventLocation([])).toBeNull();
    expect(parseEventLocation([LEGACY_CONFERENCING_VALUE])).toBeNull();
  });

  it('is idempotent — re-parsing its own output changes nothing', () => {
    for (const input of [LEGACY_CONFERENCING_VALUE, 'Room 4', { kind: 'in_person', detail: 'HQ' }]) {
      const once = parseEventLocation(input);
      expect(parseEventLocation(once)).toEqual(once);
    }
  });
});

describe('isLocationKind', () => {
  it('accepts every declared kind and nothing else', () => {
    for (const kind of LOCATION_KINDS) expect(isLocationKind(kind)).toBe(true);
    expect(isLocationKind('teleport')).toBe(false);
    expect(isLocationKind(null)).toBe(false);
    expect(isLocationKind(undefined)).toBe(false);
    expect(isLocationKind(1)).toBe(false);
  });
});
