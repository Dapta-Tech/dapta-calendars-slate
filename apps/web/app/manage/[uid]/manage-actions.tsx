'use client';

import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  formatDayLong,
  formatTimeRange,
  readableZone,
  t,
  weekStartsOnFor,
  type BookingMessages,
  type Slot,
} from '@slate/shared';
import {
  BookingStage,
  ChoosingFrame,
  ChosenTime,
  MonthCalendar,
  TimesColumn,
  type BookingStep,
} from '@/components/booking-page-parts';
import { useBookingMonth } from '@/lib/use-booking-month';
import { manageTokenOf } from '@/lib/manage-token';
import { manageFailureCopy, manageFailureIsRetryable } from '@/lib/manage-failure';
import { cancelAction, rescheduleAction } from './actions';


/**
 * The manage page's two actions, reschedule and cancel, on the event page's
 * own sequence: the booking (and the way to cancel it) where the event panel
 * goes, the month and the chosen day's times beside it, and, once a new time is
 * chosen, that time restated with the one button that moves the booking. On a
 * phone it is one step per screen, exactly as booking was.
 */
export function ManageActions({
  uid,
  canReschedule = true,
  token: initialToken,
  slots,
  timesNote,
  timeZone,
  locale,
  messages,
  summary,
  durationMinutes,
  nowUtc,
}: {
  uid: string;
  /** False for a request still waiting on the host: it can only be withdrawn. */
  canReschedule?: boolean;
  token: string;
  slots: Slot[];
  /**
   * Why `slots` is empty when it is not because nothing is free: the service
   * was busy, or the host's calendar could not be read. The picker says so and
   * offers to ask again instead of claiming there are no open times.
   */
  timesNote?: 'busy' | 'unavailable';
  /** The attendee's zone: the times are offered in the clock they booked in. */
  timeZone: string;
  locale: string;
  messages: BookingMessages;
  /** The booking as it stands, rendered by the page: what, when, with whom, where. */
  summary: ReactNode;
  /** The booking's length, for the new time's range. */
  durationMinutes: number;
  /** The instant the server rendered at; "today" is read from it. */
  nowUtc: string;
}) {
  const m = messages.manage;
  const bp = messages.bookingPage;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [cancelRes, cancelForm, cancelPending] = useActionState(cancelAction, null);
  const [rsRes, rsForm, rsPending] = useActionState(rescheduleAction, null);
  const [newStartUtc, setNewStartUtc] = useState('');
  // The failed reschedule the visitor has moved on from (by picking another
  // time), held by identity: it stays hidden until a new attempt answers.
  const [seenRs, setSeenRs] = useState<typeof rsRes>(null);
  const rsFailure = rsRes && !rsRes.ok && rsRes !== seenRs ? rsRes : null;
  // A real reschedule ROTATES the manage token (the one in the URL dies), so we
  // hold the live token in state and adopt the rotated one from the response;
  // otherwise a second cancel/reschedule from this page would 403.
  const [token, setToken] = useState(initialToken);
  const [navPending, startNav] = useTransition();
  const [hour12, setHour12] = useState(() => !locale.toLowerCase().startsWith('es'));
  const [step, setStep] = useState<'calendar' | 'times'>('calendar');
  const [dir, setDir] = useState<'forward' | 'back' | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const chosenTitleRef = useRef<HTMLHeadingElement>(null);
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
  } = useBookingMonth({ slots, timeZone, locale, hour12, nowUtc });

  useEffect(() => {
    if (!rsRes) return;
    if (rsRes.ok) {
      // Adopt the fresh token (state + URL) so subsequent actions use it.
      const next = manageTokenOf(rsRes.manageUrl);
      if (next && next !== token) {
        setToken(next);
        setNewStartUtc('');
        setStep('calendar');
        // Preserve any other query params; only swap the token. Wrapped in a
        // transition so the header-to-new-time RSC round-trip has a pending state.
        const params = new URLSearchParams(searchParams);
        params.set('token', next);
        startNav(() => router.replace(`/manage/${uid}?${params.toString()}`));
      }
    } else if (!manageFailureIsRetryable(rsRes)) {
      // Conflict (slot just taken): refetch availability, drop the stale time.
      // A busy service or an unreadable calendar keeps the chosen time instead:
      // pressing Reschedule again is the retry.
      setNewStartUtc('');
      router.refresh();
    }
  }, [rsRes, router, uid, token, searchParams]);

  const flowStep: BookingStep = newStartUtc ? 'details' : step;
  useEffect(() => {
    if (dir !== null && flowStep === 'details') chosenTitleRef.current?.focus();
  }, [flowStep, dir]);

  const notice = (text: string) => (
    <section role="status" aria-live="polite" className="bp-card bp-notice">
      <p>{text}</p>
    </section>
  );

  if (cancelRes?.ok) {
    return (
      <BookingStage m={messages} step="done">
        {notice(canReschedule ? m.cancelled : m.requestCancelled)}
      </BookingStage>
    );
  }

  // Reschedule succeeded but no rotated token came back (shouldn't happen on the
  // public path, which always rotates): the current token is dead, so the forms
  // cannot safely stay live. A terminal success instead.
  if (rsRes?.ok && !rsRes.manageUrl) {
    return (
      <BookingStage m={messages} step="done">
        {notice(m.rescheduled)}
      </BookingStage>
    );
  }

  const zone = readableZone(timeZone);

  // Cancelling is the quiet action, under the booking it would cancel.
  const cancel = (
    <form action={cancelForm} className="bp-manage-cancel">
      <input type="hidden" name="uid" value={uid} />
      <input type="hidden" name="token" value={token} />
      <label className="bp-field" htmlFor="reason">
        <span className="bp-label">{canReschedule ? m.cancelThis : m.cancelThisRequest}</span>
        <input id="reason" name="reason" placeholder={m.cancelReason} className="bp-input" />
      </label>
      {cancelRes && !cancelRes.ok ? (
        <p role="alert" className="bp-error">
          {manageFailureCopy(cancelRes, messages)}
        </p>
      ) : null}
      <button type="submit" disabled={cancelPending} className="bp-btn-outline bp-cta bp-danger">
        {cancelPending ? m.cancelling : canReschedule ? m.cancel : m.cancelRequest}
      </button>
    </form>
  );

  // A request still waiting on the host: the booking and the way to withdraw
  // it, and no calendar, since a new time would be a new request.
  if (!canReschedule) {
    return (
      <BookingStage m={messages} step="done">
        <section className="bp-card bp-notice">
          <div className="bp-manage-panel">
            {summary}
            {cancel}
          </div>
        </section>
      </BookingStage>
    );
  }

  const panel = (
    <div className="bp-manage-panel">
      {/* Non-terminal success: the token is adopted, so the booker can move the
          booking again or cancel it from here without a 403. */}
      {rsRes?.ok ? (
        <p role="status" aria-live="polite" className="bp-manage-done">
          {m.rescheduled}
        </p>
      ) : null}
      {/* A move refused because the time went (taken, no longer offered) drops
          the visitor back to the picker; this says why they are there. */}
      {rsFailure && !newStartUtc ? (
        <p role="alert" className="bp-error">
          {manageFailureCopy(rsFailure, messages)}
        </p>
      ) : null}
      {summary}
      {cancel}
    </div>
  );

  // --- A new time is chosen: restate it, and the one button that moves it --
  if (newStartUtc) {
    const end = new Date(Date.parse(newStartUtc) + durationMinutes * 60_000).toISOString();
    return (
      <BookingStage m={messages} step={flowStep} dir={dir} stageRef={stageRef}>
        <div className={`bp-frame bp-card${navPending ? ' bp-pending' : ''}`}>
          <div className="bp-pane-event bp-region">{panel}</div>
          <div className="bp-pane-main">
            <form action={rsForm} className="bp-pane-details bp-region">
              <input type="hidden" name="uid" value={uid} />
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="newStartUtc" value={newStartUtc} />
              <ChosenTime
                m={messages}
                eventTitle={m.rescheduleTo}
                dayLine={formatDayLong(newStartUtc, timeZone, locale)}
                timeLine={formatTimeRange(newStartUtc, end, timeZone, locale, hour12)}
                timeZoneLabel={zone}
                holdError={rsFailure ? manageFailureCopy(rsFailure, messages) : null}
                onBack={() => {
                  setDir('back');
                  setNewStartUtc('');
                }}
                titleRef={chosenTitleRef}
              />
              <button
                type="submit"
                // Also disabled once a reschedule has succeeded (rsRes.ok), so a
                // fast double-click cannot resubmit the stale time with the
                // rotated (now dead) token before the effect clears it.
                disabled={rsPending || navPending || rsRes?.ok}
                className="bp-btn bp-cta"
              >
                {rsPending ? m.rescheduling : m.reschedule}
              </button>
            </form>
          </div>
        </div>
      </BookingStage>
    );
  }

  // --- Choosing the new time: the booking, the month and the day's times ----
  return (
    <BookingStage m={messages} step={flowStep} dir={dir} stageRef={stageRef}>
      <ChoosingFrame
        panel={panel}
        empty={
          days.length === 0 ? (
            timesNote ? (
              <>
                <p role="status" className="bp-muted bp-empty">
                  {timesNote === 'busy' ? messages.trouble.manageTimesBusy : messages.trouble.manageTimesUnavailable}
                </p>
                <button
                  type="button"
                  onClick={() => startNav(() => router.refresh())}
                  aria-busy={navPending || undefined}
                  className="bp-btn-outline"
                >
                  {messages.trouble.tryAgain}
                </button>
              </>
            ) : (
              <p className="bp-muted bp-empty">{m.noOpenTimes}</p>
            )
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
            weekStartsOn={weekStartsOnFor(locale)}
            minMonthKey={minMonth}
            maxMonthKey={maxMonth}
            onMonthChange={(next) => {
              setNavMonth(next);
              setPickedDay(null);
            }}
            onSelectDay={(day) => {
              setPickedDay(day);
              setDir('forward');
              setStep('times');
            }}
            onCursorDay={setPickedDay}
          />
        }
        times={
          <TimesColumn
            m={messages}
            dayTitle={dayColumn ? t(bp.timesOn, { day: dayColumn.heading }) : null}
            slots={dayColumn?.slots ?? []}
            emptyText={selectedDay ? bp.noTimesOnDay : bp.pickADay}
            onPick={(slot) => {
              setDir('forward');
              setSeenRs(rsRes);
              setNewStartUtc(slot.startUtc);
            }}
            onBack={() => {
              setDir('back');
              setStep('calendar');
            }}
            hour12={hour12}
            onHour12Change={setHour12}
            timeZoneControl={<p className="bp-muted bp-small">{zone}</p>}
            next={nextDay ? { heading: nextDay.heading, onGo: () => goToDay(nextDay.dayKey) } : null}
          />
        }
      />
    </BookingStage>
  );
}
