'use client';

import { useEffect, useId, useReducer, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { COUNTRIES, countryName, isReservedFieldName, type BookingMessages } from '@slate/shared';
import {
  MAX_BOOKING_WINDOW_DAYS,
  MAX_SUCCESS_REDIRECT_URL,
  isSuccessRedirectUrl,
  type CrmPropertyCatalog,
  type SuccessRedirectData,
} from '@slate/types';
import { type Connection, type EventType } from '@/lib/admin-api';
import { CrmMappingSection } from './crm-mapping-section';
import {
  HostPrioritySelect,
  HostReadiness,
  PersonalHostsCard,
  TeamHostsNote,
  type TeamOption,
} from './team-hosts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/toast';
import { saveEventTypeAction, type ActionResult } from './actions';
import { draftReducer, initialDraft, toPayload, type DraftAction, type EventTypeDraft } from './draft';
import { ChevronIcon, EventTypeMessages, FIELD_TYPES, Field, HostCell, HostRow, SCHEDULING_METHODS, SchedulingMethod, TeamMemberOption, inputCls } from './sections/shared';
import { RemindersSection } from './sections/reminders';
import { CalendarsForEventSection } from './sections/calendars';
import { LocationField } from './sections/location';
import { OneOffLinksSection } from './sections/one-off-links';
import { BookingWindowField } from './sections/booking-window';
import { TrackingKey, TrackingSection, invalidTrackingKeys, trackingKeysShown } from './sections/tracking';

export function EventTypeForm({
  initial,
  schedules = [],
  messages: m,
  locationLabels,
  scheduling,
  teamMembers,
  teamId,
  teamName,
  teams,
  canManageTeams = false,
  trackingEnabled = false,
  hostScriptsEnabled = false,
  connections,
  redirectOnSuccess,
  backHref,
  backLabel,
  heading,
  headerExtras,
  crmCatalog,
  locale = 'en',
}: {
  initial?: EventType;
  schedules?: Array<{ id: string; name: string }>;
  messages: EventTypeMessages;
  /** Location-kind names (from the shared `location` catalog) — the same copy
   *  the public booking page and the manage page render. */
  locationLabels: BookingMessages['location'];
  /** Scheduling-method names + hints (from the shared `scheduling` catalog). */
  scheduling?: BookingMessages['scheduling'];
  /** The team's members — present only for TEAM event types (edit or create). */
  teamMembers?: TeamMemberOption[];
  /** Create a TEAM event for this team (QA2 fix 5) — the /new surface had no
   *  path to team events at all; editing derives the team from `initial`. */
  teamId?: string;
  /** TEAM events: the team's name, for the line saying its members host. */
  teamName?: string;
  /** PERSONAL events: the account's teams, for the card pointing at team
   *  events (a personal event has no hosts to add). */
  teams?: TeamOption[];
  /** Owner or admin: the team links (new team event, team page) are theirs
   *  alone; the API refuses them to a plain member. */
  canManageTeams?: boolean;
  /** Owner or admin: the Tracking and pixels section shows (Meta Pixel and
   *  PostHog, open to every workspace). Off: the section is not
   *  shown and the save never sends the field, so the stored ids stay as they
   *  are. */
  trackingEnabled?: boolean;
  /** The deployment also lets this workspace load Google Tag Manager, Google
   *  Analytics and HubSpot (`/me`'s `eventTrackingHostScriptsEnabled`). Off:
   *  those fields are not shown, and whatever they hold goes back unchanged on
   *  save. */
  hostScriptsEnabled?: boolean;
  /** The host's connected calendars, for the editable "Calendars for this
   *  event" section (PHASE 2) — omitted for TEAM events (each host has their
   *  own connection; a single per-event picker here would be misleading). */
  connections?: Connection[];
  /** When set (the dedicated /new surface), navigate here after a create. */
  redirectOnSuccess?: string;
  /** FormHeader nav + title (the admin screen header system). */
  backHref: string;
  backLabel: string;
  heading: string;
  /** Rendered in the header next to Save — the edit surface mounts the
   *  open-public/copy-link quick actions here (QA4 fix 3). */
  headerExtras?: ReactNode;
  /**
   * H2 (#108) — the account's CRM contact properties, read server-side.
   * Omitted, or with a null `provider`, means no CRM adapter is wired on this
   * deployment and the mapping section does not render at all.
   */
  crmCatalog?: CrmPropertyCatalog;
  /** Resolves the Select primitives' own search/no-results copy. */
  locale?: 'en' | 'es';
}) {
  // Declared before the state that reads it: the mapping list is stored keyed
  // by provider, and with no adapter wired there is no key to read.
  const crmProvider = crmCatalog?.provider ?? null;
  const router = useRouter();
  // Every value the host edits lives in ONE draft (see `draft.ts`), so the
  // editor's parts share it and the save is a pure function of it. The setters
  // below keep the names this component always used.
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    initialDraft({ initial, crmProvider, teamMembers, connections }),
  );
  const setter =
    <K extends keyof EventTypeDraft>(key: K) =>
    (value: EventTypeDraft[K] | ((prev: EventTypeDraft[K]) => EventTypeDraft[K])) =>
      dispatch({ type: 'set', key, value } as DraftAction);
  const {
    title,
    slug,
    slugTouched,
    description,
    locationKind,
    locationDetail,
    lengthMinutes,
    minNotice,
    windowDays,
    slotInterval,
    beforeBuf,
    afterBuf,
    seats,
    scheduleId,
    requiresConfirmation,
    preventDuplicateBookings,
    hidden,
    redirectUrl,
    redirectData,
    trackingDraft,
    reminders,
    fields,
    crmMappings,
    conflictIds,
    destinationId,
    schedulingType,
    rrDistribution,
    hosts,
  } = draft;
  const setTitle = setter('title');
  const setSlug = setter('slug');
  const setSlugTouched = setter('slugTouched');
  const setDescription = setter('description');
  const setLocationKind = setter('locationKind');
  const setLocationDetail = setter('locationDetail');
  const setLength = setter('lengthMinutes');
  const setMinNotice = setter('minNotice');
  const setWindowDays = setter('windowDays');
  const setSlotInterval = setter('slotInterval');
  const setBeforeBuf = setter('beforeBuf');
  const setAfterBuf = setter('afterBuf');
  const setSeats = setter('seats');
  const setScheduleId = setter('scheduleId');
  const setRequiresConf = setter('requiresConfirmation');
  const setPreventDuplicate = setter('preventDuplicateBookings');
  const setHidden = setter('hidden');
  const setRedirectUrl = setter('redirectUrl');
  const setRedirectData = setter('redirectData');
  const setTrackingDraft = setter('trackingDraft');
  const setReminders = setter('reminders');
  const setFields = setter('fields');
  const setCrmMappings = setter('crmMappings');
  const setConflictIds = setter('conflictIds');
  const setDestinationId = setter('destinationId');
  const setSchedulingType = setter('schedulingType');
  const setRrDistribution = setter('rrDistribution');
  const setHosts = setter('hosts');

  // The booking window's error waits for a blur or a save attempt.
  const [windowChecked, setWindowChecked] = useState(false);
  const windowInputRef = useRef<HTMLInputElement>(null);
  const windowInvalid =
    windowDays !== '' && (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_BOOKING_WINDOW_DAYS);
  // Redirect after booking. The error waits for a blur or a save attempt, so
  // typing the address is not interrupted by it on the first keystroke.
  const [redirectChecked, setRedirectChecked] = useState(false);
  const redirectTrimmed = redirectUrl.trim();
  const redirectInvalid = redirectTrimmed !== '' && !isSuccessRedirectUrl(redirectTrimmed);
  const redirectHintId = useId();
  const redirectDataHintId = useId();
  const redirectErrorId = useId();
  const redirectInputRef = useRef<HTMLInputElement>(null);
  // Tracking and pixels: one text per vendor, '' = off. Same wait as above
  // before an error shows: a blur of that field, or a save attempt.
  const [trackingChecked, setTrackingChecked] = useState<Set<TrackingKey>>(() => new Set());
  const trackingKeys = trackingKeysShown(hostScriptsEnabled);
  const trackingInvalid = invalidTrackingKeys(trackingDraft, trackingKeys);
  const trackingInputRefs = useRef<Partial<Record<TrackingKey, HTMLInputElement | HTMLSelectElement | null>>>({});
  const eventTeamId = initial?.teamId ?? teamId;
  const isTeamEvent = !!eventTeamId && !!teamMembers && !!scheduling;
  const toggleConflict = (id: string) =>
    setConflictIds((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Equal distribution ranks hosts by bookings alone, so priority and weight
  // have nothing to say there.
  const ranksHosts =
    schedulingType !== 'collective' && !(schedulingType === 'round_robin' && rrDistribution === 'equal');
  const setHost = (memberId: string, patch: Partial<HostRow>) =>
    setHosts((hs) => hs.map((h) => (h.memberId === memberId ? { ...h, ...patch } : h)));
  /** Swap a question with its neighbour — bookingFields is an ordered array and
   *  every render already respects it; this is the only reorder UI (QA3 fix 6b). */
  const moveField = (i: number, dir: -1 | 1) =>
    setFields((fs) => {
      const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const { success } = useToast();

  // Country options for phone questions, alphabetical by (EN) name. Filled
  // AFTER mount (QA4-B1): Intl.DisplayNames region names differ between
  // Node's ICU and the browser's (e.g. "Falkland Islands" vs "… (Islas
  // Malvinas)"), so naming them during SSR guarantees a hydration mismatch.
  const [countryOptions, setCountryOptions] = useState<
    Array<{ code: string; dial: string; flag: string; name: string }>
  >([]);
  useEffect(() => {
    setCountryOptions(
      [...COUNTRIES]
        .map((c) => ({ ...c, name: countryName(c.code) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, []);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugTouched) setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  };

  const save = () => {
    // The API refuses it too; stopping here keeps the reason beside the field,
    // and focus goes there, since the field sits far below the Save button.
    if (windowInvalid) {
      setWindowChecked(true);
      windowInputRef.current?.focus();
      return;
    }
    // Reserved names are a hard stop, not just the inline warning — saving one
    // would make the public page ask the attendee twice (QA3 fix 3).
    if (fields.some((f) => f.name && isReservedFieldName(f.name))) {
      setRes({ ok: false, message: m.reservedBlocked });
      return;
    }
    // The API refuses it too; stopping here keeps the reason beside the field,
    // and focus goes there, since the field sits far below the Save button.
    if (redirectInvalid) {
      setRedirectChecked(true);
      redirectInputRef.current?.focus();
      return;
    }
    if (trackingEnabled && trackingInvalid.length > 0) {
      setTrackingChecked(new Set(trackingKeys));
      trackingInputRefs.current[trackingInvalid[0]!]?.focus();
      return;
    }
    start(async () => {
      const payload = toPayload(draft, {
        initial,
        crmProvider,
        trackingEnabled,
        isTeamEvent,
        teamId,
        hasConnections: !!connections,
      });
      const r = await saveEventTypeAction(payload);
      setRes(r);
      // Success is a TOAST, not a quiet line below the fold — the old inline
      // "Saved." was easy to miss (QA4 fix 2). Errors stay inline (persistent).
      if (r.ok) success(m.saved);
      // Create on a dedicated /new surface → return to the list on success.
      if (r.ok && !initial && redirectOnSuccess) router.push(redirectOnSuccess);
    });
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }}>
      <FormHeader
        gutter="responsive"
        backHref={backHref}
        backLabel={backLabel}
        title={heading}
        actions={
          <span className="flex items-center gap-field">
            {headerExtras}
            <Button type="submit" disabled={pending || !title || !slug}>
              {pending ? m.saving : initial ? m.saveChanges : m.createEventType}
            </Button>
          </span>
        }
      />
      <div className="flex flex-col gap-card rounded-md border border-border bg-card p-card">
      <div className="grid grid-cols-2 gap-field">
        <Field label={m.fTitle}>
          <input value={title} onChange={(e) => onTitle(e.target.value)} className={inputCls} />
        </Field>
        <Field label={m.fSlug}>
          <input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} className={inputCls} />
        </Field>
      </div>
      <Field label={m.fDescription}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputCls} />
      </Field>
      <LocationField
        kind={locationKind}
        detail={locationDetail}
        onKind={setLocationKind}
        onDetail={setLocationDetail}
        connections={connections}
        teamHosts={isTeamEvent ? teamMembers : undefined}
        schedulingType={schedulingType}
        fixedHostIds={hosts.filter((h) => h.isFixed).map((h) => h.memberId)}
        m={m}
        locationLabels={locationLabels}
        locale={locale}
      />
      <div className="grid grid-cols-3 gap-field">
        <Field label={m.fLength}>
          <input type="number" value={lengthMinutes} onChange={(e) => setLength(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fSlotInterval}>
          <input type="number" value={slotInterval} onChange={(e) => setSlotInterval(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fMinNotice}>
          <input type="number" value={minNotice} onChange={(e) => setMinNotice(Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-field">
        <Field label={m.fBufferBefore}>
          <input type="number" value={beforeBuf} onChange={(e) => setBeforeBuf(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fBufferAfter}>
          <input type="number" value={afterBuf} onChange={(e) => setAfterBuf(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fSeats}>
          <input type="number" min={1} placeholder="1" value={seats} onChange={(e) => setSeats(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <BookingWindowField
        inputRef={windowInputRef}
        value={windowDays}
        onChange={setWindowDays}
        onBlur={() => setWindowChecked(true)}
        invalid={windowChecked && windowInvalid}
        m={m.bookingWindow}
      />
      <Field label={m.fSchedule}>
        <select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} className={inputCls}>
          <option value="">
            {schedules.length ? m.useDefaultSchedule : m.noSchedules}
          </option>
          {schedules.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      {connections ? (
        <CalendarsForEventSection
          connections={connections}
          conflictIds={conflictIds}
          destinationId={destinationId}
          onToggleConflict={toggleConflict}
          onSetDestination={setDestinationId}
          m={m}
        />
      ) : null}

      {/* Where a team event shows its Hosts block, a personal one says it has
          none and points at team events, so the question "where do I add my
          team?" has an answer in the same place in either editor. */}
      {!isTeamEvent && teams ? (
        <PersonalHostsCard
          teams={teams}
          title={m.hostsTitle}
          canManageTeams={canManageTeams}
          m={m.teamHosts}
        />
      ) : null}

      {isTeamEvent && scheduling ? (
        <div className="flex flex-col gap-card rounded-md border border-border bg-background/40 p-card">
          <Field label={m.schedulingMethod}>
            <select
              value={schedulingType}
              onChange={(e) => setSchedulingType(e.target.value as SchedulingMethod)}
              className={inputCls}
            >
              {SCHEDULING_METHODS.map((method) => (
                <option key={method} value={method}>
                  {scheduling[method]}
                </option>
              ))}
            </select>
            <span className="mt-tight text-xs text-muted-foreground">{scheduling[`${schedulingType}_hint`]}</span>
          </Field>
          {schedulingType === 'round_robin' ? (
            <Field label={scheduling.distribution}>
              <select
                value={rrDistribution}
                onChange={(e) => setRrDistribution(e.target.value === 'equal' ? 'equal' : 'availability')}
                className={inputCls}
              >
                <option value="availability">{scheduling.availability}</option>
                <option value="equal">{scheduling.equal}</option>
              </select>
              <span className="mt-tight text-xs text-muted-foreground">{scheduling[`${rrDistribution}_hint`]}</span>
            </Field>
          ) : null}

          <div className="flex flex-col gap-inline">
            <span className="text-sm font-semibold text-muted-foreground">{m.hostsTitle}</span>
            {eventTeamId && teamName ? (
              <TeamHostsNote
                teamId={eventTeamId}
                teamName={teamName}
                canManageTeams={canManageTeams}
                m={m.teamHosts}
              />
            ) : null}
            <HostReadiness
              hosts={teamMembers ?? []}
              collective={schedulingType === 'collective'}
              m={m.teamHosts}
              locale={locale}
            />
            {/* Who a booking goes to, then the column header: only the fields
                the active method actually uses. Below `sm` the header is
                hidden and each control carries its own label (HostCell): the
                three columns do not fit beside a name at 360px. */}
            {ranksHosts ? (
              <>
                <p className="text-xs text-muted-foreground">{m.priorityHint}</p>
                <div className="hidden items-center gap-field px-field text-xs text-muted-foreground sm:flex">
                  <span className="flex-1" />
                  <span className="w-28 text-center">{m.priority}</span>
                  <span className="w-20 text-center">{m.weight}</span>
                  {schedulingType === 'fixed_round_robin' ? (
                    <span className="w-16 text-center">{m.fixedHost}</span>
                  ) : null}
                </div>
              </>
            ) : null}
            {hosts.map((h) => {
              const name = teamMembers!.find((tm) => tm.memberId === h.memberId)?.displayName ?? h.memberId;
              return (
                <div
                  key={h.memberId}
                  className="flex flex-col gap-inline rounded-md border border-border bg-card px-field py-inline sm:flex-row sm:items-center sm:gap-field"
                >
                  <span className="text-sm sm:flex-1">{name}</span>
                  {ranksHosts ? (
                    <>
                      <HostCell label={m.priority}>
                        <HostPrioritySelect
                          hostName={name}
                          value={h.priority}
                          onChange={(priority) => setHost(h.memberId, { priority })}
                          m={m}
                          locale={locale}
                        />
                      </HostCell>
                      <HostCell label={m.weight}>
                        <input
                          type="number"
                          min={1}
                          aria-label={`${name}: ${m.weight}`}
                          value={h.weight ?? 100}
                          onChange={(e) => setHost(h.memberId, { weight: Number(e.target.value) })}
                          className="w-20 rounded-md border border-input bg-background px-inline py-tight text-center text-sm"
                        />
                      </HostCell>
                      {schedulingType === 'fixed_round_robin' ? (
                        <HostCell label={m.fixedHost}>
                          <label className="flex w-16 cursor-pointer justify-end sm:justify-center" title={m.fixedHostHint}>
                            <Checkbox
                              aria-label={`${name}: ${m.fixedHost}`}
                              checked={h.isFixed}
                              onChange={(e) => setHost(h.memberId, { isFixed: e.target.checked })}
                            />
                          </label>
                        </HostCell>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Booking-policy booleans. The duplicate-booking guard (#69) joins the
          row a host already reads for this class of setting, rather than
          opening a section of its own. */}
      <div className="flex flex-col gap-inline">
        <div className="flex flex-wrap gap-x-group gap-y-inline">
          <label className="flex cursor-pointer items-center gap-inline text-sm">
            <Checkbox checked={requiresConfirmation} onChange={(e) => setRequiresConf(e.target.checked)} />
            {m.requiresConfirmation}
          </label>
          <label className="flex cursor-pointer items-center gap-inline text-sm">
            <Checkbox checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            {m.hiddenLabel}
          </label>
          <label className="flex cursor-pointer items-center gap-inline text-sm">
            <Checkbox
              checked={preventDuplicateBookings}
              onChange={(e) => setPreventDuplicate(e.target.checked)}
            />
            {m.duplicateGuard.label}
          </label>
        </div>
        {/* Always visible, not gated on the checkbox: the hint carries the
            caveat that the guard confirms an address has a booking, and a
            caveat shown only after you tick the box informs nothing. */}
        <p className="text-xs text-muted-foreground">{m.duplicateGuard.hint}</p>
      </div>

      {/* One-off invite links (#110). Directly under the visibility checkbox on
          purpose: the warning it renders is ABOUT that checkbox, and a host who
          reads "this event is visible, so a link limits nothing" needs the
          control that fixes it in the same eyeful. Reads `hidden` from live form
          state rather than from the saved event, so ticking Hidden clears the
          warning immediately instead of after a save. */}
      <OneOffLinksSection
        eventTypeId={initial?.id}
        eventIsPublic={!hidden}
        m={m}
        locale={locale}
      />

      {/* Redirect after booking: what happens once somebody books, so it sits
          with the booking-policy settings above rather than in a section of
          its own. The hint stays visible and the error joins it, because the
          hint is what says reschedules and cancellations never redirect. */}
      <div className="flex flex-col gap-tight">
        <Field label={m.successRedirect.label}>
          {/* `text` with a URL keyboard, not `type="url"`: this form has no
              `noValidate`, and the browser's own bubble would fire first. */}
          <input
            ref={redirectInputRef}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_SUCCESS_REDIRECT_URL}
            placeholder={m.successRedirect.placeholder}
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            onBlur={() => setRedirectChecked(true)}
            aria-invalid={redirectChecked && redirectInvalid ? true : undefined}
            aria-describedby={redirectChecked && redirectInvalid ? `${redirectErrorId} ${redirectHintId}` : redirectHintId}
            className={inputCls}
          />
        </Field>
        {redirectChecked && redirectInvalid ? (
          <p id={redirectErrorId} className="text-xs text-destructive" role="alert">
            {m.successRedirect.invalid}
          </p>
        ) : null}
        <p id={redirectHintId} className="text-xs text-muted-foreground">
          {m.successRedirect.hint}
        </p>
        {redirectUrl.trim() ? (
          <>
            <Field label={m.successRedirect.dataLabel}>
              <select
                value={redirectData}
                onChange={(e) => setRedirectData(e.target.value as SuccessRedirectData | '')}
                aria-describedby={redirectDataHintId}
                className={inputCls}
              >
                <option value="">{m.successRedirect.dataNone}</option>
                <option value="event">{m.successRedirect.dataEvent}</option>
                <option value="event_and_invitee">{m.successRedirect.dataEventAndInvitee}</option>
              </select>
            </Field>
            <p id={redirectDataHintId} className="text-xs text-muted-foreground">
              {m.successRedirect.dataHint}
            </p>
          </>
        ) : null}
      </div>

      {trackingEnabled ? (
        <TrackingSection
          draft={trackingDraft}
          onChange={(key, value) => setTrackingDraft((d) => ({ ...d, [key]: value }))}
          onBlur={(key) => setTrackingChecked((c) => new Set(c).add(key))}
          invalid={trackingInvalid.filter((key) => trackingChecked.has(key))}
          inputRefs={trackingInputRefs}
          keys={trackingKeys}
          hostScriptsEnabled={hostScriptsEnabled}
          m={m.tracking}
        />
      ) : null}

      {/* Intake questions */}
      <div className="flex flex-col gap-inline">
        <span className="text-sm font-semibold text-muted-foreground">{m.intakeQuestions}</span>
        {/* Built-in fields the public booking page ALWAYS asks — shown locked so
            nobody re-creates "name"/"email" as custom questions and the attendee
            gets asked twice (QA2 fix 7). */}
        <p className="text-xs text-muted-foreground">{m.fixedFieldsHint}</p>
        {[
          { label: m.fixedName, required: true },
          { label: m.fixedEmail, required: true },
          { label: m.fixedNotes, required: false },
        ].map((bf) => (
          <div
            key={bf.label}
            className="flex items-center gap-inline rounded-md border border-dashed border-border bg-background/40 px-field py-inline text-sm text-muted-foreground"
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span className="flex-1">
              {bf.label}
              {bf.required ? ' *' : ''}
            </span>
            <span className="text-xs uppercase tracking-wide">{m.alwaysAsked}</span>
          </div>
        ))}
        {fields.map((f, i) => (
          <div key={i} className="flex flex-col gap-tight">
            <div className="flex items-center gap-inline">
              <input
                placeholder={m.namePlaceholder}
                value={f.name}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') } : x)))}
                className="w-28 rounded-md border border-input bg-background px-inline py-tight text-sm"
              />
              <input
                placeholder={m.labelPlaceholder}
                value={f.label}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className="flex-1 rounded-md border border-input bg-background px-inline py-tight text-sm"
              />
              <select
                value={f.type}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                className="rounded-md border border-input bg-background px-inline py-tight text-sm"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {f.type === 'phone' ? (
                // Which country the phone selector starts on for attendees
                // (QA4 fix 1b) — stored inside the question definition.
                <select
                  value={f.defaultCountry ?? 'US'}
                  onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, defaultCountry: e.target.value } : x)))}
                  aria-label={`${m.defaultCountryLabel} — ${f.label || f.name}`}
                  title={m.defaultCountryLabel}
                  className="w-36 rounded-md border border-input bg-background px-inline py-tight text-sm"
                >
                  {countryOptions.length === 0 ? (
                    // SSR/first paint: a bare-code option so the select's value
                    // resolves identically on server and client (QA4-B1); the
                    // named list replaces it right after mount.
                    <option value={f.defaultCountry ?? 'US'}>{f.defaultCountry ?? 'US'}</option>
                  ) : (
                    countryOptions.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.flag} {c.name} {c.dial}
                      </option>
                    ))
                  )}
                </select>
              ) : null}
              <label className="flex cursor-pointer items-center gap-tight text-sm">
                <Checkbox checked={f.required} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                {m.req}
              </label>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveField(i, -1)}
                aria-label={`${m.moveUp} — ${f.label || f.name}`}
                className="text-muted-foreground transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
              >
                <ChevronIcon direction="up" />
              </button>
              <button
                type="button"
                disabled={i === fields.length - 1}
                onClick={() => moveField(i, 1)}
                aria-label={`${m.moveDown} — ${f.label || f.name}`}
                className="text-muted-foreground transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
              >
                <ChevronIcon direction="down" />
              </button>
              <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">×</button>
            </div>
            {isReservedFieldName(f.name) ? (
              <p className="text-xs text-destructive" role="alert">
                {m.reservedWarning}
              </p>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFields((fs) => [...fs, { name: '', label: '', type: 'text', required: false }])}
          className="self-start rounded-md border border-border px-field py-tight text-sm text-muted-foreground hover:border-primary"
        >
          {m.addQuestion}
        </button>
      </div>

      {/* Reminders — below intake, because their {{form.*}} variables read the
          questions defined right above them. */}
      <RemindersSection
        rows={reminders}
        setRows={(fn) => setReminders(fn)}
        fieldNames={fields.filter((f) => f.name && !isReservedFieldName(f.name)).map((f) => f.name)}
        m={m.reminders}
      />

      {/* CRM property mapping (H2 / #108) — last, so Reminders keeps its
          adjacency to the intake questions its {{form.*}} variables read.
          Absent entirely when no CRM adapter is wired on this deployment. */}
      {crmCatalog && crmProvider ? (
        <CrmMappingSection
          provider={crmProvider}
          catalog={crmCatalog}
          fields={fields.filter((f) => f.name)}
          mappings={crmMappings}
          onChange={setCrmMappings}
          m={m.crmMapping}
          locale={locale}
        />
      ) : null}

      {res && !res.ok ? <p className="text-sm text-destructive">{res.message}</p> : null}
      </div>
    </form>
  );
}

export type { EventTypeMessages, TeamMemberOption } from './sections/shared';
