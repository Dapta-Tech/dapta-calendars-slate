/**
 * @slate/calendar — the CalendarProvider PORT. The engine/availability depends
 * ONLY on this interface: it asks for busy times when computing slots, and asks
 * for event write/delete when a booking is created/cancelled. NO external
 * vendor is named anywhere in this public package (R15) — a concrete adapter
 * lives in a private overlay. The OSS default is `disabled`: it returns no busy
 * and no-ops writes, so a bare fork runs with no calendar configured.
 */

export interface BusyInterval {
  startUtc: string;
  endUtc: string;
}

export interface ListBusyInput {
  /** Opaque connection references (never OAuth tokens) to read busy from. */
  connectionRefs: string[];
  /** Provider calendar IDs beneath the supplied connection (MVP batch discovery path). */
  calendarIds?: string[];
  fromUtc: string;
  toUtc: string;
}

/** Days of the week a repeating event falls on, Monday first. */
export type CalendarWeekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

/**
 * How a repeating event repeats (ADR 0012). The same rule twice: as fields, for
 * a backend whose provider takes a pattern (frequency, interval, days, range),
 * and as an RFC 5545 RRULE, for one that takes that. Every occurrence starts at
 * the first one's LOCAL time in `timeZone` on its own date, so the provider must
 * be given that zone with the event, never only UTC instants.
 */
export interface EventRecurrence {
  /** RFC 5545 RRULE value without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=WE`. */
  rrule: string;
  frequency: 'daily' | 'weekly';
  /** Every `interval` days or weeks. */
  interval: number;
  /** Weekly: the days it falls on, Monday first. Daily: empty. */
  weekdays: CalendarWeekday[];
  /** Occurrences in all, the first one included; null for no count. */
  count: number | null;
  /** The last date it may fall on, YYYY-MM-DD in `timeZone`, inclusive; null for none. */
  untilDate: string | null;
  /** The first occurrence's date, YYYY-MM-DD in `timeZone`. */
  startDate: string;
  /** IANA zone the series' wall clock is kept in. */
  timeZone: string;
  /**
   * Original starts (ISO-8601 UTC) of occurrences the series must NOT have:
   * dates dCal skipped because something else was there. Empty for none.
   */
  excludedStartsUtc: string[];
}

export interface CreateEventInput {
  connectionRef: string;
  /** Optional provider-calendar target discovered beneath the connection. */
  calendarId?: string;
  title: string;
  /**
   * The event body, PLAIN TEXT (line breaks as `\n`): the booking's rendered
   * description and, on a co-host's copy, the join line. Null or absent: none.
   * Values typed by the invitee arrive without `<` or `>`, but the text is not
   * HTML; a backend whose provider takes HTML must send it as text.
   */
  description?: string | null;
  startUtc: string;
  endUtc: string;
  attendeeEmails: string[];
  organizerEmail?: string | null;
  /** Request a conferencing link when true. */
  requestConferenceLink?: boolean;
  timeZone?: string | null;
  /**
   * Whether the calendar provider should email the attendees itself (its own
   * invitation, update or cancellation). `false` when this service already
   * emails the invitee its own invite (.ics) for this change, so the guest is
   * not invited twice. Absent: the backend's own default.
   */
  sendInvitations?: boolean;
  /**
   * Present: create ONE repeating event, not one per date. `startUtc`/`endUtc`
   * are its first occurrence. Sent only to a connection whose `features` say
   * `recurrence`: a backend that ignored it would write one lone event.
   */
  recurrence?: EventRecurrence | null;
}

export interface CreatedEvent {
  externalEventId: string;
  externalCalendarId?: string | null;
  meetingUrl?: string | null;
}

export interface DeleteEventInput {
  connectionRef: string;
  externalEventId: string;
  /**
   * Whether the calendar provider should email the attendees itself (its own
   * invitation, update or cancellation). `false` when this service already
   * emails the invitee its own invite (.ics) for this change, so the guest is
   * not invited twice. Absent: the backend's own default.
   */
  sendInvitations?: boolean;
  /**
   * Present: cancel ONE occurrence of the repeating event `externalEventId`,
   * the one that ORIGINALLY started at this instant (ISO-8601 UTC), even if it
   * was moved since. The rest of the series stays. Absent: delete the event,
   * every occurrence of a series included.
   */
  occurrenceStartUtc?: string | null;
}

/**
 * Move an EXISTING remote event to a new time (a true reschedule). Keeps the same
 * `externalEventId` so attendees see the event MOVE rather than a cancel + a fresh
 * invite, and no duplicate is created.
 */
export interface UpdateEventInput {
  connectionRef: string;
  /** Provider-calendar target used when the connection exposes many calendars. */
  calendarId?: string;
  externalEventId: string;
  title: string;
  /**
   * The event body after the move, plain text as on create. ABSENT leaves the
   * event's body as it is (a booking without a description template never
   * sends one); a string replaces it, so a time written in it moves too, and
   * an empty string clears it (its template was removed or now prints nothing).
   */
  description?: string | null;
  startUtc: string;
  endUtc: string;
  attendeeEmails: string[];
  organizerEmail?: string | null;
  /**
   * Request a conferencing link on the moved event. Set on the ORGANIZER's
   * destination only, so a team booking keeps exactly one room across a
   * reschedule. A backend that keeps the same room simply echoes it back (or
   * returns null, which is never persisted over a good stored URL).
   */
  requestConferenceLink?: boolean;
  timeZone?: string | null;
  /**
   * Whether the calendar provider should email the attendees itself (its own
   * invitation, update or cancellation). `false` when this service already
   * emails the invitee its own invite (.ics) for this change, so the guest is
   * not invited twice. Absent: the backend's own default.
   */
  sendInvitations?: boolean;
  /**
   * Present: move ONE occurrence of the repeating event `externalEventId`, the
   * one that ORIGINALLY started at this instant (ISO-8601 UTC), to
   * `startUtc`/`endUtc`. The rest of the series stays where it is.
   */
  occurrenceStartUtc?: string | null;
  /**
   * Present: replace the series' rule. `startUtc`/`endUtc` are then its first
   * occurrence. Used to end a series early (an `untilDate`) and to move a whole
   * series that has not started. Never sent with `occurrenceStartUtc`.
   */
  recurrence?: EventRecurrence | null;
}

/**
 * What a connection's backend can do beyond writing single events (ADR 0012).
 * Asked per connection, because one deployment can reach calendar providers
 * that differ. A backend that says nothing has the basics only.
 */
export interface CalendarFeatures {
  /** One repeating event per series: `recurrence` on create and update, `occurrenceStartUtc` on update and delete. */
  recurrence: boolean;
  /** Other people's busy times through this connection (`listAttendeeBusy`). */
  attendeeFreeBusy: boolean;
  /** The calendar creates a video room when `requestConferenceLink` is true. */
  conferencing: boolean;
}

/** What a backend has when it declares nothing: single events, and the room the contract has always asked for. */
export const BASIC_CALENDAR_FEATURES: Readonly<CalendarFeatures> = Object.freeze({
  recurrence: false,
  attendeeFreeBusy: false,
  conferencing: true,
});

/** A connection's features: none at all with no provider, the basics plus what the backend declares otherwise. */
export function calendarFeatures(provider: CalendarProvider, connectionRef: string): CalendarFeatures {
  if (!provider.enabled) return { recurrence: false, attendeeFreeBusy: false, conferencing: false };
  return { ...BASIC_CALENDAR_FEATURES, ...(provider.features?.(connectionRef) ?? {}) };
}

/** Whose busy times to read through a host's connection, and when. */
export interface AttendeeBusyInput {
  connectionRef: string;
  /** The provider calendar beneath the connection that asks (the host's). */
  calendarId?: string;
  /** The people, by email. */
  emails: string[];
  fromUtc: string;
  toUtc: string;
}

/**
 * Why a person's busy times are not known. `not_shared`: the provider will not
 * show that calendar to this connection (another organization, sharing off).
 * `not_found`: no calendar answers to that address. `error`: the provider
 * answered with an error for that person.
 */
export type AttendeeBusyUnknown = 'not_shared' | 'not_found' | 'error';

/** One person's busy times, or why they are not known. Unknown is never free. */
export interface AttendeeBusy {
  email: string;
  /** Busy intervals, or null when not known. */
  busy: BusyInterval[] | null;
  unknown?: AttendeeBusyUnknown | null;
}

/** One calendar exposed by a connected account (for the post-connect pick). */
export interface CalendarSummary {
  /** Opaque calendar ref the provider round-trips (never an OAuth token). */
  id: string;
  name: string;
  primaryEmail?: string | null;
  /** The connected account's own profile photo, when the backend reports one.
   *  OPTIONAL: a backend that omits it is valid, and the surfaces that draw an
   *  avatar fall back exactly as they do with no connection at all. */
  avatarUrl?: string | null;
  /** The account's default calendar — a sensible default destination. */
  isPrimary?: boolean;
  readOnly?: boolean;
  accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader' | 'none';
  source?: 'primary' | 'owned' | 'shared' | 'subscribed' | 'delegated';
  capabilities?: {
    canRead: boolean;
    canReadFreeBusy: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
  };
}

/** Health of a single connection, surfaced in the connections UI. */
export interface ConnectionHealth {
  ok: boolean;
  /** Human-readable detail (e.g. "Connected", "Reauthorization required"). */
  detail: string;
}

export interface CalendarProvider {
  /** True when a real provider is wired; false disables all calendar effects. */
  readonly enabled: boolean;
  /**
   * Display name for the conferencing this provider mints, shown to the host
   * when they pick the `conferencing` location kind. THE REPO NAMES NOBODY
   * (R15): a private overlay supplies this at runtime, and a bare fork leaves it
   * null so the UI shows only generic wording (ADR 0008). Optional so an overlay
   * written before this existed still satisfies the port.
   */
  readonly conferencingLabel?: string | null;
  listBusy(input: ListBusyInput): Promise<BusyInterval[]>;
  createEvent(input: CreateEventInput): Promise<CreatedEvent>;
  /** Move an existing event in place (true reschedule). */
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent>;
  deleteEvent(input: DeleteEventInput): Promise<void>;
  /** List the calendars a connected account exposes (post-connect pick). */
  listCalendars(connectionRef: string): Promise<CalendarSummary[]>;
  /** Probe a connection's live health (drives the per-row status + ping). */
  checkConnection(connectionRef: string): Promise<ConnectionHealth>;
  /**
   * Optional: what this connection's backend can do beyond the basics. Read
   * through `calendarFeatures`, which fills in what is not said. Synchronous:
   * a backend knows it from the connection, without a call.
   */
  features?(connectionRef: string): Partial<CalendarFeatures>;
  /**
   * Optional: other people's busy times, read through the host's connection
   * (only when `features` says `attendeeFreeBusy`). Every email asked for comes
   * back, with its busy times or why they are not known; a person the provider
   * will not show is unknown, NEVER free.
   */
  listAttendeeBusy?(input: AttendeeBusyInput): Promise<AttendeeBusy[]>;
}

/**
 * The OSS default: no external calendar. Returns no busy times and no-ops
 * writes. A fork "just works" without any calendar integration; slots then
 * subtract only local bookings + holds (documented degrade). A private adapter
 * replaces this to subtract real external busy times.
 */
export class DisabledCalendarProvider implements CalendarProvider {
  readonly enabled = false;
  /** No provider ⇒ no conferencing to name. */
  readonly conferencingLabel = null;
  listBusy(): Promise<BusyInterval[]> {
    return Promise.resolve([]);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    return Promise.resolve({
      externalEventId: `disabled-${input.connectionRef}`,
      meetingUrl: null,
    });
  }
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    return Promise.resolve({
      externalEventId: input.externalEventId,
      meetingUrl: null,
    });
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({
      ok: false,
      detail: 'No external calendar provider configured.',
    });
  }
}

/** In-memory fake for tests: seed busy per connection ref, inspect writes. */
export class InMemoryCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  private busy = new Map<string, BusyInterval[]>();
  private calendars = new Map<string, CalendarSummary[]>();
  private calendarBusy = new Map<string, BusyInterval[]>();
  readonly created: CreateEventInput[] = [];
  readonly updated: UpdateEventInput[] = [];
  readonly deleted: DeleteEventInput[] = [];
  readonly attendeeReads: AttendeeBusyInput[] = [];
  /** What `features` answers for every connection (the basics until a spec says otherwise). */
  declaredFeatures: Partial<CalendarFeatures> = {};
  /** True: a create that asks for a room gets one (`https://video.example/<event id>`). */
  mintRooms = false;
  private attendeeBusy = new Map<string, BusyInterval[] | AttendeeBusyUnknown>();
  private seq = 0;

  seedBusy(connectionRef: string, intervals: BusyInterval[]): void {
    this.busy.set(connectionRef, intervals);
  }

  /** One person's busy times as any connection reads them, or why they are not known. */
  seedAttendeeBusy(email: string, busy: BusyInterval[] | AttendeeBusyUnknown): void {
    this.attendeeBusy.set(email.trim().toLowerCase(), busy);
  }

  features(): Partial<CalendarFeatures> {
    return this.declaredFeatures;
  }

  listAttendeeBusy(input: AttendeeBusyInput): Promise<AttendeeBusy[]> {
    this.attendeeReads.push(input);
    return Promise.resolve(
      input.emails.map((email) => {
        const seeded = this.attendeeBusy.get(email.trim().toLowerCase()) ?? [];
        if (typeof seeded === 'string') return { email, busy: null, unknown: seeded };
        return { email, busy: seeded.filter((b) => b.endUtc > input.fromUtc && b.startUtc < input.toUtc) };
      }),
    );
  }

  seedCalendars(connectionRef: string, calendars: CalendarSummary[]): void {
    this.calendars.set(connectionRef, calendars);
  }

  seedCalendarBusy(connectionRef: string, calendarId: string, intervals: BusyInterval[]): void {
    this.calendarBusy.set(`${connectionRef}\u0000${calendarId}`, intervals);
  }

  listBusy(input: ListBusyInput): Promise<BusyInterval[]> {
    const out: BusyInterval[] = [];
    for (const ref of input.connectionRefs) {
      const sources = input.calendarIds?.length
        ? input.calendarIds.map((calendarId) => this.calendarBusy.get(`${ref}\u0000${calendarId}`) ?? [])
        : [this.busy.get(ref) ?? []];
      for (const intervals of sources) {
        for (const b of intervals) {
          if (b.endUtc > input.fromUtc && b.startUtc < input.toUtc) out.push(b);
        }
      }
    }
    return Promise.resolve(out);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    this.created.push(input);
    const externalEventId = `evt-${++this.seq}`;
    return Promise.resolve({
      externalEventId,
      meetingUrl: this.mintRooms && input.requestConferenceLink ? `https://video.example/${externalEventId}` : null,
    });
  }
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    this.updated.push(input);
    // A move keeps the same external event id.
    return Promise.resolve({
      externalEventId: input.externalEventId,
      meetingUrl: null,
    });
  }
  deleteEvent(input: DeleteEventInput): Promise<void> {
    this.deleted.push(input);
    return Promise.resolve();
  }
  listCalendars(connectionRef: string): Promise<CalendarSummary[]> {
    return Promise.resolve(this.calendars.get(connectionRef) ?? []);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}
