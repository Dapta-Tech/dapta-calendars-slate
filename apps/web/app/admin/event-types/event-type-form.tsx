'use client';

import { useEffect, useId, useReducer, useRef, useState, useTransition, type MouseEvent, type ReactNode } from 'react';
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
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { saveEventTypeAction, type ActionResult } from './actions';
import { draftReducer, initialDraft, prefillCustomHours, toPayload, type DraftAction, type EventTypeDraft } from './draft';
import { ErrorSummary } from './error-summary';
import {
  EDITOR_TABS,
  FIELD_IDS,
  errorCounts,
  firstError,
  validateDraft,
  type EditorTab,
  type FieldError,
} from './validation';
import { AdvancedSettings, advancedSummary } from './sections/advanced';
import { AgentsTab } from './sections/agents';
import { DurationField } from './sections/duration';
import {
  AvailabilityField,
  type AvailabilitySource,
  type ScheduleRule,
} from './sections/availability';
import { openDraftPreview } from './draft-preview';
import { ChevronIcon, EventTypeMessages, FIELD_TYPES, Field, HostCell, HostRow, SCHEDULING_METHODS, SchedulingMethod, TeamMemberOption, errorAria, inputCls } from './sections/shared';
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
  mcpUrl,
  workingHours,
}: {
  initial?: EventType;
  schedules?: Array<{ id: string; name: string; isDefault?: boolean }>;
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
  /** The MCP server address agents connect to (AI Agents tab); null when this
   *  installation offers no sign-in connection. */
  mcpUrl?: string | null;
  /** The host's working hours: shown under "My working hours", and where
   *  custom hours start from. */
  workingHours?: { timeZone: string; rules: ScheduleRule[] } | null;
}) {
  // Declared before the state that reads it: the mapping list is stored keyed
  // by provider, and with no adapter wired there is no key to read.
  const crmProvider = crmCatalog?.provider ?? null;
  const router = useRouter();
  // Every value the host edits lives in ONE draft (see `draft.ts`), so the
  // editor's parts share it and the save is a pure function of it. The setters
  // below keep the names this component always used.
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    initialDraft({ initial, crmProvider, teamMembers, connections, workingHours }),
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
  const setAvailabilitySource = setter('availabilitySource');
  const setCustomHours = setter('customHours');

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

  // --- Tabs, validation and guidance -------------------------------------
  // One error list (`validateDraft`) drives the message under each field, the
  // count on each tab, the summary at the top and the save's jump to the
  // first error. Errors wait for a blur of that field or a save attempt.
  const editor = m.editor;
  const crmTabShown = (!!crmCatalog && !!crmProvider) || trackingEnabled;
  const tabItems = EDITOR_TABS.filter((t) => t !== 'crm' || crmTabShown);
  const [activeTab, setActiveTab] = useState<EditorTab>('general');
  // The active tab lives in the URL (`?tab=`), so a reload or a shared link
  // opens the same tab. Read after mount: the server render has no URL here.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted && (tabItems as readonly string[]).includes(wanted)) setActiveTab(wanted as EditorTab);
  }, []);
  const selectTab = (tab: EditorTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === 'general') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(window.history.state, '', url);
  };

  const [advancedOpen, setAdvancedOpen] = useState(() => advancedSummary(draft, editor.advanced).custom);
  const advanced = advancedSummary(draft, editor.advanced);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const touch = (fieldId: string) => setTouched((t) => (t.has(fieldId) ? t : new Set(t).add(fieldId)));
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [serverPlain, setServerPlain] = useState<string[]>([]);
  const errors = validateDraft(draft, { m, trackingEnabled, trackingKeys, isTeamEvent });
  const visibleErrors = submitAttempted ? [...errors, ...serverErrors] : serverErrors;
  const counts = errorCounts(visibleErrors);
  const errorFor = (fieldId: string): string | null => {
    const server = serverErrors.find((e) => e.fieldId === fieldId);
    if (server) return server.message;
    if (!submitAttempted && !touched.has(fieldId)) return null;
    return errors.find((e) => e.fieldId === fieldId)?.message ?? null;
  };
  const tabLabels: Record<EditorTab, string> = editor.tabs;

  // Going to an error: open its tab and section, then focus it once they are
  // rendered (an effect, so it runs after the commit that un-hides them).
  const [pendingFocus, setPendingFocus] = useState<FieldError | null>(null);
  const goToError = (e: FieldError) => {
    if (e.tab !== activeTab) selectTab(e.tab);
    if (e.section === 'advanced') setAdvancedOpen(true);
    setPendingFocus(e);
  };
  useEffect(() => {
    if (!pendingFocus) return;
    const el = document.getElementById(pendingFocus.fieldId);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  // Unsaved changes: the back link asks first, and so does leaving the page.
  const [dirty, setDirty] = useState(false);
  const firstDraft = useRef(draft);
  useEffect(() => {
    if (draft !== firstDraft.current) setDirty(true);
  }, [draft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const { confirm, dialog } = useConfirmDialog(locale);
  const onBack = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!dirty) return;
    e.preventDefault();
    void confirm({
      title: editor.unsaved.title,
      message: editor.unsaved.body,
      confirmLabel: editor.unsaved.confirm,
      cancelLabel: editor.unsaved.cancel,
      destructive: true,
    }).then((discard) => {
      if (!discard) return;
      setDirty(false);
      router.push(backHref);
    });
  };

  /** The availability source. Custom hours start from the working hours the
   *  first time; a saved schedule starts on the first one. */
  const onAvailabilitySource = (next: AvailabilitySource) => {
    if (next === 'custom' && draft.customHours.ranges.length === 0) setCustomHours(prefillCustomHours(workingHours));
    if (next === 'saved' && !scheduleId && schedules[0]) setScheduleId(schedules[0].id);
    setAvailabilitySource(next);
  };

  // What the event looks like right now, unsaved changes included: the eye
  // button draws it as the booking page in a new tab, and each reminder's
  // preview renders the real email around it.
  const draftLocation = locationKind
    ? { kind: locationKind, detail: locationKind === 'conferencing' ? null : locationDetail.trim() || null }
    : null;
  const draftQuestions = fields.filter((f) => f.name && f.label && !isReservedFieldName(f.name));
  const previewPage = () =>
    openDraftPreview(
      {
        title,
        description: description.trim() || null,
        lengthMinutes: Number.isFinite(lengthMinutes) ? lengthMinutes : 30,
        location: draftLocation,
        bookingFields: draftQuestions as Parameters<typeof openDraftPreview>[0]['bookingFields'],
      },
      isTeamEvent ? eventTeamId : null,
    );
  const reminderContext = {
    title: title.trim() || heading,
    description: description.trim() || null,
    lengthMinutes: Number.isFinite(lengthMinutes) && lengthMinutes > 0 ? lengthMinutes : 30,
    location: draftLocation,
    questions: draftQuestions.map((f) => ({ name: f.name, label: f.label })),
  };

  /** Duration, carrying the slot interval along while it still follows it. */
  const onDuration = (minutes: number) => {
    if (slotInterval === lengthMinutes && Number.isFinite(minutes)) setSlotInterval(minutes);
    setLength(minutes);
  };

  const save = () => {
    setSubmitAttempted(true);
    setServerErrors([]);
    setServerPlain([]);
    // The components that keep their own "checked" state show their errors too.
    setWindowChecked(true);
    setRedirectChecked(true);
    if (trackingEnabled) setTrackingChecked(new Set(trackingKeys));
    const first = firstError(errors);
    if (first) {
      goToError(first);
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
      if (r.ok) {
        // Success is a TOAST, not a quiet line below the fold — the old inline
        // "Saved." was easy to miss (QA4 fix 2).
        success(m.saved);
        setDirty(false);
        firstDraft.current = draft;
        // Create on a dedicated /new surface → return to the list on success.
        if (!initial && redirectOnSuccess) router.push(redirectOnSuccess);
        return;
      }
      // A refusal that names a field points at it, like the editor's own checks.
      const mapped = serverFieldErrors(r, editor.errors);
      setServerErrors(mapped);
      setServerPlain(mapped.length ? [] : [r.message ?? editor.errors.summaryOne]);
      if (mapped[0]) goToError(mapped[0]);
    });
  };

  const sectionHeading = (text: string) => (
    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{text}</h2>
  );
  const fieldError = (fieldId: string) => {
    const error = errorFor(fieldId);
    return { error, errorId: `${fieldId}-error`, aria: errorAria(error, `${fieldId}-error`) };
  };
  const titleErr = fieldError(FIELD_IDS.title);
  const slugErr = fieldError(FIELD_IDS.slug);
  const minNoticeErr = fieldError(FIELD_IDS.minNotice);
  const beforeErr = fieldError(FIELD_IDS.beforeBuf);
  const afterErr = fieldError(FIELD_IDS.afterBuf);
  const seatsErr = fieldError(FIELD_IDS.seats);
  const intervalErr = fieldError(FIELD_IDS.slotInterval);

  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      <FormHeader
        gutter="responsive"
        backHref={backHref}
        backLabel={backLabel}
        title={heading}
        onBack={onBack}
        actions={
          <span className="flex items-center gap-field">
            {headerExtras}
            <button
              type="button"
              onClick={previewPage}
              aria-label={editor.preview.eye}
              title={editor.preview.eye}
              data-testid="et-preview-page"
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              <i aria-hidden className="pi pi-eye" style={{ fontSize: 15 }} />
            </button>
            <Button type="submit" disabled={pending}>
              {pending ? m.saving : initial ? m.saveChanges : m.createEventType}
            </Button>
          </span>
        }
      />
      {dialog}
      <div className="flex min-w-0 flex-col gap-card">
        <ErrorSummary
          errors={visibleErrors}
          plain={serverPlain}
          tabLabels={tabLabels}
          onGo={goToError}
          m={editor.errors}
        />
        <Tabs
          items={tabItems.map((id) => ({
            id,
            label: tabLabels[id],
            badge: counts[id],
            badgeLabel:
              counts[id] === 1 ? editor.tabErrorsOne : editor.tabErrorsMany.replace('{count}', String(counts[id])),
          }))}
          active={activeTab}
          onChange={selectTab}
          idPrefix="et"
          label={editor.tabsLabel}
        />

        {/* --- General ------------------------------------------------------ */}
        <TabPanel id="general" idPrefix="et" active={activeTab === 'general'}>
          <div className="flex flex-col gap-section rounded-md border border-border bg-card p-card">
            <section className="flex flex-col gap-field">
              {sectionHeading(editor.sections.basics)}
              <p className="text-xs text-muted-foreground">{editor.requiredLegend}</p>
              <div className="grid grid-cols-1 gap-field sm:grid-cols-2">
                <Field
                  label={m.fTitle}
                  required
                  requiredLabel={editor.required}
                  error={titleErr.error}
                  errorId={titleErr.errorId}
                >
                  <input
                    id={FIELD_IDS.title}
                    value={title}
                    onChange={(e) => onTitle(e.target.value)}
                    onBlur={() => touch(FIELD_IDS.title)}
                    className={inputCls}
                    {...titleErr.aria}
                  />
                </Field>
                <Field
                  label={editor.slugLabel}
                  required
                  requiredLabel={editor.required}
                  error={slugErr.error}
                  errorId={slugErr.errorId}
                >
                  <input
                    id={FIELD_IDS.slug}
                    value={slug}
                    onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
                    onBlur={() => touch(FIELD_IDS.slug)}
                    className={inputCls}
                    {...slugErr.aria}
                  />
                </Field>
              </div>
              <Field label={m.fDescription}>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputCls} />
              </Field>
              <DurationField
                value={lengthMinutes}
                onChange={onDuration}
                onBlur={() => touch(FIELD_IDS.duration)}
                error={errorFor(FIELD_IDS.duration)}
                m={editor}
              />
              <LocationField
                kind={locationKind}
                detail={locationDetail}
                onKind={setLocationKind}
                onDetail={setLocationDetail}
                onDetailBlur={() => touch(FIELD_IDS.locationDetail)}
                detailError={errorFor(FIELD_IDS.locationDetail)}
                connections={connections}
                teamHosts={isTeamEvent ? teamMembers : undefined}
                schedulingType={schedulingType}
                fixedHostIds={hosts.filter((h) => h.isFixed).map((h) => h.memberId)}
                m={m}
                locationLabels={locationLabels}
                locale={locale}
              />
            </section>

            <section className="flex flex-col gap-field">
              {sectionHeading(editor.sections.availability)}
              <AvailabilityField
                source={draft.availabilitySource}
                onSource={onAvailabilitySource}
                scheduleId={scheduleId}
                onScheduleId={setScheduleId}
                schedules={schedules}
                workingHours={workingHours}
                customHours={draft.customHours}
                onCustomHours={setCustomHours}
                isTeam={isTeamEvent}
                errorFor={errorFor}
                locale={locale}
                m={editor.availability}
                savedLabel={m.fSchedule}
              />
              <div className="grid grid-cols-1 gap-field sm:grid-cols-2">
                <Field label={m.fMinNotice} error={minNoticeErr.error} errorId={minNoticeErr.errorId}>
                  <input
                    id={FIELD_IDS.minNotice}
                    type="number"
                    min={0}
                    value={Number.isFinite(minNotice) ? minNotice : ''}
                    onChange={(e) => setMinNotice(e.target.value === '' ? Number.NaN : Number(e.target.value))}
                    onBlur={() => touch(FIELD_IDS.minNotice)}
                    className={inputCls}
                    {...minNoticeErr.aria}
                  />
                </Field>
              </div>
            </section>

            {connections || (!isTeamEvent && teams) || (isTeamEvent && scheduling) ? (
              <section className="flex flex-col gap-field">
                {sectionHeading(editor.sections.hosts)}
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
              </section>
            ) : null}

            {/* Booking form: the questions the public page asks. */}
            <section className="flex flex-col gap-inline">
              {sectionHeading(editor.sections.bookingForm)}
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
                  <div className="flex flex-wrap items-center gap-inline">
                    <input
                      id={FIELD_IDS.questionName(i)}
                      placeholder={m.namePlaceholder}
                      value={f.name}
                      onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') } : x)))}
                      aria-invalid={isReservedFieldName(f.name) ? true : undefined}
                      className="w-28 rounded-md border border-input bg-background px-inline py-tight text-sm"
                    />
                    <input
                      placeholder={m.labelPlaceholder}
                      value={f.label}
                      onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      className="min-w-0 flex-1 rounded-md border border-input bg-background px-inline py-tight text-sm"
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
            </section>

            {/* After booking: what happens once somebody books. */}
            <section className="flex flex-col gap-field">
              {sectionHeading(editor.sections.afterBooking)}
              {/* Booking-policy booleans. The duplicate-booking guard (#69) joins the
                  row a host already reads for this class of setting. */}
              <div className="flex flex-col gap-inline">
                <div className="flex flex-wrap gap-x-group gap-y-inline">
                  <label className="flex cursor-pointer items-center gap-inline text-sm">
                    <Checkbox checked={requiresConfirmation} onChange={(e) => setRequiresConf(e.target.checked)} />
                    {m.requiresConfirmation}
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

              {/* Redirect after booking. The hint stays visible and the error joins
                  it, because the hint is what says reschedules and cancellations
                  never redirect. */}
              <div className="flex flex-col gap-tight">
                <Field label={m.successRedirect.label}>
                  {/* `text` with a URL keyboard, not `type="url"`: the browser's own
                      bubble must not fire before the editor's message. */}
                  <input
                    id={FIELD_IDS.redirectUrl}
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
            </section>

            {/* Visibility and sharing. One-off links sit directly under Hidden on
                purpose: the warning they render is ABOUT that checkbox (#110), and
                reads `hidden` from live form state so ticking it clears at once. */}
            <section className="flex flex-col gap-field">
              {sectionHeading(editor.sections.visibility)}
              <label className="flex cursor-pointer items-center gap-inline text-sm">
                <Checkbox checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
                {m.hiddenLabel}
              </label>
              <OneOffLinksSection
                eventTypeId={initial?.id}
                eventIsPublic={!hidden}
                m={m}
                locale={locale}
              />
            </section>

            <AdvancedSettings open={advancedOpen} onToggle={setAdvancedOpen} summary={advanced.text} m={editor.advanced}>
              <div className="grid grid-cols-1 gap-field sm:grid-cols-3">
                <Field label={m.fBufferBefore} error={beforeErr.error} errorId={beforeErr.errorId}>
                  <input
                    id={FIELD_IDS.beforeBuf}
                    type="number"
                    min={0}
                    value={Number.isFinite(beforeBuf) ? beforeBuf : ''}
                    onChange={(e) => setBeforeBuf(e.target.value === '' ? Number.NaN : Number(e.target.value))}
                    onBlur={() => touch(FIELD_IDS.beforeBuf)}
                    className={inputCls}
                    {...beforeErr.aria}
                  />
                </Field>
                <Field label={m.fBufferAfter} error={afterErr.error} errorId={afterErr.errorId}>
                  <input
                    id={FIELD_IDS.afterBuf}
                    type="number"
                    min={0}
                    value={Number.isFinite(afterBuf) ? afterBuf : ''}
                    onChange={(e) => setAfterBuf(e.target.value === '' ? Number.NaN : Number(e.target.value))}
                    onBlur={() => touch(FIELD_IDS.afterBuf)}
                    className={inputCls}
                    {...afterErr.aria}
                  />
                </Field>
                <Field label={m.fSeats} error={seatsErr.error} errorId={seatsErr.errorId}>
                  <input
                    id={FIELD_IDS.seats}
                    type="number"
                    min={1}
                    placeholder="1"
                    value={seats}
                    onChange={(e) => setSeats(e.target.value === '' ? '' : Number(e.target.value))}
                    onBlur={() => touch(FIELD_IDS.seats)}
                    className={inputCls}
                    {...seatsErr.aria}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-field sm:grid-cols-3">
                <Field label={m.fSlotInterval} error={intervalErr.error} errorId={intervalErr.errorId}>
                  <input
                    id={FIELD_IDS.slotInterval}
                    type="number"
                    min={1}
                    value={slotInterval}
                    onChange={(e) => setSlotInterval(e.target.value === '' ? '' : Number(e.target.value))}
                    onBlur={() => touch(FIELD_IDS.slotInterval)}
                    className={inputCls}
                    {...intervalErr.aria}
                  />
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
            </AdvancedSettings>
          </div>
        </TabPanel>

        {/* --- Reminders ---------------------------------------------------- */}
        <TabPanel id="reminders" idPrefix="et" active={activeTab === 'reminders'}>
          <div className="flex flex-col gap-card rounded-md border border-border bg-card p-card">
            {/* Their {{form.*}} variables read the questions defined in General. */}
            <RemindersSection
              rows={reminders}
              setRows={(fn) => setReminders(fn)}
              fieldNames={fields.filter((f) => f.name && !isReservedFieldName(f.name)).map((f) => f.name)}
              m={m.reminders}
              preview={{ context: reminderContext, m: editor.preview }}
            />
            {serverErrors
              .filter((e) => e.tab === 'reminders')
              .map((e) => (
                <p key={e.fieldId} className="text-xs text-destructive">
                  {e.message}
                </p>
              ))}
          </div>
        </TabPanel>

        {/* --- CRM Connection ----------------------------------------------- */}
        {crmTabShown ? (
          <TabPanel id="crm" idPrefix="et" active={activeTab === 'crm'}>
            <div className="flex flex-col gap-section rounded-md border border-border bg-card p-card">
              {/* CRM property mapping (H2 / #108). Absent entirely when no CRM
                  adapter is wired on this deployment. */}
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
            </div>
          </TabPanel>
        ) : null}

        {/* --- AI Agents ---------------------------------------------------- */}
        <TabPanel id="agents" idPrefix="et" active={activeTab === 'agents'}>
          <div className="rounded-md border border-border bg-card p-card">
            <AgentsTab eventTypeId={initial?.id} title={title} mcpUrl={mcpUrl} m={editor.agents} />
          </div>
        </TabPanel>

        {res && !res.ok && !serverErrors.length && !serverPlain.length ? (
          <p className="text-sm text-destructive">{res.message}</p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The fields an API refusal is about, as editor errors: a taken link, or a
 * reminder template naming a variable that does not exist. Anything else has
 * no field to point at and shows as plain text in the summary.
 */
function serverFieldErrors(r: ActionResult, e: EventTypeMessages['editor']['errors']): FieldError[] {
  if (r.code === 'SLUG_TAKEN') return [{ fieldId: FIELD_IDS.slug, tab: 'general', message: e.slugTaken }];
  if (r.code === 'INVALID_TEMPLATE' && r.issues?.length) {
    return r.issues
      .filter((i) => i.reminderId && (i.field === 'subject' || i.field === 'body'))
      .map((i) => ({
        fieldId: FIELD_IDS.reminder(i.reminderId!, i.field as 'subject' | 'body'),
        tab: 'reminders' as const,
        message: i.message ?? r.message ?? e.templateInvalid,
      }));
  }
  return [];
}

export type { EventTypeMessages, TeamMemberOption } from './sections/shared';
