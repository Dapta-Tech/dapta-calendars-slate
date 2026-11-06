import { describe, expect, it } from 'vitest';
import { defaultEventReminders } from '@slate/types';
import type { Connection, EventType } from '@/lib/admin-api';
import { draftReducer, initialDraft, toPayload, type EventTypeDraft } from './draft';

/**
 * The editor's save is a pure function of its draft. These pin the property
 * the redesign must never break: opening an event and saving it untouched
 * sends back exactly what the event already has — the QA2 fix 2 class of bug
 * (an edit silently resetting notice, buffers or a guard) stays impossible.
 */

const PERSONAL: EventType = {
  id: 'evt-personal',
  memberId: 'm-alex',
  teamId: null,
  slug: 'intro-call',
  title: 'Intro Call',
  description: 'A first conversation.',
  lengthMinutes: 45,
  location: { kind: 'phone', detail: '+57 300 000 0000' },
  hidden: true,
  minimumBookingNotice: 240,
  bookingWindowDays: 30,
  beforeEventBuffer: 10,
  afterEventBuffer: 5,
  slotInterval: 15,
  schedulingType: null,
  requiresConfirmation: true,
  preventDuplicateBookings: true,
  seatsPerTimeSlot: 3,
  bookingFields: [
    { name: 'company', label: 'Company', type: 'text', required: true },
    { name: 'phone', label: 'Phone', type: 'phone', required: false, defaultCountry: 'CO' },
  ],
  reminders: defaultEventReminders(),
  hostMemberIds: [],
  hosts: [],
  scheduleId: 'sched-1',
  conflictCalendarIds: ['cal-1'],
  destinationCalendarId: 'cal-1',
  crmPropertyMappings: {
    hubspot: [{ source: { kind: 'question', name: 'company' }, properties: ['company'] }],
    othercrm: [{ source: { kind: 'attendee', field: 'name' }, properties: ['full_name'] }],
  } as unknown as EventType['crmPropertyMappings'],
  successRedirectUrl: 'https://example.com/thanks',
  successRedirectData: null,
  tracking: { metaPixelId: '1234567890' } as EventType['tracking'],
};

const TEAM: EventType = {
  ...PERSONAL,
  id: 'evt-team',
  memberId: null,
  teamId: 'team-1',
  slug: 'team-demo',
  schedulingType: 'fixed_round_robin',
  rrDistribution: null,
  hostMemberIds: ['m-alex', 'm-jordan'],
  hosts: [
    { memberId: 'm-alex', priority: 2, weight: 100, isFixed: true },
    { memberId: 'm-jordan', priority: 0, weight: 50, isFixed: false },
  ],
  conflictCalendarIds: [],
  destinationCalendarId: null,
} as EventType;

const CONNECTIONS = [
  { id: 'cal-1', checkConflicts: true, isDestination: true },
  { id: 'cal-2', checkConflicts: false, isDestination: false },
] as unknown as Connection[];
const MEMBERS = [
  { memberId: 'm-alex', displayName: 'Alex' },
  { memberId: 'm-jordan', displayName: 'Jordan' },
];

describe('toPayload: an unchanged event saves what it already has', () => {
  it('personal event, CRM wired, tracking shown', () => {
    const d = initialDraft({ initial: PERSONAL, crmProvider: 'hubspot', connections: CONNECTIONS });
    const p = toPayload(d, {
      initial: PERSONAL,
      crmProvider: 'hubspot',
      trackingEnabled: true,
      isTeamEvent: false,
      hasConnections: true,
    });
    expect(p).toEqual({
      id: 'evt-personal',
      title: 'Intro Call',
      slug: 'intro-call',
      description: 'A first conversation.',
      location: { kind: 'phone', detail: '+57 300 000 0000' },
      lengthMinutes: 45,
      minimumBookingNotice: 240,
      bookingWindowDays: 30,
      slotInterval: 15,
      beforeEventBuffer: 10,
      afterEventBuffer: 5,
      seatsPerTimeSlot: 3,
      scheduleId: 'sched-1',
      requiresConfirmation: true,
      preventDuplicateBookings: true,
      hidden: true,
      bookingFields: [
        { name: 'company', label: 'Company', type: 'text', required: true, defaultCountry: undefined, options: undefined },
        { name: 'phone', label: 'Phone', type: 'phone', required: false, defaultCountry: 'CO', options: undefined },
      ],
      reminders: PERSONAL.reminders,
      successRedirectUrl: 'https://example.com/thanks',
      successRedirectData: null,
      tracking: { metaPixelId: '1234567890' },
      crmPropertyMappings: PERSONAL.crmPropertyMappings,
      conflictCalendarIds: ['cal-1'],
      destinationCalendarId: 'cal-1',
    });
  });

  it('personal event, no CRM, no tracking: neither column is touched', () => {
    const d = initialDraft({ initial: PERSONAL, crmProvider: null, connections: CONNECTIONS });
    const p = toPayload(d, {
      initial: PERSONAL,
      crmProvider: null,
      trackingEnabled: false,
      isTeamEvent: false,
      hasConnections: true,
    });
    expect(p).not.toHaveProperty('crmPropertyMappings');
    expect(p).not.toHaveProperty('tracking');
  });

  it('team event: hosts and method travel, calendars and teamId do not', () => {
    const d = initialDraft({ initial: TEAM, crmProvider: null, teamMembers: MEMBERS });
    const p = toPayload(d, {
      initial: TEAM,
      crmProvider: null,
      trackingEnabled: false,
      isTeamEvent: true,
      teamId: 'team-1',
      hasConnections: false,
    });
    expect(p.schedulingType).toBe('fixed_round_robin');
    expect(p.rrDistribution).toBeNull();
    expect(p.hosts).toEqual([
      { memberId: 'm-alex', priority: 2, weight: 100, isFixed: true },
      { memberId: 'm-jordan', priority: 0, weight: 50, isFixed: false },
    ]);
    expect(p).not.toHaveProperty('teamId');
    expect(p).not.toHaveProperty('conflictCalendarIds');
  });

  it('a new team event carries its team', () => {
    const d = initialDraft({ crmProvider: null, teamMembers: MEMBERS });
    const p = toPayload(
      { ...d, title: 'New', slug: 'new' },
      { crmProvider: null, trackingEnabled: false, isTeamEvent: true, teamId: 'team-1', hasConnections: false },
    );
    expect(p.teamId).toBe('team-1');
    expect(p.id).toBeUndefined();
  });
});

describe('the new-event defaults', () => {
  it('match what the editor always created', () => {
    const d = initialDraft({ crmProvider: null, connections: CONNECTIONS });
    expect(d).toMatchObject({
      lengthMinutes: 30,
      minNotice: 120,
      windowDays: '',
      slotInterval: 30,
      beforeBuf: 0,
      afterBuf: 0,
      seats: '',
      scheduleId: '',
      hidden: false,
      reminders: defaultEventReminders(),
      destinationId: 'cal-1',
    });
    expect([...d.conflictIds]).toEqual(['cal-1']);
  });
});

describe('draftReducer', () => {
  const base = initialDraft({ initial: PERSONAL, crmProvider: null });
  it('sets a value and applies an updater', () => {
    const a = draftReducer(base, { type: 'set', key: 'title', value: 'Renamed' });
    expect(a.title).toBe('Renamed');
    const b = draftReducer(a, { type: 'set', key: 'lengthMinutes', value: (n: number) => n + 15 });
    expect(b.lengthMinutes).toBe(60);
  });
  it('returns the same object when nothing changes', () => {
    const same: EventTypeDraft = draftReducer(base, { type: 'set', key: 'title', value: base.title });
    expect(same).toBe(base);
  });
});

describe('toPayload: availability', () => {
  const ctx = { crmProvider: null, trackingEnabled: false, isTeamEvent: false, hasConnections: false };
  const custom = { timeZone: 'UTC', ranges: [{ days: [2], start: '10:00', end: '12:00' }] };

  it('custom hours travel without scheduleId', () => {
    const d = { ...initialDraft({ initial: PERSONAL, crmProvider: null }), availabilitySource: 'custom' as const, customHours: custom };
    const p = toPayload(d, { ...ctx, initial: PERSONAL });
    expect(p.customHours).toEqual(custom);
    expect(p).not.toHaveProperty('scheduleId');
  });

  it('an event with custom hours opens on them, and leaving them sends null', () => {
    const withHours = { ...PERSONAL, scheduleId: null, customHours: custom };
    const d = initialDraft({ initial: withHours, crmProvider: null });
    expect(d.availabilitySource).toBe('custom');
    const p = toPayload({ ...d, availabilitySource: 'working' }, { ...ctx, initial: withHours });
    expect(p).toMatchObject({ customHours: null, scheduleId: null });
  });

  it('working hours send scheduleId null; an event that never had custom hours sends no customHours', () => {
    const d = initialDraft({ initial: { ...PERSONAL, scheduleId: null }, crmProvider: null });
    expect(d.availabilitySource).toBe('working');
    const p = toPayload(d, { ...ctx, initial: { ...PERSONAL, scheduleId: null } });
    expect(p.scheduleId).toBeNull();
    expect(p).not.toHaveProperty('customHours');
  });
});
