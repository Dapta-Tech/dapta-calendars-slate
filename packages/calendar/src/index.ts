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
  fromUtc: string;
  toUtc: string;
}

export interface CreateEventInput {
  connectionRef: string;
  title: string;
  description?: string | null;
  startUtc: string;
  endUtc: string;
  attendeeEmails: string[];
  organizerEmail?: string | null;
  /** Request a conferencing link when true. */
  requestConferenceLink?: boolean;
  timeZone?: string | null;
}

export interface CreatedEvent {
  externalEventId: string;
  externalCalendarId?: string | null;
  meetingUrl?: string | null;
}

export interface DeleteEventInput {
  connectionRef: string;
  externalEventId: string;
}

export interface CalendarProvider {
  /** True when a real provider is wired; false disables all calendar effects. */
  readonly enabled: boolean;
  listBusy(input: ListBusyInput): Promise<BusyInterval[]>;
  createEvent(input: CreateEventInput): Promise<CreatedEvent>;
  deleteEvent(input: DeleteEventInput): Promise<void>;
}

/**
 * The OSS default: no external calendar. Returns no busy times and no-ops
 * writes. A fork "just works" without any calendar integration; slots then
 * subtract only local bookings + holds (documented degrade). A private adapter
 * replaces this to subtract real external busy times.
 */
export class DisabledCalendarProvider implements CalendarProvider {
  readonly enabled = false;
  listBusy(): Promise<BusyInterval[]> {
    return Promise.resolve([]);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    return Promise.resolve({ externalEventId: `disabled-${input.connectionRef}`, meetingUrl: null });
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
}

/** In-memory fake for tests: seed busy per connection ref, inspect writes. */
export class InMemoryCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  private busy = new Map<string, BusyInterval[]>();
  readonly created: CreateEventInput[] = [];
  private seq = 0;

  seedBusy(connectionRef: string, intervals: BusyInterval[]): void {
    this.busy.set(connectionRef, intervals);
  }

  listBusy(input: ListBusyInput): Promise<BusyInterval[]> {
    const out: BusyInterval[] = [];
    for (const ref of input.connectionRefs) {
      for (const b of this.busy.get(ref) ?? []) {
        if (b.endUtc > input.fromUtc && b.startUtc < input.toUtc) out.push(b);
      }
    }
    return Promise.resolve(out);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    this.created.push(input);
    return Promise.resolve({ externalEventId: `evt-${++this.seq}`, meetingUrl: null });
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
}
