'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import {
  detectTimeZone,
  formatBookingLocation,
  formatDayLong,
  formatLocation,
  formatTimeRange,
  getMessages,
  readableZone,
  isReservedFieldName,
  isValidTimeZone,
  monthKeyOf,
  shiftMonth,
  t,
  validateBookingFieldValue,
  weekStartsOnFor,
  type DisplaySlot,
  type Slot,
} from '@slate/shared';
import {
  BookingConfirmation,
  BookingStage,
  ChoosingFrame,
  ChosenTime,
  EventPanel,
  GrowthCta,
  MonthCalendar,
  TimesColumn,
  type BookingStep,
} from '@/components/booking-page-parts';

/** Mirror of the server's attendee-email rule: catches the 400 before a
 *  round-trip, so a typo never costs the visitor their filled-in form. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import type { BookingField } from '@slate/types';
import {
  bookAction,
  meetingLinkAction,
  releaseAction,
  reserveAction,
} from '@/app/[accountCode]/[handle]/[slug]/actions';
import { classifyBookingFailure } from '@/lib/booking-failure';
import type { BookResult } from '@/lib/api';
import { signupHref } from '@/lib/growth';
import { ZonePicker } from '@/components/zone-picker';
import { PhoneField, isPhoneValueTooShort } from '@/components/ui/phone-field';
import { postBookingScheduled } from '@/lib/embed-messages';
import { track } from '@/lib/analytics/port';
import { calendarFileHref, calendarFileName } from '@/lib/ics';
import { useBookingMonth } from '@/lib/use-booking-month';
import { useLateMeetingLink } from '@/lib/use-late-meeting-link';
import { horizonMonthKey } from '@/lib/availability-window';
import { useProgressiveSlots, type ProgressiveAvailability } from '@/lib/use-progressive-slots';

/**
 * Asks the booking just made for its join link (F5). Module-level so the
 * polling hook sees one function for the page's whole life, and the action is
 * only touched when there is a link to wait for.
 */
const askMeetingLink = (uid: string, token: string) => meetingLinkAction(uid, token);

interface Props {
  accountCode: string;
  /** Member handle (personal) or team slug (team). */
  ownerSlug: string;
  slug: string;
  /**
   * Every time the page offers, when the caller has them all up front: the
   * studio's preview and the one-off link page. The public event pages pass
   * `availability` instead, and the island reads the times a month at a time.
   */
  slots?: Slot[];
  /**
   * The month on screen's read, already in flight from the server, and where
   * to read the rest from (see `useProgressiveSlots`). The page paints before
   * it answers: the month is drawn, its days "not yet known", and they settle
   * when the times arrive.
   */
  availability?: ProgressiveAvailability;
  /**
   * Why `slots` is empty, when it's a config error (API reason code). Public
   * pages map every code to GENERIC copy — internals are never named here;
   * the actionable detail lives on the admin surfaces.
   */
  emptyReason?: string;
  /** The intake questions; with `availability` they arrive with the first read. */
  bookingFields?: BookingField[];
  initialTimeZone: string;
  mode?: 'personal' | 'team';
  /** Visitor locale ('en' | 'es') for EN/ES copy. */
  locale?: string;

  // --- The event panel (BP) ---------------------------------------------
  // These moved out of the two route headers when the page became three
  // regions. They are props rather than a second fetch because the routes
  // already hold every one of them from the reads they do today.
  eventTitle: string;
  lengthMinutes: number;
  description?: string | null;
  /** Host display name, or the team name on a team event. */
  hostName: string;
  avatarUrl?: string | null;
  /** The workspace logo from the brand kit, or nothing. */
  logoUrl?: string | null;
  /** Raw location — the label comes from `formatLocation`, the icon from the kind. */
  location?: { kind: string; detail?: string | null } | null;
  /** Team scheduling method label; personal events pass nothing. */
  methodLabel?: string | null;
  /**
   * The instant the server rendered at. "Today", and therefore the first month
   * and which days are past, are derived from THIS rather than from `new
   * Date()`, so the server's HTML and the client's hydration cannot disagree
   * about the date when a render straddles midnight.
   */
  nowUtc: string;
  /**
   * Inline embed mode (E). Changes two things and nothing else: a completed
   * booking is announced to the host page, and the confirmation's Manage link
   * opens a new tab instead of navigating the frame.
   */
  embed?: boolean;
  /**
   * The one-off link token (#110), when this page was reached through
   * `/booking/{token}` rather than through a public event URL.
   *
   * Absent on every ordinary booking page, and absent changes nothing. Present,
   * it rides the hold and the booking write so the API can see the HIDDEN event
   * the link opens — and it is spent by the booking, which is what makes the
   * link one-off.
   *
   * This island never calls the API directly (the base URL is server-only), so
   * the token travels to the server actions and is turned into a header there.
   */
  oneOffToken?: string;
  /**
   * The page's `showBranding` from the API (see `signupHref`): false for an
   * account that turned the Dapta branding off while it is a paying Dapta AI
   * customer, and the confirmation then carries no free-calendar block.
   */
  showBranding: boolean;
  /**
   * Whether the times switch to the visitor's own zone after hydration (the
   * default). The host's brand preview turns it off: its fixed sample is a
   * picture that must render the same on the server and after hydration.
   */
  followBrowserZone?: boolean;
}

/**
 * What a browser that hides its zone reports (privacy modes, locked-down
 * machines): every spelling of UTC the IANA database has. None of them tells
 * where the visitor is, so the page keeps the host's zone instead.
 */
const UTC_ZONES = new Set([
  'UTC', 'Etc/UTC', 'UCT', 'Etc/UCT', 'Universal', 'Etc/Universal', 'Zulu', 'Etc/Zulu',
  'GMT', 'Etc/GMT', 'GMT0', 'Etc/GMT0', 'GMT+0', 'Etc/GMT+0', 'GMT-0', 'Etc/GMT-0', 'Greenwich', 'Etc/Greenwich',
]);

interface Hold {
  uid: string;
  expiresAt: string;
}

/** The container width the two-pane layout starts at (globals.css, `@container bp`). */
const TWO_PANE_PX = 768;

/**
 * The interactive island: pick a day, pick a time (which places a soft HOLD),
 * give your details, book. Slots are absolute UTC instants (a tz switch
 * regroups the calendar AND the times with no refetch). Errors surface by HTTP
 * status: 409 slot-taken and 410 hold-expired both offer a Retry (R22
 * error+retry). Branding renders via the ancestor `.branded-surface` classes +
 * `--bp-*` vars (preview == prod).
 *
 * The page is a SEQUENCE. On a phone one region owns the screen at a time: the
 * event and the month, then the chosen day's times, then the details form, then
 * the confirmation, with a 4px track saying where you are. From the two-pane
 * width up the event sits on the left and the right pane holds the month with
 * that day's times beside it (or below it, when there is no room); the form
 * replaces the right pane. ONE tree and one state machine serve both: the step
 * is stamped on the stage (`data-step`) and globals.css decides, per container
 * width, which regions show. Nothing is rendered twice.
 */
export function BookingFlow({
  accountCode,
  ownerSlug,
  slug,
  slots,
  availability,
  emptyReason,
  bookingFields = [],
  initialTimeZone,
  mode = 'personal',
  locale = 'en',
  eventTitle,
  lengthMinutes,
  description,
  hostName,
  avatarUrl,
  logoUrl,
  location,
  methodLabel,
  nowUtc,
  embed = false,
  oneOffToken,
  showBranding,
  followBrowserZone = true,
}: Props) {
  const messages = getMessages(locale);
  const m = messages.booking;
  const bp = messages.bookingPage;
  const pm = messages.phonePicker;
  const progress = useProgressiveSlots({ staticSlots: slots, availability, nowUtc });
  const fields = progress.bookingFields ?? bookingFields;
  // Reserved names (name/email/notes) are fixed attendee fields this form
  // always asks by itself — a legacy custom question reusing one would ask
  // the attendee twice (QA3 fix 3).
  const visibleFields = useMemo(
    () => fields.filter((f) => !isReservedFieldName(f.name)),
    [fields],
  );
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  /**
   * The visitor reads the times in their OWN zone from the start, never in
   * the host's: someone in Miami booking a host in Bogota should not have to
   * find the picker. The server cannot know the browser's zone, so it renders
   * the host's (which is also the fallback) and the first effect after
   * hydration swaps in the browser's. A browser that hides its zone reports
   * UTC (`UTC_ZONES`) or nothing; that keeps the host's. A zone the visitor
   * already picked is never overwritten.
   */
  useEffect(() => {
    if (!followBrowserZone) return;
    const own = detectTimeZone();
    if (UTC_ZONES.has(own) || !isValidTimeZone(own)) return;
    setTimeZone((current) => (current === initialTimeZone ? own : current));
  }, [followBrowserZone, initialTimeZone]);
  /**
   * 12h/24h, defaulted from the LOCALE rather than from the browser. Reading
   * `Intl.DateTimeFormat().resolvedOptions().hourCycle` on the client would
   * disagree with what the server rendered and hydrate-mismatch every slot
   * label on the page. The toggle overrides it for the session; nothing is
   * persisted, because this page stores nothing.
   */
  const [hour12, setHour12] = useState(() => !locale.toLowerCase().startsWith('es'));
  const [selected, setSelected] = useState<string | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  /**
   * The error result the booker has already acknowledged, held BY IDENTITY
   * rather than as a boolean.
   *
   * `useActionState` keeps the previous state until the next action resolves,
   * so a boolean cannot tell "this error is still current" from "this error is
   * last attempt's, still on screen while the new one is in flight". Comparing
   * objects can: `bookAction` returns a fresh object per attempt, so a stale
   * result stays dismissed and a genuinely new one always renders — during the
   * request, and after picking a different slot.
   */
  const [dismissedResult, setDismissedResult] = useState<BookResult | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  // CONTROLLED values for every visible input: React 19 resets uncontrolled
  // form fields when the action returns, so a server-side 400 used to wipe
  // everything the visitor had typed (QA2 fix 3).
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [result, formAction, pending] = useActionState<BookResult | null, FormData>(bookAction, null);

  /** The half of "choose a time" a phone is on. The two-pane layout shows both. */
  const [step, setStep] = useState<'calendar' | 'times'>('calendar');
  /**
   * Which way the last move went, for the phone's slide. `null` until the
   * visitor does something, so the first paint does not animate in.
   */
  const [dir, setDir] = useState<'forward' | 'back' | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const timesTitleRef = useRef<HTMLHeadingElement>(null);
  const chosenTitleRef = useRef<HTMLHeadingElement>(null);
  const doneTitleRef = useRef<HTMLHeadingElement>(null);

  /**
   * The one host-facing message (E, #67): `dapta-calendars.booking_scheduled`,
   * posted to the framing page when a booking lands.
   *
   * Keyed on the booking's uid rather than fired from the confirmation branch,
   * because that branch re-renders on every state change below it — a host
   * counting conversions must not count one booking several times. The payload
   * is PII-free by construction (see `postBookingScheduled`): `targetOrigin` is
   * `'*'`, so any page framing this one receives it.
   */
  const announcedUid = useRef<string | null>(null);
  const booked = result?.ok && result.booking ? result.booking : null;
  // F5: an online meeting's room is minted after the booking answers, so the
  // calendar file below picks the link up once it exists. The create response
  // names no location kind; the page's own is the one the booking snapshotted,
  // as the confirmation below reads it too.
  const lateMeetingUrl = useLateMeetingLink(
    booked ? { ...booked, locationKind: booked.locationKind ?? location?.kind ?? null } : null,
    askMeetingLink,
  );
  const bookedUid = booked?.uid ?? null;
  const bookedStart = booked?.startUtc ?? null;
  useEffect(() => {
    if (!embed || !bookedUid || !bookedStart) return;
    // The uid is the booking's IDENTITY. `useActionState` hands back a fresh
    // object on every attempt and this branch re-renders on every state change
    // below it, so guarding on the value rather than on the object is what
    // keeps a host's conversion counter from counting one booking twice.
    if (announcedUid.current === bookedUid) return;
    announcedUid.current = bookedUid;
    postBookingScheduled({ uid: bookedUid, startUtc: bookedStart, eventTypeSlug: slug });
  }, [embed, bookedUid, bookedStart, slug]);

  // Product analytics, keyed on the uid for the same reason as the message
  // above: one booking is one `booking_confirmed`, however often this renders.
  // Anonymous and PII-free: the status and the mode, nothing about the visitor.
  const trackedUid = useRef<string | null>(null);
  const bookedStatus = booked?.status ?? null;
  useEffect(() => {
    if (!bookedUid || trackedUid.current === bookedUid) return;
    trackedUid.current = bookedUid;
    track('booking_confirmed', { status: bookedStatus, mode });
  }, [bookedUid, bookedStatus, mode]);

  /** Full client-side gate, replacing native validation (noValidate): native
   *  bubbles doubled up with the inline errors and can't be themed. Returns
   *  true when the form may submit. */
  function validateAll(): boolean {
    let ok = true;
    if (!name.trim()) {
      setNameError(m.requiredField);
      ok = false;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError(email.trim() ? m.invalidEmail : m.requiredField);
      ok = false;
    }
    const nextFieldErrors: Record<string, string | null> = {};
    for (const f of visibleFields) {
      const v = (answers[f.name] ?? '').trim();
      // Phone values are E.164 from PhoneField — gate on the SAME too-short
      // rule the field flags inline, so a submit never blocks invisibly.
      const err =
        f.required && !v
          ? m.requiredField
          : f.type === 'phone'
            ? isPhoneValueTooShort(v)
              ? pm.invalid
              : null
            : v
              ? validateBookingFieldValue(f.type, v)
              : null;
      nextFieldErrors[f.name] = err;
      if (err) ok = false;
    }
    setFieldErrors((e) => ({ ...e, ...nextFieldErrors }));
    return ok;
  }

  const {
    days,
    availableDayKeys,
    todayKey,
    minMonth,
    maxMonth,
    month,
    setNavMonth,
    selectedDay,
    setPickedDay,
    dayColumn,
    nextDay,
    goToDay,
  } = useBookingMonth({
    slots: progress.slots,
    timeZone,
    locale,
    hour12,
    nowUtc,
    // Read a month at a time, the page cannot tell where the times end until
    // it has them all, so the visitor may walk to the booking horizon.
    lastMonthKey: progress.progressive ? horizonMonthKey(timeZone, progress.horizonMs) : undefined,
  });
  const { ensureMonth, isKnown } = progress;
  /** Whether the month on screen has been read: its days settle when it has. */
  const monthKnown = isKnown(month, timeZone);

  // "Next day with times" only names a day the page can vouch for: every month
  // from the chosen day's to that day's has been read, so no earlier day with
  // times can still be waiting on a read.
  const nextKnownDay = useMemo(() => {
    if (!nextDay || !selectedDay) return null;
    for (let m = monthKeyOf(selectedDay); m <= monthKeyOf(nextDay.dayKey); m = shiftMonth(m, 1)) {
      if (!isKnown(m, timeZone)) return null;
    }
    return nextDay;
  }, [nextDay, selectedDay, isKnown, timeZone]);

  // The month on screen is read the moment it is on screen (a no-op for the
  // first one, which the server already started, and for any month in hand).
  useEffect(() => {
    void ensureMonth(month, timeZone);
  }, [ensureMonth, month, timeZone]);

  // Once it has settled, the next month is read before the visitor asks, so
  // "next" lands on days that are already known.
  useEffect(() => {
    if (monthKnown && month < maxMonth) void ensureMonth(shiftMonth(month, 1), timeZone);
  }, [ensureMonth, monthKnown, month, maxMonth, timeZone]);

  // A host whose times start in a later month: with nothing found yet, keep
  // reading forward, so the page can open on the month the times start in, as
  // it did when it read everything at once.
  const nothingYet =
    progress.progressive && progress.slots.length === 0 && !progress.everythingKnown && !progress.unavailable;
  useEffect(() => {
    if (!nothingYet) return;
    for (let m = minMonth; m <= maxMonth; m = shiftMonth(m, 1)) {
      if (!isKnown(m, timeZone)) {
        void ensureMonth(m, timeZone);
        return;
      }
    }
  }, [nothingYet, ensureMonth, isKnown, minMonth, maxMonth, timeZone]);
  const locationLabel = formatLocation(location ?? null, messages);
  const weekStartsOn = weekStartsOnFor(locale);

  // Which pick is current, read when a hold answers: a hold that lands after
  // the visitor went back, picked again (the same time included) or left the
  // page belongs to nothing on screen. A counter, not the time, so going back
  // and re-picking the same time is still a new pick. Refs, because the
  // answer arrives in a closure of an older render.
  const pickSeq = useRef(0);
  // The hold request of the latest pick, while it is out, and the last
  // release nobody waited for (from `retry()`, or of a hold that answered for
  // a pick already left). The next pick waits for both before asking for its
  // own hold: Next runs a page's server actions one at a time, so without the
  // wait a re-pick of the same time could be queued ahead of the release of
  // its older hold and be refused as still held.
  const pendingReserve = useRef<Promise<unknown> | null>(null);
  const pendingRelease = useRef<Promise<void> | null>(null);
  function releaseLater(uid: string) {
    const release = Promise.resolve(releaseAction(uid)).catch(() => {});
    pendingRelease.current = release;
    void release.finally(() => {
      if (pendingRelease.current === release) pendingRelease.current = null;
    });
  }
  // Leaving the booking flow inside the app ends the pick, and gives back the
  // hold it stood on. (Closing the tab runs no cleanup; that hold lapses on
  // its own after ten minutes.)
  const holdRef = useRef(hold);
  useEffect(() => {
    holdRef.current = hold;
  }, [hold]);
  useEffect(
    () => () => {
      pickSeq.current += 1;
      if (holdRef.current) releaseLater(holdRef.current.uid);
    },
    [],
  );

  // The hold the form carried when it was submitted (null: none).
  const submittedHold = useRef<string | null>(null);
  // A booking that lands ends the pick. A booker quick enough to confirm
  // before the hold answered booked without it: Next runs a page's server
  // actions one at a time, so the hold lands while the booking waits, and the
  // form had already gone without it. That hold, stored or still on its way,
  // is given back instead of counting against the host's cap of ten live
  // holds for ten minutes. A hold the form did carry was consumed by the
  // booking and is left alone.
  useEffect(() => {
    if (!bookedUid) return;
    pickSeq.current += 1;
    if (!hold) return;
    // One the form did not carry is given back; one it carried was consumed
    // and is only forgotten.
    if (hold.uid !== submittedHold.current) releaseLater(hold.uid);
    setHold(null);
  }, [bookedUid, hold]);

  async function pick(slot: DisplaySlot) {
    // On the two-pane layout the first open day's times are on screen before
    // anything is chosen, so a time can be picked with no day ever clicked:
    // that day is counted here, as preselected, so every time picked follows
    // a day picked.
    if (selectedDay) noteDay(selectedDay, false);
    track('slot_picked', { mode });
    const seq = ++pickSeq.current;
    setDir('forward');
    setSelected(slot.startUtc);
    // The last attempt's error stays dismissed: picking a slot used to clear
    // the flag while `result` still held that error, so choosing a new time
    // after a conflict re-rendered the conflict card straight back.
    setDismissedResult(result);
    setHoldError(null);
    // Moving to another time orphans the hold on this one — give it back (#135).
    // AWAITED, unlike the one in `retry()`: `reserveSlot` re-checks the engine
    // before holding, so a release still in flight would make re-picking the
    // slot you just left answer INVALID_SLOT. Forgotten BEFORE the release
    // round trip, not after: the form for the new time renders at once, and
    // the booking consumes whatever hold the form carries, so it must never
    // carry the hold on the time being left.
    const previous = hold;
    setHold(null);
    if (previous) await Promise.resolve(releaseAction(previous.uid)).catch(() => {});
    if (pendingReserve.current) await Promise.resolve(pendingReserve.current).catch(() => {});
    if (pendingRelease.current) await pendingRelease.current;
    if (pickSeq.current !== seq) return; // moved on during the wait
    // Team events resolve their host set at booking time (round-robin picks one,
    // collective/fixed assign the required hosts) — no per-host hold here.
    if (mode !== 'personal') return;
    // Group events (capacity > 1) fill seats on ONE booking; a per-person hold
    // would blank the whole slot, so skip the hold for group slots.
    if ((slot.capacity ?? 1) > 1) return;
    const reserving = reserveAction({ accountCode, handle: ownerSlug, slug, startUtc: slot.startUtc }, oneOffToken);
    pendingReserve.current = reserving;
    const r = await reserving;
    if (pendingReserve.current === reserving) pendingReserve.current = null;
    if (pickSeq.current !== seq) {
      // The visitor left this pick while it was being held. Give the hold
      // straight back (its error, if any, is about nothing on screen): kept,
      // it would hide the time from everyone for ten minutes, or ride the form
      // for another time into a 410.
      if (r.ok && r.reservationUid) releaseLater(r.reservationUid);
      return;
    }
    if (r.ok && r.reservationUid) setHold({ uid: r.reservationUid, expiresAt: r.expiresAt! });
    else setHoldError(holdFailureCopy(r, messages.trouble));
  }

  /**
   * Forget the slot and go back to the times. Reached two ways: the retry on a
   * 409/410, and the explicit "back to times" on the form.
   *
   * It RELEASES the hold (#135) rather than only forgetting it: "back to times"
   * is how a booker compares Tuesday against Thursday, so a hold left standing
   * for its full ten-minute TTL would hide that slot from every other visitor
   * for no reason. Fire-and-forget — the release answers the same success
   * whether or not the hold was still there, and the booker is already gone.
   */
  function retry() {
    pickSeq.current += 1;
    setDir('back');
    setSelected(null);
    if (hold) releaseLater(hold.uid);
    setHold(null);
    setHoldError(null);
    setDismissedResult(result);
  }

  // "Try again" on a month that did not answer: busy while it asks, and on an
  // answer the calendar comes back with focus on its first open day, so focus
  // does not fall to the page when the button it was on goes away.
  // The button stays focusable while it asks (aria-disabled, not disabled: a
  // disabled control drops focus to the page). A press that still finds
  // nothing says so in the status line, so the outcome is announced.
  const [askingAgain, setAskingAgain] = useState(false);
  const [askFailed, setAskFailed] = useState(false);
  const refocus = useRef(false);
  async function askAgain() {
    if (askingAgain) return;
    setAskingAgain(true);
    refocus.current = true;
    try {
      await ensureMonth(month, timeZone);
    } finally {
      setAskingAgain(false);
    }
  }
  // "Still unavailable" holds until the times answer, so a press never first
  // announces the old sentence as if it were its outcome.
  useEffect(() => {
    if (!progress.unavailable) setAskFailed(false);
  }, [progress.unavailable]);
  useEffect(() => {
    if (!refocus.current || askingAgain) return;
    refocus.current = false;
    if (progress.unavailable) {
      setAskFailed(true);
      return;
    }
    // Only when focus fell with the button: a visitor who moved on during the
    // read keeps their place.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    // The grid's tab stop (its roving cursor), else its first open day.
    const grid = stageRef.current?.querySelector('[role="grid"]');
    (
      grid?.querySelector<HTMLButtonElement>('button[tabindex="0"]') ??
      grid?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    )?.focus();
  }, [askingAgain, progress.unavailable]);

  /**
   * Duplicate-booking guard (#69): the booker is blocked on their ADDRESS, not
   * on the time, so `retry()` — which drops the slot and sends them back to the
   * grid — is exactly the wrong move. Dismiss the error and keep the slot, the
   * hold and everything they typed, so correcting a typo'd email is one edit.
   */
  function dismissDuplicate() {
    setDismissedResult(result);
  }

  // --- The step, and where focus goes when it changes ---------------------
  // `calendar` and `times` are the two halves of choosing a time and are the
  // only steps held in state; `details` is "a time is chosen" and `done` is "a
  // booking came back", both derived.
  const flowStep: BookingStep = booked ? 'done' : selected ? 'details' : step;

  /**
   * Focus follows the visitor into the next step, so a screen reader announces
   * where they landed and a keyboard user does not start from the top. Only
   * after they have done something (`dir`), so loading the page never moves
   * focus; and the day's times take focus only on a phone, where they replace
   * the month, never beside it, where a keyboard user is still walking the grid.
   */
  useEffect(() => {
    if (dir === null) return;
    const twoPane = (stageRef.current?.getBoundingClientRect().width ?? 0) >= TWO_PANE_PX;
    if (flowStep === 'done') doneTitleRef.current?.focus();
    else if (flowStep === 'details') chosenTitleRef.current?.focus();
    else if (flowStep === 'times' && !twoPane) timesTitleRef.current?.focus();
    else if (flowStep === 'calendar' && !twoPane && selectedDay) {
      stageRef.current?.querySelector<HTMLElement>(`[data-day="${selectedDay}"]`)?.focus();
    }
    // `selectedDay` is read, not reacted to: focus moves on a STEP change only.
  }, [flowStep, dir]);

  const timeZoneLabel = readableZone(timeZone);

  /**
   * Count a day once, the first time it becomes the visitor's (a click, the
   * "next day" button, or a time picked on it). `preselected` says it was the
   * day the page opened on rather than one the visitor went to.
   */
  const trackedDay = useRef<string | null>(null);
  function noteDay(dayKey: string, chosen: boolean) {
    if (trackedDay.current === dayKey) return;
    trackedDay.current = dayKey;
    track('day_picked', { mode, preselected: !chosen });
  }

  /** Choosing a day is the first move forward: on a phone the times take over. */
  function chooseDay(dayKey: string) {
    noteDay(dayKey, true);
    setPickedDay(dayKey);
    setDir('forward');
    setStep('times');
  }

  function backToCalendar() {
    setDir('back');
    setStep('calendar');
  }

  /** The stage every branch below renders into: the progress track, then the step. */
  const stage = (content: React.ReactNode) => (
    <BookingStage m={messages} step={flowStep} dir={dir} stageRef={stageRef}>
      {content}
    </BookingStage>
  );

  // --- Confirmed ----------------------------------------------------------
  if (result?.ok && result.booking) {
    const b = result.booking;
    const isPending = b.status === 'pending';
    const ctaHref = signupHref('confirmation', accountCode, showBranding);
    /**
     * This branch is shared by the personal and the team path, and it must
     * never be able to THROW: an unparseable instant raises `RangeError:
     * Invalid time value` in `Intl`, that escapes to the public error boundary,
     * and the booker is shown a failure screen for a booking that succeeded,
     * which is how they end up making a second one (#102). The team route
     * returns the same full `BookingView` the personal one does; this is the
     * belt to that braces, so a future shape drift costs the confirmation a
     * line of detail rather than the confirmation itself.
     */
    const startOk = !Number.isNaN(Date.parse(b.startUtc ?? ''));
    const endOk = !Number.isNaN(Date.parse(b.endUtc ?? ''));
    const dayLine = startOk ? formatDayLong(b.startUtc, timeZone, locale) : null;
    const timeLine = startOk && endOk ? formatTimeRange(b.startUtc, b.endUtc, timeZone, locale, hour12) : null;
    const bookedLocation = formatBookingLocation(b.locationKind, b.location, messages) ?? locationLabel;
    // Dropped rather than interpolated empty: both strings end in the address,
    // so a missing one renders "A confirmation was sent to ." which is worse
    // than saying nothing.
    const attendeeEmail = b.attendee?.email;
    const sentTo = attendeeEmail
      ? isPending
        ? t(m.awaitingConfirmation, { email: attendeeEmail })
        : t(m.confirmationSentTo, { email: attendeeEmail })
      : null;
    // The file a calendar opens: the join link as its location when there is
    // one (it is what a calendar should open), else the human location. The
    // link usually arrives after the booking does (`useLateMeetingLink`).
    const calendarHref =
      startOk && endOk
        ? calendarFileHref({
            uid: b.uid,
            title: b.title,
            startUtc: b.startUtc,
            endUtc: b.endUtc,
            location: bookedLocation,
            url: b.meetingUrl ?? lateMeetingUrl,
            stamp: nowUtc,
          })
        : null;
    return stage(
      <BookingConfirmation
        m={messages}
        pending={isPending}
        eventTitle={b.title}
        dayLine={dayLine}
        timeLine={timeLine}
        timeZoneLabel={timeZoneLabel}
        hostName={b.host?.name ?? hostName}
        locationLabel={bookedLocation}
        locationKind={b.locationKind ?? location?.kind ?? null}
        sentTo={sentTo}
        titleRef={doneTitleRef}
        actions={
          <>
            {calendarHref ? (
              <a href={calendarHref} download={calendarFileName(b.title)} className="bp-btn bp-cta">
                {bp.addToCalendar}
              </a>
            ) : null}
            {b.manageUrl ? (
              // Inside a frame this must open a new tab. Left to navigate the
              // frame it drops the invitee into the manage page inside a short
              // box with nothing to get back with, and `/manage/[uid]` is
              // `frame-ancestors 'self'`, so it would refuse to render there at
              // all on the very click that was supposed to help them.
              <a
                href={b.manageUrl}
                {...(embed ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="bp-btn-outline bp-cta"
              >
                {getMessages(locale).manage.title}
              </a>
            ) : null}
          </>
        }
        footer={
          // Growth loop (R11), below the card: the same block the profile and
          // the team landing end with, as the OUTLINE variant here, since "Add
          // to calendar" is this screen's one primary (R30). Gated by the
          // open-core badge switch.
          ctaHref ? <GrowthCta m={messages} href={ctaHref} quiet /> : null
        }
      />,
    );
  }

  // WHICH card to show is decided by `classifyBookingFailure` in
  // `lib/booking-failure.ts`, not here. The branches overlap on status (the
  // duplicate guard and a taken slot are both 409, a spent invite link and an
  // expired hold are both 410), so the ORDER they are tested in is the whole
  // decision, and it belongs somewhere it can be tested directly.
  //
  // `result !== dismissedResult` is the freshness test: an error the booker has
  // acknowledged stays hidden until the NEXT attempt produces a different
  // object, so nothing here can render last attempt's failure over an in-flight
  // request or over a newly picked slot.
  const live = result && !result.ok && result !== dismissedResult;
  const kind = live ? classifyBookingFailure(result, !!oneOffToken) : undefined;
  const duplicate = kind === 'duplicate';
  const oneOffGone = kind === 'one-off-gone';
  const conflict = kind === 'conflict';
  const intakeError = kind === 'intake';
  // Neither a conflict nor an intake answer: the booking did not go through and
  // nothing was written, so the form stays exactly as it was with a line above
  // Confirm saying so. Without it a failed submit used to look ignored.
  const submitTrouble =
    kind === 'busy' ? messages.trouble.bookBusy : kind === 'generic' ? messages.trouble.bookFailed : null;

  // --- Duplicate booking (409 DUPLICATE_BOOKING) --------------------------
  // The copy names NO date, time or host: revealing the existing slot would
  // hand a third party's schedule to anyone who guesses an email, and the
  // person it belongs to already has the confirmation in their inbox.
  if (duplicate) {
    return stage(
      <section className="bp-card bp-notice" data-tone="error">
        <h2 className="bp-notice-title">{m.duplicateGuard.title}</h2>
        <p className="bp-muted">{m.duplicateGuard.body}</p>
        <button type="button" onClick={dismissDuplicate} className="bp-btn bp-cta">
          {m.duplicateGuard.changeEmail}
        </button>
      </section>,
    );
  }

  // --- One-off link spent (410 / 404) -------------------------------------
  // The SAME words `/booking/{token}` renders when the link was already dead on
  // arrival, from the same catalog keys. No action: nothing the booker can do
  // on this page resolves it.
  if (oneOffGone) {
    return stage(
      <section className="bp-card bp-notice">
        <h2 className="bp-notice-title">{m.oneOffLink.usedTitle}</h2>
        <p className="bp-muted">{m.oneOffLink.usedBody}</p>
      </section>,
    );
  }

  // --- Conflict (409/410): R22 error + retry ------------------------------
  // CALENDAR_UNAVAILABLE (booking blocked fail-closed) gets its own localized
  // copy: a generic "try again shortly", never internals.
  if (conflict) {
    const calUnavailable = result!.error === 'CALENDAR_UNAVAILABLE';
    return stage(
      <section className="bp-card bp-notice" data-tone="error">
        <h2 className="bp-notice-title">
          {calUnavailable ? m.calendarUnavailableTitle : result!.status === 410 ? m.holdExpired : m.slotTaken}
        </h2>
        <p className="bp-muted">{calUnavailable ? m.calendarUnavailableBody : result!.message}</p>
        <button type="button" onClick={retry} className="bp-btn bp-cta">
          {m.pickAnother}
        </button>
      </section>,
    );
  }

  // Every slot the page holds is empty for one of three reasons, and the copy
  // has always distinguished them. A read that did not answer is the first.
  const reason = progress.unavailable ? 'CALENDAR_UNAVAILABLE' : (progress.emptyReason ?? emptyReason);
  const emptyCopy =
    reason === 'CALENDAR_UNAVAILABLE'
      ? progress.busy
        ? messages.trouble.busyTimes
        : askFailed
          ? m.timesStillUnavailable
          : m.timesUnavailable
      : reason
        ? m.noTimesNow
        : m.noSlots;
  // The sentence replaces the calendar only once the page KNOWS there is
  // nothing: every month read, or a reason that holds for all of them. Until
  // then the month stays drawn with its days not yet known.
  const nothingToOffer =
    days.length === 0 && (progress.everythingKnown || progress.unavailable || !!progress.emptyReason);

  const timeZoneControl = (
    // Themed combobox, not the native <select>: the OS popup for ~400 zones is
    // un-brandable and covers the screen (QA2 fix 1). Quiet here, a line of
    // text with a chevron, because it is a setting most visitors never touch;
    // on a phone its list rises as a sheet over a dimmed page. Drawn by the
    // `bp-*` contract (`ZonePicker`), never by the admin's `Select`.
    <div className="bp-tz">
      <ZonePicker id="tz" value={timeZone} onChange={setTimeZone} locale={locale} ariaLabel={m.timezone} />
    </div>
  );

  const panel = (
    <EventPanel
      m={messages}
      hostName={hostName}
      avatarUrl={avatarUrl}
      eventTitle={eventTitle}
      description={description}
      lengthMinutes={lengthMinutes}
      location={location}
      locationLabel={locationLabel}
      methodLabel={methodLabel}
      // The HOST's zone: a fact about them that does not move with the zone
      // the visitor reads the times in.
      timeZoneLabel={readableZone(initialTimeZone)}
      logoUrl={logoUrl}
    />
  );

  // --- A time is chosen: the form replaces the right pane -----------------
  if (selected) {
    const end = new Date(Date.parse(selected) + lengthMinutes * 60_000).toISOString();
    const holdLine = hold
      ? t(m.heldUntil, {
          time: new Intl.DateTimeFormat(locale, {
            hour: 'numeric',
            minute: '2-digit',
            timeZone,
            // The hold follows the same 12h/24h choice as the time the booker
            // just picked; two clocks on one screen is a bug.
            ...(hour12 ? { hour12: true } : { hourCycle: 'h23' as const }),
          }).format(new Date(hold.expiresAt)),
        })
      : null;
    return stage(
      <div className="bp-frame bp-card">
        <div className="bp-pane-event bp-region">{panel}</div>
        <div className="bp-pane-main">
          <aside aria-label={bp.yourDetails} className="bp-pane-details bp-region">
            <ChosenTime
              m={messages}
              eventTitle={eventTitle}
              dayLine={formatDayLong(selected, timeZone, locale)}
              timeLine={formatTimeRange(selected, end, timeZone, locale, hour12)}
              timeZoneLabel={timeZoneLabel}
              timeZoneControl={timeZoneControl}
              holdLine={holdLine}
              holdError={holdError}
              onBack={retry}
              titleRef={chosenTitleRef}
            />
            <form
              action={formAction}
              noValidate
              // Client-side gate: block the submit (and the field wipe it used
              // to cause) instead of round-tripping a guaranteed 400.
              onSubmit={(e) => {
                if (!validateAll()) e.preventDefault();
                else {
                  submittedHold.current = hold?.uid ?? null;
                  track('booking_submitted', { mode });
                }
              }}
              className="bp-form"
            >
              <input type="hidden" name="accountCode" value={accountCode} />
              <input type="hidden" name="ownerSlug" value={ownerSlug} />
              <input type="hidden" name="kind" value={mode} />
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="startUtc" value={selected} />
              <input type="hidden" name="timeZone" value={timeZone} />
              {/* The language this page speaks to the visitor, which their
                  emails are then written in (F6); the host's keep the host's. */}
              <input
                type="hidden"
                name="language"
                value={locale.toLowerCase().startsWith('es') ? 'es' : 'en'}
              />
              {hold ? <input type="hidden" name="reservationUid" value={hold.uid} /> : null}
              {/* The one-off token (#110). A hidden field so the token reaches
                  the server action without this island holding an API base URL;
                  the action forwards it as a header. */}
              {oneOffToken ? <input type="hidden" name="oneOffToken" value={oneOffToken} /> : null}

              <label className="bp-field">
                {/* Required marker INLINE with the label (R30 §7). */}
                <span className="bp-label">
                  {m.yourName} <span className="bp-required">*</span>
                </span>
                <input
                  name="name"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                  aria-invalid={!!nameError}
                  className="bp-input"
                />
                {nameError ? (
                  <span role="alert" className="bp-error">
                    {nameError}
                  </span>
                ) : null}
              </label>
              <label className="bp-field">
                <span className="bp-label">
                  {m.yourEmail} <span className="bp-required">*</span>
                </span>
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  onBlur={() =>
                    setEmailError(email.trim() && !EMAIL_RE.test(email.trim()) ? m.invalidEmail : null)
                  }
                  aria-invalid={!!emailError}
                  className="bp-input"
                />
                {emailError ? (
                  <span role="alert" className="bp-error">
                    {emailError}
                  </span>
                ) : null}
              </label>

              {visibleFields.map((f) => {
                const validate = (v: string) =>
                  setFieldErrors((e) => ({ ...e, [f.name]: validateBookingFieldValue(f.type, v) }));
                const setAnswer = (v: string) => setAnswers((a) => ({ ...a, [f.name]: v }));
                const value = answers[f.name] ?? '';
                const isMulti = f.type === 'textarea' || f.type === 'guests';
                const error = fieldErrors[f.name];
                return (
                  <label key={f.name} className="bp-field">
                    <span className="bp-label">
                      {f.label}
                      {f.required ? <span className="bp-required"> *</span> : null}
                    </span>
                    {f.type === 'phone' ? (
                      <PhoneField
                        value={value}
                        onChange={(v) => {
                          setAnswer(v);
                          // PhoneField flags too-short numbers inline itself;
                          // keep the submit gate in step with what it shows.
                          setFieldErrors((e) => ({
                            ...e,
                            [f.name]: isPhoneValueTooShort(v) ? pm.invalid : null,
                          }));
                        }}
                        locale={locale}
                        name={`answer_${f.name}`}
                        required={f.required}
                        ariaLabel={f.label}
                        defaultCountry={f.defaultCountry}
                      />
                    ) : isMulti ? (
                      <textarea
                        name={`answer_${f.name}`}
                        required={f.required}
                        rows={3}
                        placeholder={f.type === 'guests' ? 'guest1@example.com, guest2@example.com' : f.placeholder}
                        value={value}
                        onChange={(e) => setAnswer(e.target.value)}
                        onBlur={(e) => validate(e.target.value)}
                        aria-invalid={!!error}
                        className="bp-input"
                      />
                    ) : (
                      <input
                        name={`answer_${f.name}`}
                        type={f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : 'text'}
                        required={f.required}
                        placeholder={f.placeholder}
                        value={value}
                        onChange={(e) => setAnswer(e.target.value)}
                        onBlur={(e) => validate(e.target.value)}
                        aria-invalid={!!error}
                        className="bp-input"
                      />
                    )}
                    {/* Phone shows its own inline error for typed-but-short
                        numbers; only the required-empty case renders here. */}
                    {error && (f.type !== 'phone' || !value.trim()) ? (
                      <span className="bp-error">{error}</span>
                    ) : null}
                  </label>
                );
              })}

              <label className="bp-field">
                <span className="bp-label">{m.notes}</span>
                <textarea
                  name="notes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="bp-input"
                />
              </label>

              {intakeError ? <p className="bp-error">{result!.message}</p> : null}
              {submitTrouble && !pending ? (
                <p role="alert" className="bp-error">
                  {submitTrouble}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={pending || Object.values(fieldErrors).some(Boolean)}
                className="bp-btn bp-cta"
              >
                {pending ? m.confirming : m.confirm}
              </button>
            </form>
          </aside>
        </div>
      </div>,
    );
  }

  // --- Choosing a time: the event, the month and the day's times -----------
  return stage(
    <ChoosingFrame
      panel={panel}
      empty={
        nothingToOffer ? (
          // No calendar at all when the page has no times to put in one: an
          // empty month of greyed-out days is a worse answer than the sentence
          // that says why. When the reason is that nothing answered, the
          // visitor can ask again: the page retries on its own for half a
          // minute, and this is the way past that, short of reloading.
          <>
            <p role="status" className="bp-muted bp-empty">
              {emptyCopy}
            </p>
            {progress.unavailable ? (
              <button
                type="button"
                onClick={askAgain}
                aria-disabled={askingAgain || undefined}
                aria-busy={askingAgain || undefined}
                className="bp-btn-outline"
              >
                {m.retry}
              </button>
            ) : null}
          </>
        ) : undefined
      }
      month={
        <MonthCalendar
          m={messages}
          monthKey={month}
          availableDayKeys={availableDayKeys}
          todayKey={todayKey}
          selectedDayKey={selectedDay}
          locale={locale}
          weekStartsOn={weekStartsOn}
          minMonthKey={minMonth}
          maxMonthKey={maxMonth}
          pending={!monthKnown}
          // Pointing at "next" is reason enough to read it.
          onNextMonthIntent={() => ensureMonth(shiftMonth(month, 1), timeZone)}
          onMonthChange={(next) => {
            setNavMonth(next);
            // Drop the explicit pick so the new month falls back to its own
            // first bookable day, rather than showing times from a month that
            // is no longer on screen.
            setPickedDay(null);
          }}
          onSelectDay={chooseDay}
          // Arrows walk the month without leaving it; only choosing a day does.
          onCursorDay={setPickedDay}
        />
      }
      times={
        <TimesColumn
          m={messages}
          dayTitle={dayColumn ? t(bp.timesOn, { day: dayColumn.heading }) : null}
          slots={dayColumn?.slots ?? []}
          emptyText={selectedDay ? bp.noTimesOnDay : bp.pickADay}
          pending={!monthKnown}
          onPick={pick}
          onBack={backToCalendar}
          hour12={hour12}
          onHour12Change={setHour12}
          timeZoneControl={timeZoneControl}
          titleRef={timesTitleRef}
          next={
            nextKnownDay
              ? {
                  heading: nextKnownDay.heading,
                  onGo: () => {
                    noteDay(nextKnownDay.dayKey, true);
                    goToDay(nextKnownDay.dayKey);
                  },
                }
              : null
          }
        />
      }
    />,
  );
}

/**
 * The line under the chosen time when its hold was refused, in the visitor's
 * language rather than the API's English. A refused hold does not stop the
 * booking (it re-checks the time itself), so the copy says what happened and
 * whether booking can still go ahead.
 */
function holdFailureCopy(
  r: { status: number; error?: string },
  copy: { holdBusy: string; holdUnconfirmed: string; holdGone: string; holdFailed: string },
): string {
  if (r.status === 429) return copy.holdBusy;
  if (r.error === 'CALENDAR_UNAVAILABLE') return copy.holdUnconfirmed;
  if (r.error === 'INVALID_SLOT' || r.status === 400) return copy.holdGone;
  return copy.holdFailed;
}
