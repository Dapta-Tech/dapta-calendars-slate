'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ALL_BOOKING_THEMES,
  DEFAULT_ACCENT,
  THEME_PRESETS,
  brandVars,
  widgetStyleVars,
  brandingClassOf,
  clampAccent,
  accentWasAdjusted,
  accentLabelContrast,
  buildMonthGrid,
  formatDayHeading,
  onAccent,
  matchTheme,
  monogram,
  t,
  weekStartsOnFor,
  type BookingMessages,
  type PublicBranding,
} from '@slate/shared';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { CopyLink } from '@/components/copy-link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { BOOKING_CANVAS } from '@/lib/booking-canvas';
import { ChevronIcon } from '@/components/booking-page-parts';
import { checkHandleAction, saveStudioAction, toggleEventHiddenAction } from './actions';

type StudioMessages = BookingMessages['admin']['studio'];

type Axes = Pick<
  PublicBranding,
  'template' | 'cardStyle' | 'corners' | 'buttons' | 'density' | 'font' | 'slotLayout' | 'dayGroup' | 'slotSelect'
>;

const AXIS_LABEL: Record<keyof Axes, keyof StudioMessages> = {
  template: 'axisTemplate',
  cardStyle: 'axisCardStyle',
  corners: 'axisCorners',
  buttons: 'axisButtons',
  density: 'axisDensity',
  font: 'axisFont',
  slotLayout: 'axisSlotLayout',
  dayGroup: 'axisDayGroup',
  slotSelect: 'axisSlotSelect',
};

const AXIS_OPTIONS: Record<keyof Axes, string[]> = {
  template: ['classic', 'split', 'banded'],
  cardStyle: ['outline', 'elevated', 'filled'],
  corners: ['sharp', 'soft', 'round'],
  buttons: ['rounded', 'pill', 'square'],
  density: ['comfortable', 'compact'],
  font: ['sans', 'rounded', 'serif'],
  slotLayout: ['grid', 'list'],
  dayGroup: ['flat', 'boxed'],
  slotSelect: ['soft', 'solid'],
};

const ACCENT_PRESETS = ['#cbe84f', '#9059fc', '#4f9cff', '#4fd18b', '#ff9f4f', '#ff6fae'];

interface EventTypeLite {
  slug: string;
  title: string;
  lengthMinutes: number;
}

/** Read an image file to a data-URL (like the old app): image/* only, ≤1MB.
 *  Returns a stable error code the caller localizes. */
function readImageFile(file: File): Promise<{ ok: true; dataUrl: string } | { ok: false; code: 'invalid' | 'tooLarge' | 'read' }> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve({ ok: false, code: 'invalid' });
    if (file.size > 1024 * 1024) return resolve({ ok: false, code: 'tooLarge' });
    const reader = new FileReader();
    reader.onload = () => resolve({ ok: true, dataUrl: String(reader.result) });
    reader.onerror = () => resolve({ ok: false, code: 'read' });
    reader.readAsDataURL(file);
  });
}

export interface StudioInit {
  accountCode: string;
  /** Vanity claim state: the shareable-link section renders from this. */
  vanity: { vanitySlug: string | null; shortCode: string; canClaim: boolean };
  /** Where "included with your Dapta AI subscription" links (deploy-config
   *  destination, same switch as the growth badge; null = plain text). */
  subscriptionUrl: string | null;
  displayName: string;
  handle: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  accent: string;
  axes: Axes;
  landingEnabled: boolean;
  defaultEventSlug: string | null;
  eventTypes: EventTypeLite[];
  manageableEvents: { id: string; slug: string; title: string; hidden: boolean }[];
  eventOrder: string[];
  messages: StudioMessages;
  /** 'en' | 'es' — the booking-flow preview's month grid is locale-shaped. */
  locale: string;
  /** Screen-reader suffix for the link that opens the public page (A2, #112). */
  opensNewTab: string;
}

type HandleState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export function Studio(init: StudioInit) {
  const m = init.messages;
  const [displayName, setDisplayName] = useState(init.displayName);
  const [handle, setHandle] = useState(init.handle);
  const [vanity, setVanity] = useState(init.vanity.vanitySlug ?? '');
  const [bio, setBio] = useState(init.bio);
  const [avatarUrl, setAvatarUrl] = useState(init.avatarUrl);
  const [coverUrl, setCoverUrl] = useState(init.coverUrl);
  const [accent, setAccent] = useState(init.accent);
  const [axes, setAxes] = useState<Axes>(init.axes);
  const [landingEnabled, setLandingEnabled] = useState(init.landingEnabled);
  const [defaultEventSlug, setDefaultEventSlug] = useState(init.defaultEventSlug ?? '');
  // Slug order: saved order first, then any events not yet in it.
  const [eventOrder, setEventOrder] = useState<string[]>(() => {
    const all = init.manageableEvents.map((e) => e.slug);
    const ordered = init.eventOrder.filter((s) => all.includes(s));
    return [...ordered, ...all.filter((s) => !ordered.includes(s))];
  });
  const [eventPending, startEvent] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const moveEvent = (slug: string, dir: -1 | 1) =>
    setEventOrder((o) => {
      const i = o.indexOf(slug);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const toggleHidden = (id: string, hidden: boolean) =>
    startEvent(async () => {
      const r = await toggleEventHiddenAction(id, hidden);
      if (r.ok) {
        toast.success(hidden ? m.eventHidden : m.eventShown);
        router.refresh();
      } else {
        toast.error(r.message ?? m.couldNotUpdateVisibility);
      }
    });
  const [customizeOpen, setCustomizeOpen] = useState(matchTheme(init.axes) === null);
  const [surface, setSurface] = useState<'profile' | 'booking'>('profile');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [handleState, setHandleState] = useState<HandleState>('idle');
  const [handleSuggestion, setHandleSuggestion] = useState<string | null>(null);
  const [saved, setSaved] = useState<'idle' | 'ok' | 'err'>('idle');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const snapshot = useMemo(
    () => JSON.stringify({ displayName, handle, vanity, bio, avatarUrl, coverUrl, accent, axes, landingEnabled, defaultEventSlug, eventOrder }),
    [displayName, handle, vanity, bio, avatarUrl, coverUrl, accent, axes, landingEnabled, defaultEventSlug, eventOrder],
  );
  const initialSnapshot = useRef(snapshot);
  const isDirty = snapshot !== initialSnapshot.current;

  const activeTheme = useMemo(() => matchTheme(axes), [axes]);
  // `brandVars`, not `accentVars`: the preview has to emit the PRODUCT accent
  // tokens too. Emitting only `--accent*` left `--primary-ink`/`--primary-edge`
  // resolving from the admin palette, so the preview drew the host's links and
  // rims in our lime while the real page drew them in the host's colour — the
  // exact "preview == prod" break ADR 0004 is written against. Same function and
  // same canvas as BrandedShell, so the two cannot drift.
  const previewVars = useMemo(
    () => ({ ...brandVars(accent, BOOKING_CANVAS), ...widgetStyleVars(axes) }) as Record<string, string>,
    [accent, axes],
  );
  const adjusted = accentWasAdjusted(accent, BOOKING_CANVAS);

  // Live handle availability (debounced, per-account).
  useEffect(() => {
    if (handle === init.handle) {
      setHandleState('idle');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle) || handle.length < 3) {
      setHandleState('invalid');
      return;
    }
    setHandleState('checking');
    const t = setTimeout(async () => {
      try {
        // Server action (identity-scoped endpoint — no client-side API fetch).
        const j = await checkHandleAction(handle);
        setHandleState(j.available ? 'available' : 'taken');
        setHandleSuggestion(j.available ? null : (j.suggestion ?? null));
      } catch {
        setHandleState('idle');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [handle, init.handle]);

  const applyTheme = (t: keyof typeof THEME_PRESETS) => setAxes({ ...THEME_PRESETS[t] });
  const setAxis = (k: keyof Axes, v: string) => setAxes((a) => ({ ...a, [k]: v as never }));
  const handleBlocksSave = handleState === 'taken' || handleState === 'invalid' || handleState === 'checking';

  const reset = () => {
    setDisplayName(init.displayName);
    setHandle(init.handle);
    setBio(init.bio);
    setAvatarUrl(init.avatarUrl);
    setCoverUrl(init.coverUrl);
    setAccent(init.accent);
    setAxes(init.axes);
    setLandingEnabled(init.landingEnabled);
    setDefaultEventSlug(init.defaultEventSlug ?? '');
    setEventOrder(() => {
      const all = init.manageableEvents.map((e) => e.slug);
      const ordered = init.eventOrder.filter((s) => all.includes(s));
      return [...ordered, ...all.filter((s) => !ordered.includes(s))];
    });
  };

  const save = () =>
    start(async () => {
      const vanityTrim = vanity.trim().toLowerCase();
      const vanityChanged = init.vanity.canClaim && vanityTrim !== (init.vanity.vanitySlug ?? '');
      const r = await saveStudioAction({
        handle: handle !== init.handle ? handle : undefined,
        // One Save persists everything (R30): the vanity change rides along.
        vanitySlug: vanityChanged ? vanityTrim || null : undefined,
        displayName,
        avatarUrl: avatarUrl.trim() || null,
        coverUrl: coverUrl.trim() || null,
        // The host's RAW pick, not the clamped one. A clamp is only meaningful
        // against a ground (ADR 0004), so a stored clamped colour has a canvas
        // baked into it — and B2, which lets a host move their page to the light
        // canvas, would have nothing left to re-clamp: a navy saved today comes
        // back as the washed `#66798c` the dark canvas needed. Every read path
        // already clamps (BrandedShell, the public profile, this preview), so
        // storing the pick costs nothing and keeps the choice recoverable.
        brandColor: accent,
        style: { ...axes, bio: bio.trim() || null, landingEnabled, defaultEventSlug: defaultEventSlug || null, eventOrder },
      });
      if (r.ok) {
        setSaved('ok');
        setSaveMsg(null);
        initialSnapshot.current = snapshot;
      } else {
        setSaved('err');
        setSaveMsg(r.message ?? m.saveFailed);
      }
    });

  return (
    <div className="flex flex-col gap-6">
      {/* Header: dirty chip + Reset/Save top-right */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-sm px-2 py-1 text-xs ${
              isDirty ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {isDirty ? m.unsavedChanges : m.allChangesSaved}
          </span>
          {saved === 'ok' ? <span className="text-sm text-primary">{m.saved}</span> : null}
          {saved === 'err' ? <span className="text-sm text-destructive">{saveMsg}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="lg" onClick={reset} disabled={!isDirty || pending}>
            {m.reset}
          </Button>
          <Button
            size="lg"
            onClick={save}
            disabled={!isDirty || pending || handleBlocksSave}
            className="px-5"
          >
            {pending ? m.saving : m.save}
          </Button>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[400px_1fr]">
        {/* Controls */}
        <div className="flex flex-col gap-6">
          {/* PROFILE */}
          <Section title={m.profile}>
            <Field label={m.displayName}>
              <Input
                value={displayName}
                className={inputCls}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
            <Field label={m.publicHandle}>
              <Input
                value={handle}
                className={inputCls}
                onChange={(e) => setHandle(e.target.value.toLowerCase())}
              />
              <HandleHint state={handleState} m={m} />
              {/* Was `Try alex-2 →`. A suggestion you can accept is a control. */}
              {handleState === 'taken' && handleSuggestion ? (
                <Button
                  variant="ghost"
                  size="lg"
                  className="-ml-3 self-start"
                  onClick={() => setHandle(handleSuggestion)}
                >
                  <i aria-hidden className="pi pi-replay" style={{ fontSize: 12 }} />
                  {t(m.tryHandle, { handle: handleSuggestion })}
                </Button>
              ) : null}
            </Field>
            {/* The shareable link as ONE compact copyable unit (no raw hex —
                short-links §5). Live preview: edits to the handle/vanity above
                update the path immediately. */}
            <Field label={m.yourLink}>
              <CopyLink
                path={`/${(init.vanity.canClaim && vanity.trim().toLowerCase()) || init.vanity.shortCode || init.accountCode}/${handle || init.handle}`}
                labels={{
                  copy: m.linkCopy,
                  copied: m.linkCopied,
                  open: m.linkOpen,
                  opensNewTab: init.opensNewTab,
                }}
              />
            </Field>
            {init.vanity.canClaim ? (
              <Field label={m.vanityLabel}>
                <Input
                  value={vanity}
                  placeholder={init.vanity.shortCode}
                  className={inputCls}
                  onChange={(e) => setVanity(e.target.value.toLowerCase())}
                />
                <span className="text-xs text-muted-foreground">{m.vanityHint}</span>
              </Field>
            ) : (
              <p className="text-xs text-muted-foreground">
                {m.vanityIncluded}
                {init.subscriptionUrl ? (
                  <>
                    {' '}
                    <a
                      href={init.subscriptionUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {m.vanityIncludedLink}
                    </a>
                  </>
                ) : null}
              </p>
            )}
            <Field label={m.bio}>
              <textarea
                value={bio}
                rows={2}
                onChange={(e) => setBio(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>
          </Section>

          {/* BRAND */}
          <Section title={m.brand}>
            <Field label={m.accent}>
              {/* Swatches on the 44px step: the coloured disc keeps its size and
                  the hit box grows around it, so the row reads the same and a
                  thumb can land on it. `aria-pressed` says which one is picked —
                  the ring alone was colour-only state. */}
              <div className="mb-2 flex flex-wrap gap-1">
                {ACCENT_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setAccent(c)}
                    aria-label={c}
                    aria-pressed={accent.toLowerCase() === c}
                    className="flex h-11 w-11 items-center justify-center rounded-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden
                      style={{ background: c }}
                      className={`h-7 w-7 rounded-full border-2 ${
                        accent.toLowerCase() === c ? 'border-foreground' : 'border-transparent'
                      }`}
                    />
                  </button>
                ))}
                <input
                  type="color"
                  aria-label={m.accent}
                  value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : DEFAULT_ACCENT}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-11 w-11 cursor-pointer rounded-md border border-input bg-background p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t(m.contrast, { ratio: accentLabelContrast(accent, BOOKING_CANVAS) })}
                {adjusted ? t(m.adjustedNote, { hex: clampAccent(accent, BOOKING_CANVAS) }) : ''}
              </p>
            </Field>
            <Field label={m.photoAvatar}>
              <ImageInput value={avatarUrl} onChange={setAvatarUrl} preview="avatar" m={m} />
            </Field>
            <Field label={m.coverImage}>
              <ImageInput value={coverUrl} onChange={setCoverUrl} preview="cover" m={m} />
            </Field>
          </Section>

          {/* APPEARANCE */}
          <Section title={m.appearance}>
            <div className="mb-3 flex flex-wrap gap-2">
              {ALL_BOOKING_THEMES.map((themeName) => (
                <Button
                  key={themeName}
                  variant={activeTheme === themeName ? 'default' : 'outline'}
                  size="lg"
                  aria-pressed={activeTheme === themeName}
                  onClick={() => applyTheme(themeName)}
                  className="capitalize"
                >
                  {themeName}
                </Button>
              ))}
              <span className="self-center text-xs text-muted-foreground">{activeTheme ? '' : m.custom}</span>
            </div>
            {/* Was `▸ Customize appearance` — a text glyph standing in for a
                disclosure icon, with no `aria-expanded` for anyone not seeing it. */}
            <Button
              variant="ghost"
              size="lg"
              aria-expanded={customizeOpen}
              onClick={() => setCustomizeOpen((o) => !o)}
              className="-ml-3 self-start text-muted-foreground"
            >
              <i
                aria-hidden
                className={`pi ${customizeOpen ? 'pi-chevron-down' : 'pi-chevron-right'}`}
                style={{ fontSize: 12 }}
              />
              {m.customizeAppearance}
            </Button>
            {customizeOpen ? (
              // One column at 360px: two `Select` triggers side by side inside a
              // 400px control rail leaves ~150px each, which truncates every
              // option label.
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(Object.keys(AXIS_OPTIONS) as (keyof Axes)[]).map((k) => (
                  // A <div>, not a <label>: the picker's trigger is a <button>.
                  // The axis probe rides on this wrapper — it was on the
                  // `<select>` this replaces, and a hidden span would have been
                  // a worse target than a real element in the layout.
                  <div key={k} data-testid={`bp-${k}-${axes[k]}`} className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{m[AXIS_LABEL[k]]}</span>
                    <Select
                      value={axes[k]}
                      // Capitalised here, not with a `capitalize` class: the
                      // class styles the trigger and the panel rows are drawn in
                      // a portal-ish subtree it does not reach, so the two halves
                      // of the control would disagree. The values themselves are
                      // untranslated axis identifiers, as they were before.
                      options={AXIS_OPTIONS[k].map((o) => ({
                        value: o,
                        label: o.charAt(0).toUpperCase() + o.slice(1),
                      }))}
                      ariaLabel={m[AXIS_LABEL[k]]}
                      locale={init.locale}
                      onChange={(v) => setAxis(k, v)}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </Section>

          {/* MEETINGS — reorder (↑/↓) + show/hide on the public page */}
          <Section title={m.meetings}>
            <ul className="flex flex-col gap-1 text-sm">
              {eventOrder
                .map((s) => init.manageableEvents.find((e) => e.slug === s))
                .filter((e): e is NonNullable<typeof e> => !!e)
                .map((et, i, arr) => (
                  <li
                    key={et.slug}
                    className={`flex items-center gap-1 rounded-md bg-muted px-2 py-1 ${et.hidden ? 'opacity-50' : ''}`}
                  >
                    {/* Was a stacked `▲`/`▼` pair of bare glyphs with no hit box
                        at all — roughly 10px of clickable text each. Side by
                        side, on the 44px step, with real chevrons and names that
                        say WHICH event they move. */}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${m.moveUp} · ${et.title}`}
                      disabled={i === 0}
                      onClick={() => moveEvent(et.slug, -1)}
                      className="h-11 w-8 shrink-0 text-muted-foreground disabled:opacity-30"
                    >
                      <i aria-hidden className="pi pi-chevron-up" style={{ fontSize: 11 }} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${m.moveDown} · ${et.title}`}
                      disabled={i === arr.length - 1}
                      onClick={() => moveEvent(et.slug, 1)}
                      className="h-11 w-8 shrink-0 text-muted-foreground disabled:opacity-30"
                    >
                      <i aria-hidden className="pi pi-chevron-down" style={{ fontSize: 11 }} />
                    </Button>
                    <span className="min-w-0 flex-1 truncate">{et.title}</span>
                    <Button
                      variant="outline"
                      size="lg"
                      disabled={eventPending}
                      aria-label={`${et.hidden ? m.show : m.hide} · ${et.title}`}
                      onClick={() => toggleHidden(et.id, !et.hidden)}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {et.hidden ? m.show : m.hide}
                    </Button>
                  </li>
                ))}
              {init.manageableEvents.length === 0 ? <li className="text-muted-foreground">{m.noEvents}</li> : null}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">{m.orderVisibilityNote}</p>
            {/* Was `Configure events →`. It leaves this screen, so it is a button
                with the design language's own mark, not an arrow on a link. */}
            <a
              href="/admin/event-types"
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'mt-1 self-start')}
            >
              <i aria-hidden className="pi pi-cog" style={{ fontSize: 13 }} />
              {m.configureEventTypes}
            </a>

            {/* Landing (R25): show the picker, or send visitors straight to one event. */}
            <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={landingEnabled}
                  onChange={(e) => setLandingEnabled(e.target.checked)}
                />
                {m.showLandingPage}
              </label>
              {!landingEnabled ? (
                // A <div>, not a <label>: the picker's trigger is a <button>.
                <div className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{m.sendVisitorsTo}</span>
                  <Select
                    value={defaultEventSlug}
                    // The empty row stays an OPTION, not just the placeholder:
                    // without it a host who picks the wrong event cannot get
                    // back to "none" without toggling the landing page off and
                    // on again. The invalid-empty state is what the message
                    // below is for.
                    options={[
                      { value: '', label: m.chooseEvent },
                      ...init.eventTypes.map((et) => ({ value: et.slug, label: et.title })),
                    ]}
                    placeholder={m.chooseEvent}
                    ariaLabel={m.sendVisitorsTo}
                    locale={init.locale}
                    onChange={setDefaultEventSlug}
                  />
                  {!defaultEventSlug ? (
                    <span className="text-xs text-destructive">{m.pickDefaultEvent}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Section>
        </div>

        {/* Live preview (sticky) */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          {/* Preview toolbar — studio CHROME, not the canvas. Both segmented
              controls are on the 44px step and announce their state. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex rounded-md border border-border p-0.5 text-sm">
              {(['profile', 'booking'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={surface === s}
                  onClick={() => setSurface(s)}
                  className={`inline-flex min-h-[44px] items-center rounded-sm px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${surface === s ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {s === 'booking' ? m.bookingFlow : m.previewProfile}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-border p-0.5 text-sm">
              {(['desktop', 'mobile'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={device === d}
                  onClick={() => setDevice(d)}
                  className={`inline-flex min-h-[44px] items-center rounded-sm px-3 capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${device === d ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {d === 'desktop' ? m.desktop : m.mobile}
                </button>
              ))}
            </div>
          </div>

          {/* The FRAME is chrome; everything inside it is BP's canvas and is not
              touched by this sweep (preview == prod, #134). `overflow-x-auto` so
              the fixed 360px mobile preview scrolls inside its frame instead of
              widening the studio at 360px. */}
          <div className="overflow-x-auto rounded-xl border border-border p-4 sm:p-6" style={previewVars}>
            <div className={`${brandingClassOf(axes)} ${device === 'mobile' ? 'mx-auto w-[360px]' : 'mx-auto max-w-md'}`}>
              {surface === 'profile' ? (
                <ProfilePreview
                  displayName={displayName}
                  bio={bio}
                  avatarUrl={avatarUrl}
                  coverUrl={coverUrl}
                  accent={accent}
                  eventTypes={init.eventTypes}
                  m={m}
                />
              ) : (
                <BookingPreview
                  displayName={displayName}
                  avatarUrl={avatarUrl}
                  accent={accent}
                  locale={init.locale}
                  m={m}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfilePreview({
  displayName,
  bio,
  avatarUrl,
  coverUrl,
  accent,
  eventTypes,
  m,
}: {
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  accent: string;
  eventTypes: EventTypeLite[];
  m: StudioMessages;
}) {
  return (
    <div>
      {coverUrl ? (
        <img src={coverUrl} alt="" className="bp-cover mb-3 h-24 w-full rounded-md object-cover" />
      ) : (
        <div className="bp-cover mb-3 h-20 w-full rounded-md" style={{ background: 'var(--accent-wash)' }} />
      )}
      <div className="mb-4 flex items-center gap-3">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center text-lg font-semibold"
            style={{
              background: 'var(--accent)',
              color: onAccent(clampAccent(accent, BOOKING_CANVAS)),
              borderRadius: 'var(--bp-radius)',
            }}
          >
            {monogram(displayName)}
          </div>
        )}
        <div>
          <div style={{ fontFamily: 'var(--bp-font-display)' }} className="text-lg font-semibold">
            {displayName}
          </div>
          {bio ? <div className="text-sm text-muted-foreground">{bio}</div> : null}
        </div>
      </div>
      <div className="flex flex-col" style={{ gap: 'var(--bp-gap)' }}>
        {(eventTypes.length ? eventTypes : [{ slug: 'intro', title: m.introCall, lengthMinutes: 30 }]).map((et) => (
          <div key={et.slug} className="bp-card flex items-center justify-between">
            <span className="font-medium">{et.title}</span>
            <span className="text-sm text-muted-foreground">{et.lengthMinutes} {m.minSuffix}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The booking-flow preview, rebuilt to BP's three regions — event panel, month
 * calendar, day column — so the axes this studio exists to demonstrate land on
 * the markup the public page actually ships (`bp-card`, `bp-cal-*`, `bp-daycol`,
 * `bp-slots`, `bp-slot`, `bp-icon-btn`).
 *
 * It is still a MOCK, not the live island: `BookingFlow` needs slots, server
 * actions and a real account, and this preview deliberately has none of those.
 * The whole thing stays out of the tab order and the a11y tree for the reason
 * it always did — nothing here can be clicked, so nothing here should invite a
 * click. The sample dates are fixed rather than derived from today, so the
 * preview renders identically on the server and after hydration.
 */
function BookingPreview({
  displayName,
  avatarUrl,
  accent,
  locale,
  m,
}: {
  displayName: string;
  avatarUrl: string;
  accent: string;
  locale: string;
  m: StudioMessages;
}) {
  // The sample MONTH is fixed; how it READS is not. Month names, weekday
  // initials and which day a week starts on are locale decisions, and the
  // public page makes them — a Spanish admin previewing a Sunday-first English
  // grid is being shown a page that does not exist. Built from the same
  // helpers the real calendar uses, on a fixed key, so it is localized and
  // still renders identically on the server and after hydration.
  const grid = useMemo(
    () =>
      buildMonthGrid(PREVIEW_MONTH_KEY, {
        availableDayKeys: PREVIEW_AVAILABLE,
        todayKey: PREVIEW_TODAY,
        locale,
        weekStartsOn: weekStartsOnFor(locale),
      }),
    [locale],
  );
  const selectedLabel = useMemo(
    () => formatDayHeading(PREVIEW_SELECTED_INSTANT, 'UTC', locale),
    [locale],
  );

  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      {/* Event panel */}
      <div className="flex items-center gap-3">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 items-center justify-center text-base font-semibold"
            style={{
              background: 'var(--accent)',
              color: onAccent(clampAccent(accent, BOOKING_CANVAS)),
              borderRadius: 'var(--bp-radius)',
            }}
          >
            {monogram(displayName)}
          </div>
        )}
        <div className="min-w-0">
          <div style={{ fontFamily: 'var(--bp-font-display)' }} className="truncate font-medium">
            {m.introCall}
          </div>
          <div className="text-sm text-muted-foreground">
            30 {m.minSuffix} · {displayName}
          </div>
        </div>
      </div>

      {/* One column, always. The preview box is `max-w-md` on desktop and
          360px on mobile, so a viewport-width `sm:` breakpoint inside it is
          always true and the "mobile" preview would render the two-column
          desktop layout at ~28px per calendar cell — a preview of a page that
          does not exist. The public page stacks these two regions below `lg`,
          and every width this box takes is below `lg`. */}
      <div className="flex flex-col gap-4">
        {/* Month calendar */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold" style={{ fontFamily: 'var(--bp-font-display)' }}>
              {grid.label}
            </span>
            <div className="flex gap-1">
              {/* The same chevron the public page draws, so the preview shows
                  the control that ships rather than a stand-in for it. */}
              <span className="bp-icon-btn h-9 min-h-0 w-9 min-w-0">
                <ChevronIcon direction="left" />
              </span>
              <span className="bp-icon-btn h-9 min-h-0 w-9 min-w-0">
                <ChevronIcon direction="right" />
              </span>
            </div>
          </div>
          <div className="bp-cal-grid">
            <div className="bp-cal-week">
              {grid.weekdayLabels.map((d, i) => (
                <div key={`${d}-${i}`} className="bp-cal-weekday">
                  {d}
                </div>
              ))}
            </div>
            {grid.weeks.map((week) => (
              <div className="bp-cal-week" key={week[0]!.dayKey}>
                {week.map((day) => (
                  <span
                    key={day.dayKey}
                    className="bp-cal-day"
                    data-state={
                      !day.inMonth ? 'outside' : day.hasSlots ? 'available' : 'empty'
                    }
                    data-today={day.isToday ? 'true' : undefined}
                    data-selected={day.dayKey === PREVIEW_SELECTED ? 'true' : undefined}
                  >
                    {day.dayOfMonth}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Day column */}
        <div className="bp-daycol flex min-w-0 flex-col gap-2">
          <span className="text-xs font-semibold text-muted-foreground">{selectedLabel}</span>
          <div className="bp-slots">
            {['9:00', '9:30', '10:00', '10:30'].map((s, i) => (
              <span key={s} className="bp-slot text-sm" aria-pressed={i === 0}>
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Fixed sample data for the preview. Deliberately not derived from `new Date()`
// — a preview that changes shape at midnight is a preview that fails to render
// the same way twice, and this one is server-rendered before it hydrates. The
// KEYS are fixed; how they read is the locale's business, which is why they go
// through `buildMonthGrid` rather than being spelled out in English.
const PREVIEW_MONTH_KEY = '2026-09';
const PREVIEW_TODAY = '2026-09-10';
const PREVIEW_SELECTED = '2026-09-14';
/** UTC noon of the selected day — the day column's heading. */
const PREVIEW_SELECTED_INSTANT = '2026-09-14T12:00:00.000Z';
const PREVIEW_AVAILABLE = [
  '2026-09-10',
  '2026-09-11',
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
];

function HandleHint({ state, m }: { state: HandleState; m: StudioMessages }) {
  // The `✓`/`✗` the available/taken copy used to carry are icons now, so the
  // status reads the same in both locales without a glyph baked into a string.
  const map: Record<HandleState, { text: string; cls: string; icon: string | null } | null> = {
    idle: null,
    checking: { text: m.checking, cls: 'text-muted-foreground', icon: null },
    available: { text: m.available, cls: 'text-primary', icon: 'pi-check-circle' },
    taken: { text: m.taken, cls: 'text-destructive', icon: 'pi-times-circle' },
    invalid: { text: m.invalid, cls: 'text-destructive', icon: 'pi-times-circle' },
  };
  const h = map[state];
  return h ? (
    <span className={`flex items-center gap-1 text-xs ${h.cls}`}>
      {h.icon ? <i aria-hidden className={`pi ${h.icon}`} style={{ fontSize: 11 }} /> : null}
      {h.text}
    </span>
  ) : null;
}

const inputCls = 'min-h-[44px] w-full';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Image picker: upload (data-URL, 1MB/type-validated) with a preview + clear,
 *  or paste a URL. Matches the old app's dropzone-to-data-URL behaviour. */
function ImageInput({
  value,
  onChange,
  preview,
  m,
}: {
  value: string;
  onChange: (v: string) => void;
  preview: 'avatar' | 'cover';
  m: StudioMessages;
}) {
  const [err, setErr] = useState<string | null>(null);
  const isData = value.startsWith('data:');
  const errText = (code: 'invalid' | 'tooLarge' | 'read') =>
    code === 'invalid' ? m.imageInvalid : code === 'tooLarge' ? m.imageTooLarge : m.couldNotRead;
  return (
    <div className="flex flex-col gap-2">
      {value ? (
        <img
          src={value}
          alt=""
          className={preview === 'avatar' ? 'h-12 w-12 rounded-full object-cover' : 'h-16 w-full rounded-md object-cover'}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {/* The file input stays hidden inside its label — that is what makes the
            label the control — but the label now wears the button recipe and the
            44px step instead of a bespoke 28px chip. */}
        <label
          className={cn(
            buttonVariants({ variant: 'outline', size: 'lg' }),
            'cursor-pointer text-xs',
          )}
        >
          <i aria-hidden className="pi pi-upload" style={{ fontSize: 12 }} />
          {m.uploadImage}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = await readImageFile(f);
              if (r.ok) {
                onChange(r.dataUrl);
                setErr(null);
              } else {
                setErr(errText(r.code));
              }
            }}
          />
        </label>
        {value ? (
          <Button
            variant="ghost"
            size="lg"
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={() => {
              onChange('');
              setErr(null);
            }}
          >
            {m.clear}
          </Button>
        ) : null}
      </div>
      <Input
        value={isData ? '' : value}
        placeholder={m.orPasteUrl}
        className={inputCls}
        onChange={(e) => onChange(e.target.value)}
      />
      {err ? <span className="text-xs text-destructive">{err}</span> : null}
    </div>
  );
}
