import { describe, expect, it } from 'vitest';
import { getMessages } from './i18n';
import { formatBookingLocation, formatLocation } from './location';

const en = getMessages('en');
const es = getMessages('es');

describe('formatLocation', () => {
  it('renders nothing when no location is configured', () => {
    expect(formatLocation(null, en)).toBeNull();
    expect(formatLocation(undefined, en)).toBeNull();
  });

  it('falls back to generic conferencing wording when nothing is injected', () => {
    expect(formatLocation({ kind: 'conferencing' }, en)).toBe('Online meeting');
    expect(formatLocation({ kind: 'conferencing' }, es)).toBe('Reunión en línea');
  });

  it('uses the runtime-injected platform name when the deployment supplies one', () => {
    expect(formatLocation({ kind: 'conferencing' }, en, 'Acme Meet')).toBe('Acme Meet');
    // A blank label is not a label.
    expect(formatLocation({ kind: 'conferencing' }, en, '   ')).toBe('Online meeting');
    expect(formatLocation({ kind: 'conferencing' }, en, null)).toBe('Online meeting');
  });

  it('never lets a typed detail leak onto conferencing', () => {
    expect(formatLocation({ kind: 'conferencing', detail: 'ignored' }, en, 'Acme Meet')).toBe('Acme Meet');
  });

  it('qualifies in-person and phone with their detail', () => {
    expect(formatLocation({ kind: 'in_person', detail: 'Calle 93 #11-20' }, en)).toBe(
      'In person · Calle 93 #11-20',
    );
    expect(formatLocation({ kind: 'phone', detail: '+57 300 000 0000' }, es)).toBe(
      'Llamada telefónica · +57 300 000 0000',
    );
  });

  it('stands alone when the kind carries no detail', () => {
    expect(formatLocation({ kind: 'in_person' }, en)).toBe('In person');
    expect(formatLocation({ kind: 'phone', detail: '  ' }, en)).toBe('Phone call');
  });

  it('shows a custom location exactly as the host wrote it', () => {
    expect(formatLocation({ kind: 'custom', detail: 'We will call you' }, en)).toBe('We will call you');
  });

  it('omits a custom location with nothing written — never leaks the option name', () => {
    // "Custom" / "Personalizado" is editor copy; an invitee must not read it.
    expect(formatLocation({ kind: 'custom' }, en)).toBeNull();
    expect(formatLocation({ kind: 'custom', detail: '  ' }, es)).toBeNull();
  });

  it('never blanks out a detail behind an unknown kind', () => {
    expect(formatLocation({ kind: 'teleport', detail: 'Platform 9¾' }, en)).toBe('Platform 9¾');
    expect(formatLocation({ kind: 'teleport' }, en)).toBeNull();
  });
});

describe('formatBookingLocation — the snapshotted columns', () => {
  it('renders a legacy booking (no kind) from its raw location text', () => {
    expect(formatBookingLocation(null, 'Room 4', en)).toBe('Room 4');
    expect(formatBookingLocation(undefined, 'Room 4', en)).toBe('Room 4');
  });

  it('renders nothing for a legacy booking with no location at all', () => {
    expect(formatBookingLocation(null, null, en)).toBeNull();
    expect(formatBookingLocation(null, '   ', en)).toBeNull();
  });

  it('renders a snapshotted kind the same way the event type does', () => {
    expect(formatBookingLocation('conferencing', null, en, 'Acme Meet')).toBe('Acme Meet');
    expect(formatBookingLocation('in_person', 'HQ', en)).toBe('In person · HQ');
  });
});
