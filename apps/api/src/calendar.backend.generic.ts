/**
 * The COMMITTED default calendar backend: a clean, vendor-neutral REST contract
 * plus a static-bearer token source. This is what a self-hoster implements on
 * their own calendar service, and what the adapter's unit tests exercise. It
 * names no vendor (R15). A private overlay replaces `wire`/`tokenSource` to talk
 * to a real integration platform; nothing here changes.
 *
 * The contract (all JSON, `Authorization: Bearer <token>`):
 *   POST   /v1/free-busy                                 → { busy: [{startUtc,endUtc}] }
 *
 * FREE-BUSY WINDOW. The requested range can be up to **60 days** wide — the
 * public availability read's own cap, and what the booking page's month
 * calendar asks for so a visitor can page through months without a refetch.
 * A backend that rejects or truncates a range that wide will make public
 * booking pages show no times at all, because the free-busy path is
 * FAIL-CLOSED by design: an error there returns zero slots rather than slots
 * that might already be taken. Accept 60 days, or page the range internally.
 * The number itself is `MAX_AVAILABILITY_WINDOW_DAYS` in `@slate/types` — one
 * definition shared by every availability path (#136).
 *   POST   /v1/events                                    → { externalEventId, externalCalendarId?, meetingUrl? }
 *   PATCH  /v1/events/:externalEventId                   → { externalEventId, ... }
 *
 * CONFERENCING (both POST and PATCH). The request body carries
 * `requestConferenceLink: boolean`. When true, create a conferencing room and
 * return its join URL as `meetingUrl`; when false or absent, create none.
 *   - It is set on AT MOST ONE destination per booking — the organizer's — so a
 *     team booking gets one room, not one per host. Co-hosts' events arrive with
 *     `requestConferenceLink: false` and the organizer's URL already in
 *     `description`; do not mint a competing room for them.
 *   - On PATCH (a reschedule) return `meetingUrl` only if the room actually
 *     changed. Returning `null` is the right answer for a backend that keeps the
 *     same room across a move: a null NEVER overwrites the stored URL.
 *
 * DESCRIPTION (both POST and PATCH). `description` is the event body as PLAIN
 * TEXT (`\n` line breaks): the booking's description rendered from the event
 * type's template, and on a co-host's copy the join line. Write it as text,
 * never as HTML. On PATCH, an absent `description` leaves the body unchanged,
 * a string replaces it and an empty string clears it.
 *
 * GUESTS (both POST and PATCH). On the organizer's own calendar,
 * `attendeeEmails` lists the ORGANIZER FIRST (`organizerEmail`, the owner of the
 * calendar being written), then the invitee(s), then any co-hosts, each address
 * once: add them all as attendees, in that order, so the event shows its host.
 * On a co-host's copy the organizer is not in the list. Do not send an
 * invitation to the address that owns the calendar you are writing to.
 *
 * INVITATIONS (POST, PATCH and DELETE). `sendInvitations: false` means this
 * service emails the invitee its own invite (.ics) for this change: write the
 * event WITHOUT the provider's own invitation, update or cancellation email,
 * or the guest is invited twice. `true` asks for them; absent leaves it to the
 * backend. POST and PATCH carry it in the body, DELETE as `?sendInvitations=`.
 *   DELETE /v1/connections/:ref/events/:externalEventId  → 204
 *   GET    /v1/connections/:ref/calendars                → { calendars: [{id,name,primaryEmail?,avatarUrl?,isPrimary?}] }
 *   GET    /v1/connections/:ref                          → { ok, detail }
 *   POST   /v1/connect                                   → { connectUrl }
 *
 * REPEATING EVENTS (ADR 0012), only once the deployment says the backend does
 * them (CALENDAR_BACKEND_FEATURES=recurrence): a backend that ignored these
 * fields would write one lone event where the host asked for a series.
 *   - POST /v1/events with `recurrence` ({ rrule, frequency, interval,
 *     weekdays, count, untilDate, startDate, timeZone, excludedStartsUtc })
 *     creates ONE repeating event whose first occurrence is startUtc/endUtc.
 *     Its occurrences keep the first one's local time in `recurrence.timeZone`;
 *     the dates in `excludedStartsUtc` (original starts) are left out.
 *   - PATCH /v1/events/:id with `occurrenceStartUtc` moves ONE occurrence (the
 *     one that originally started then) to startUtc/endUtc; with `recurrence`
 *     it replaces the series' rule (an earlier end, or a whole series moved),
 *     startUtc/endUtc being its new first occurrence.
 *   - DELETE ...?occurrenceStartUtc=<ISO> cancels ONE occurrence; without it
 *     the whole event, every occurrence, is deleted.
 *
 * OTHER PEOPLE'S BUSY TIMES (CALENDAR_BACKEND_FEATURES=attendee-free-busy):
 *   POST /v1/free-busy/attendees { connectionRef, calendarId?, emails, fromUtc, toUtc }
 *     → { calendars: [{ email, busy?: [{startUtc,endUtc}], unknown?: 'not_shared'|'not_found'|'error' }] }
 *   One entry per email asked. A calendar the provider will not show is
 *   `unknown`, never an empty busy list: an empty list means free.
 *
 * `connectionRef` is opaque: the contract only ever echoes it back.
 */
import type {
  AttendeeBusy,
  AttendeeBusyInput,
  BusyInterval,
  CalendarFeatures,
  CalendarSummary,
  ConnectionHealth,
  CreateEventInput,
  CreatedEvent,
  DeleteEventInput,
  ListBusyInput,
  UpdateEventInput,
} from '@slate/calendar';
import type {
  CalendarTokenSource,
  CalendarWire,
  ConnectStart,
  DiscoveredConnection,
  WireRequest,
} from './calendar.http-provider';

function enc(ref: string): string {
  return encodeURIComponent(ref);
}

/** `?a=1&b=2` from the values given, or '' when there are none. */
function query(params: Record<string, string | null>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** A 200 whose body is not the contract's shape. Not retried: the same backend
 *  gives the same answer, and the read must fail closed now. */
export class CalendarBodyError extends Error {
  override readonly name = 'CalendarBodyError';
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

/** The features a deployment says its generic backend has (CALENDAR_BACKEND_FEATURES). */
export function genericBackendFeatures(raw: string | undefined | null): Partial<CalendarFeatures> {
  const said = new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return { recurrence: said.has('recurrence'), attendeeFreeBusy: said.has('attendee-free-busy') };
}

export class GenericRestWire implements CalendarWire {
  constructor(private readonly declared: Partial<CalendarFeatures> = {}) {}

  features(): Partial<CalendarFeatures> {
    return this.declared;
  }

  listAttendeeBusy(input: AttendeeBusyInput): WireRequest {
    return {
      method: 'POST',
      path: '/v1/free-busy/attendees',
      scope: 'tenant',
      subject: input.connectionRef,
      body: {
        connectionRef: input.connectionRef,
        ...(input.calendarId ? { calendarId: input.calendarId } : {}),
        emails: input.emails,
        fromUtc: input.fromUtc,
        toUtc: input.toUtc,
      },
    };
  }

  /**
   * Each email asked comes back, FAIL-CLOSED per person: an entry missing, or
   * one whose busy list cannot be read, is unknown. A body that is not the
   * contract's shape throws, and the caller reports everyone as unknown.
   */
  parseAttendeeBusy(raw: unknown, input: AttendeeBusyInput): AttendeeBusy[] {
    const cals = asRecord(raw)['calendars'];
    if (!Array.isArray(cals)) throw new CalendarBodyError('no calendars list');
    const byEmail = new Map<string, Record<string, unknown>>();
    for (const c of cals.map(asRecord)) {
      if (typeof c['email'] === 'string') byEmail.set(c['email'].trim().toLowerCase(), c);
    }
    return input.emails.map((email): AttendeeBusy => {
      const c = byEmail.get(email.trim().toLowerCase());
      if (!c) return { email, busy: null, unknown: 'error' };
      const unknown = c['unknown'];
      if (unknown === 'not_shared' || unknown === 'not_found' || unknown === 'error') return { email, busy: null, unknown };
      if (unknown != null || !Array.isArray(c['busy'])) return { email, busy: null, unknown: 'error' };
      try {
        return { email, busy: this.parseBusy({ busy: c['busy'] }) };
      } catch {
        return { email, busy: null, unknown: 'error' };
      }
    });
  }

  listBusy(input: ListBusyInput): WireRequest {
    return {
      method: 'POST',
      path: '/v1/free-busy',
      scope: 'tenant',
      body: {
        connectionRefs: input.connectionRefs,
        ...(input.calendarIds ? { calendarIds: input.calendarIds } : {}),
        fromUtc: input.fromUtc,
        toUtc: input.toUtc,
      },
    };
  }
  /**
   * FAILS CLOSED. An answer this cannot read throws, and the availability read
   * withholds the month with `CALENDAR_UNAVAILABLE`. It used to return `[]` for
   * a body with no `busy` list and drop entries it could not read, and an empty
   * list means "free all month": a backend answering 200 with the wrong shape
   * had every busy time offered to visitors. The private overlay's parser
   * already refuses these; this is the same rule on the public wire. The error
   * names the defect only, never the body.
   */
  parseBusy(raw: unknown): BusyInterval[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CalendarBodyError('not an object');
    const busy = (raw as Record<string, unknown>)['busy'];
    if (!Array.isArray(busy)) throw new CalendarBodyError('no busy list');
    return busy.map((entry) => {
      const b = asRecord(entry);
      const startUtc = b['startUtc'];
      const endUtc = b['endUtc'];
      if (typeof startUtc !== 'string' || typeof endUtc !== 'string')
        throw new CalendarBodyError('busy entry without times');
      const startMs = Date.parse(startUtc);
      const endMs = Date.parse(endUtc);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new CalendarBodyError('busy entry with unreadable times');
      // Reversed is malformed. Zero-length is not: it blocks no time, and
      // refusing it would withhold a healthy calendar's month.
      if (endMs < startMs) throw new CalendarBodyError('busy entry that ends before it starts');
      return { startUtc, endUtc };
    });
  }

  createEvent(input: CreateEventInput): WireRequest {
    return {
      method: 'POST',
      path: '/v1/events',
      scope: 'tenant',
      subject: input.connectionRef,
      body: input,
    };
  }
  updateEvent(input: UpdateEventInput): WireRequest {
    return {
      method: 'PATCH',
      path: `/v1/events/${enc(input.externalEventId)}`,
      scope: 'tenant',
      subject: input.connectionRef,
      body: input,
    };
  }
  parseEvent(raw: unknown): CreatedEvent {
    const r = asRecord(raw);
    const id = r['externalEventId'];
    if (typeof id !== 'string' || !id) {
      throw new Error('calendar backend returned no externalEventId');
    }
    return {
      externalEventId: id,
      externalCalendarId: typeof r['externalCalendarId'] === 'string' ? r['externalCalendarId'] : null,
      meetingUrl: typeof r['meetingUrl'] === 'string' ? r['meetingUrl'] : null,
    };
  }

  deleteEvent(input: DeleteEventInput): WireRequest {
    return {
      method: 'DELETE',
      path:
        `/v1/connections/${enc(input.connectionRef)}/events/${enc(input.externalEventId)}` +
        query({
          sendInvitations: typeof input.sendInvitations === 'boolean' ? String(input.sendInvitations) : null,
          occurrenceStartUtc: input.occurrenceStartUtc ?? null,
        }),
      scope: 'tenant',
      subject: input.connectionRef,
    };
  }

  listCalendars(connectionRef: string): WireRequest {
    return {
      method: 'GET',
      path: `/v1/connections/${enc(connectionRef)}/calendars`,
      scope: 'tenant',
      subject: connectionRef,
    };
  }
  parseCalendars(raw: unknown, _connectionRef: string): CalendarSummary[] {
    const cals = asRecord(raw)['calendars'];
    if (!Array.isArray(cals)) return [];
    return cals
      .map((c) => asRecord(c))
      .filter((c) => typeof c['id'] === 'string')
      .map((c) => ({
        id: String(c['id']),
        name: typeof c['name'] === 'string' ? c['name'] : String(c['id']),
        primaryEmail: typeof c['primaryEmail'] === 'string' ? c['primaryEmail'] : null,
        avatarUrl: typeof c['avatarUrl'] === 'string' ? c['avatarUrl'] : null,
        isPrimary: c['isPrimary'] === true,
        readOnly: c['readOnly'] !== false,
        accessRole:
          c['accessRole'] === 'owner' ||
          c['accessRole'] === 'writer' ||
          c['accessRole'] === 'reader' ||
          c['accessRole'] === 'freeBusyReader'
            ? c['accessRole']
            : 'none',
        source:
          c['source'] === 'primary' ||
          c['source'] === 'owned' ||
          c['source'] === 'subscribed' ||
          c['source'] === 'delegated'
            ? c['source']
            : 'shared',
        capabilities: {
          canRead: asRecord(c['capabilities'])['canRead'] !== false,
          canReadFreeBusy: asRecord(c['capabilities'])['canReadFreeBusy'] !== false,
          canCreate: asRecord(c['capabilities'])['canCreate'] === true,
          canUpdate: asRecord(c['capabilities'])['canUpdate'] === true,
          canDelete: asRecord(c['capabilities'])['canDelete'] === true,
        },
      }));
  }

  checkConnection(connectionRef: string): WireRequest {
    return {
      method: 'GET',
      path: `/v1/connections/${enc(connectionRef)}`,
      scope: 'tenant',
      subject: connectionRef,
    };
  }
  parseHealth(raw: unknown): ConnectionHealth {
    const r = asRecord(raw);
    const ok = r['ok'] === true;
    return {
      ok,
      detail: typeof r['detail'] === 'string' ? r['detail'] : ok ? 'Connected' : 'Not connected',
    };
  }

  startConnect(provider: string, tenantKey: string): WireRequest {
    return {
      method: 'POST',
      path: '/v1/connect',
      scope: 'admin',
      subject: tenantKey,
      body: { provider, tenantKey },
    };
  }
  parseConnectStart(raw: unknown, token: string): ConnectStart {
    const url = asRecord(raw)['connectUrl'];
    if (typeof url !== 'string' || !url) throw new Error('calendar backend returned no connectUrl');
    return { token, connectUrl: url };
  }

  discoverConnections(tenantKey: string, provider: string): WireRequest {
    const qs = `tenantKey=${enc(tenantKey)}&provider=${enc(provider)}`;
    return {
      method: 'GET',
      path: `/v1/connect/connections?${qs}`,
      scope: 'admin',
      subject: tenantKey,
    };
  }
  parseDiscovered(raw: unknown, _tenantKey: string, _provider: string): DiscoveredConnection[] {
    const conns = asRecord(raw)['connections'];
    if (!Array.isArray(conns)) return [];
    return (
      conns
        .map((c) => asRecord(c))
        .filter((c) => typeof c['connectionRef'] === 'string')
        // Hosted connect screens may create a connection shell BEFORE the user
        // authorizes. If the backend reports a connected flag, only accept
        // fully-authorized connections — otherwise list-and-diff would record a
        // never-authorized account as connected. Absent flag = assumed live.
        .filter((c) => c['connected'] !== false)
        .map((c) => ({
          connectionRef: String(c['connectionRef']),
          provider: typeof c['provider'] === 'string' ? c['provider'] : 'unknown',
          primaryEmail: typeof c['primaryEmail'] === 'string' ? c['primaryEmail'] : null,
          avatarUrl: typeof c['avatarUrl'] === 'string' ? c['avatarUrl'] : null,
          name: typeof c['name'] === 'string' ? c['name'] : null,
        }))
    );
  }
}

/** A static bearer token from env — the OSS/self-host default (no minting). */
export class StaticTokenSource implements CalendarTokenSource {
  constructor(private readonly token: string) {}
  mint(): Promise<string> {
    return Promise.resolve(this.token);
  }
}
