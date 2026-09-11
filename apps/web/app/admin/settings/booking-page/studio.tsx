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
  accentCanvasContrast,
  accentLabelContrast,
  MIN_ACCENT_CONTRAST,
  buildMonthGrid,
  formatDayHeading,
  onAccent,
  matchTheme,
  monogram,
  t,
  weekStartsOnFor,
  type BookingMessages,
  type BrandCanvas,
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
import { EmbedIcon, EmbedSnippetModal } from '@/components/embed-snippet-modal';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import { resolveAvatarUrl } from '@/lib/avatar';
import { ChevronIcon } from '@/components/booking-page-parts';
import { checkHandleAction, saveStudioAction, toggleEventHiddenAction } from './actions';

type StudioMessages = BookingMessages['admin']['studio'];

/** The ten appearance axes the studio drives. Nine are widget shape; `theme` is
 *  the GROUND they are drawn on (ADR 0004) and lives here rather than in its own
 *  section because a host choosing how their page looks is choosing all ten. */
type Axes = Pick<
  PublicBranding,
  | 'template'
  | 'cardStyle'
  | 'corners'
  | 'buttons'
  | 'density'
  | 'font'
  | 'slotLayout'
  | 'dayGroup'
  | 'slotSelect'
  | 'theme'
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
  theme: 'axisTheme',
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
  theme: ['light', 'dark'],
};

/**
 * The one axis whose VALUES are translated.
 *
 * Every other axis is an untranslated identifier — `Split`, `Boxed`, `Pill` are
 * design vocabulary a host reads as a name. "Light" and "Dark" are not names,
 * they are two ordinary words describing what the host will see, and leaving
 * them in English is the kind of half-translated screen the i18n rule exists to
 * prevent. Keyed by the axis value so the catalog stays flat.
 */
const THEME_OPTION_LABEL: Record<string, keyof StudioMessages> = {
  light: 'themeLight',
  dark: 'themeDark',
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
  /** The connected account's photo. The preview's FALLBACK, never the input's
   *  value — the field holds the host's own choice and saving must not turn a
   *  synced URL into a stored one. */
  connectedAvatarUrl: string;
  coverUrl: string;
  accent: string;
  axes: Axes;
  landingEnabled: boolean;
  defaultEventSlug: string | null;
  eventTypes: EventTypeLite[];
  manageableEvents: { id: string; slug: string; title: string; hidden: boolean }[];
  eventOrder: string[];
  messages: StudioMessages;
  /** Copy for the embed dialog (E) — the landing page's snippet lives beside
   *  the link it embeds, which is here. */
  embedMessages: BookingMessages['embed'];
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
  // What the PUBLIC page will draw, through the same helper it uses. The input
  // above stays bound to `avatarUrl`; only the preview resolves the fallback,
  // so a preview showing a letter while the live page shows a face cannot
  // happen and an empty field still saves as empty.
  const previewAvatarUrl = resolveAvatarUrl(avatarUrl, init.connectedAvatarUrl) ?? '';
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
  const [embedOpen, setEmbedOpen] = useState(false);
  const [eventPending, startEvent] = useTransition();

  /**
   * The host's public landing path, derived once so the copyable link and the
   * embed snippet cannot describe two different pages. Live: editing the handle
   * or the vanity slug above updates both immediately.
   */
  const landingPath = `/${(init.vanity.canClaim && vanity.trim().toLowerCase()) || init.vanity.shortCode || init.accountCode}/${handle || init.handle}`;
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
  // The canvas the INVITEE will see, read through the same resolver the public
  // shell uses. Never the admin's own `data-theme`: a host previewing their page
  // is looking at a stranger's screen, not their own (ADR 0004).
  const canvas = bookingCanvasOf(axes);
  // `brandVars`, not `accentVars`: the preview has to emit the PRODUCT accent
  // tokens too. Emitting only `--accent*` left `--primary-ink`/`--primary-edge`
  // resolving from the admin palette, so the preview drew the host's links and
  // rims in our lime while the real page drew them in the host's colour — the
  // exact "preview == prod" break ADR 0004 is written against. Same function and
  // same canvas as BrandedShell, so the two cannot drift.
  const previewVars = useMemo(
    () => ({ ...brandVars(accent, bookingCanvasOf(axes)), ...widgetStyleVars(axes) }) as Record<string, string>,
    [accent, axes],
  );
  // The engine no longer corrects an illegible accent (ADR 0004's 2026-09-11
  // amendment), so the studio's job on this field changed from reporting a
  // correction to reporting a number. Measured against the ground the INVITEE
  // will see, not the admin's, for the same reason `canvas` is resolved above.
  const canvasContrast = accentCanvasContrast(accent, canvas);

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

  // A preset sets the nine SHAPE axes and deliberately leaves the canvas alone:
  // the presets predate B2 and describe a silhouette, not a ground, so a host
  // who moved their page to dark and then tried "Bold" would otherwise be
  // thrown back to paper by a control that says nothing about theme.
  const applyTheme = (t: keyof typeof THEME_PRESETS) =>
    setAxes((a) => ({ ...THEME_PRESETS[t], theme: a.theme }));
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
        // The host's RAW pick. Since ADR 0004's amendment nothing alters it on
        // the way out either, so this is now simply the one colour the whole
        // system carries — stored, previewed and rendered identically. It stays
        // worth stating: the reason to store the pick was that a stored ADJUSTED
        // colour bakes a canvas into the row and cannot be recovered when the
        // host moves their page to the other ground. That trap is what the
        // amendment removed, and writing the pick is what keeps it removed.
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
    <div className="flex flex-col gap-group">
      {/* Header: dirty chip + Reset/Save top-right */}
      <div className="flex flex-wrap items-center justify-between gap-field">
        <div className="flex flex-wrap items-center gap-field">
          <span
            className={`rounded-sm px-inline py-tight text-xs ${
              isDirty ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {isDirty ? m.unsavedChanges : m.allChangesSaved}
          </span>
          {saved === 'ok' ? <span className="text-sm text-primary">{m.saved}</span> : null}
          {saved === 'err' ? <span className="text-sm text-destructive">{saveMsg}</span> : null}
        </div>
        <div className="flex items-center gap-inline">
          <Button variant="outline" size="lg" onClick={reset} disabled={!isDirty || pending}>
            {m.reset}
          </Button>
          <Button
            size="lg"
            onClick={save}
            disabled={!isDirty || pending || handleBlocksSave}
            className="px-control-pad"
          >
            {pending ? m.saving : m.save}
          </Button>
        </div>
      </div>

      <div className="grid gap-section lg:grid-cols-[400px_1fr]">
        {/* Controls */}
        <div className="flex flex-col gap-group">
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
                  className="-ml-field self-start"
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
                // `landingPath` is E's derived const — the same expression this
                // used to inline, hoisted so the copyable link and the embed
                // snippet cannot describe two different pages.
                path={landingPath}
                labels={{
                  copy: m.linkCopy,
                  copied: m.linkCopied,
                  open: m.linkOpen,
                  opensNewTab: init.opensNewTab,
                }}
              />
            </Field>
            {/* The landing page's embed snippet, beside the link it embeds
                (#67). Event types get theirs from the row actions.

                Deliberately OUTSIDE the `Field` above: that component wraps its
                children in a `<label>`, and a control inside a label takes the
                label's whole text as its accessible name — so putting this here
                renamed the neighbouring Copy button to "Your link Copy Open
                Embed on your site". A button is not what a field label labels. */}
            {/* A2 (#112): E landed this as a button wearing link styling
                (`text-primary hover:underline`) at ~20px tall, in a control rail
                where the sweep had just made every other control a `Button` on
                the 44px step. Same handler, same icon, same copy — it is the
                ghost variant now, so it reads as the control it always was. */}
            <div className="flex flex-col">
              <Button
                variant="ghost"
                size="lg"
                onClick={() => setEmbedOpen(true)}
                className="-ml-field self-start"
              >
                <EmbedIcon />
                {init.embedMessages.action}
              </Button>
              <EmbedSnippetModal
                open={embedOpen}
                onClose={() => setEmbedOpen(false)}
                publicPath={landingPath}
                title={displayName || init.displayName || handle || init.handle}
                messages={init.embedMessages}
              />
            </div>
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
                className="w-full rounded-md border border-input bg-background px-field py-inline text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <div className="mb-inline flex flex-wrap gap-tight">
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
                  className="h-11 w-11 cursor-pointer rounded-md border border-input bg-background p-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              {/* Two different grounds, so both are named rather than left as
                  bare numbers. The readout is the button LABEL on its fill,
                  which `onAccent` keeps above ~4.1:1 no matter what the host
                  picks — it can never trip the warning, and it is why the
                  warning has to measure the canvas instead. */}
              <p className="text-xs text-muted-foreground">
                {t(m.contrast, { ratio: accentLabelContrast(accent, canvas) })}
              </p>
              {/* Announced, not just shown. It appears and disappears live as
                  the host drags the colour picker, and it is the only signal
                  left where the engine used to silently correct the colour. */}
              {canvasContrast < MIN_ACCENT_CONTRAST ? (
                <p role="status" aria-live="polite" className="text-xs text-destructive">
                  {t(m.lowContrast, { ratio: canvasContrast })}
                </p>
              ) : null}
            </Field>
            <Field label={m.photoAvatar}>
              <ImageInput value={avatarUrl} onChange={setAvatarUrl} preview="avatar" m={m} />
              {/* The public page falls back to the connected account's photo,
                  and a host who never opens this field would otherwise have no
                  idea where the face on their page came from — or that leaving
                  this empty is what keeps it. */}
              {!avatarUrl.trim() && previewAvatarUrl ? (
                <p className="text-xs text-muted-foreground">{m.photoFromConnectedAccount}</p>
              ) : null}
            </Field>
            <Field label={m.coverImage}>
              <ImageInput value={coverUrl} onChange={setCoverUrl} preview="cover" m={m} />
            </Field>
          </Section>

          {/* APPEARANCE */}
          <Section title={m.appearance}>
            <div className="mb-field flex flex-wrap gap-inline">
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
              className="-ml-field self-start text-muted-foreground"
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
              <div className="mt-field grid grid-cols-1 gap-field sm:grid-cols-2">
                {(Object.keys(AXIS_OPTIONS) as (keyof Axes)[]).map((k) => (
                  // A <div>, not a <label>: the picker's trigger is a <button>.
                  // The axis probe rides on this wrapper — it was on the
                  // `<select>` this replaces, and a hidden span would have been
                  // a worse target than a real element in the layout.
                  <div key={k} data-testid={`bp-${k}-${axes[k]}`} className="flex flex-col gap-tight text-sm">
                    <span className="text-muted-foreground">{m[AXIS_LABEL[k]]}</span>
                    <Select
                      value={axes[k]}
                      // Capitalised here, not with a `capitalize` class: the
                      // class styles the trigger and the panel rows are drawn in
                      // a portal-ish subtree it does not reach, so the two halves
                      // of the control would disagree. The values themselves are
                      // untranslated axis identifiers, as they were before —
                      // except the canvas, whose two values are ordinary words.
                      options={AXIS_OPTIONS[k].map((o) => {
                        const translated = k === 'theme' ? THEME_OPTION_LABEL[o] : undefined;
                        return {
                          value: o,
                          label: translated ? m[translated] : o.charAt(0).toUpperCase() + o.slice(1),
                        };
                      })}
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
            <ul className="flex flex-col gap-tight text-sm">
              {eventOrder
                .map((s) => init.manageableEvents.find((e) => e.slug === s))
                .filter((e): e is NonNullable<typeof e> => !!e)
                .map((et, i, arr) => (
                  <li
                    key={et.slug}
                    className={`flex items-center gap-tight rounded-md bg-muted px-inline py-tight ${et.hidden ? 'opacity-50' : ''}`}
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
            <p className="mt-tight text-xs text-muted-foreground">{m.orderVisibilityNote}</p>
            {/* Was `Configure events →`. It leaves this screen, so it is a button
                with the design language's own mark, not an arrow on a link. */}
            <a
              href="/admin/event-types"
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'mt-tight self-start')}
            >
              <i aria-hidden className="pi pi-cog" style={{ fontSize: 13 }} />
              {m.configureEventTypes}
            </a>

            {/* Landing (R25): show the picker, or send visitors straight to one event. */}
            <div className="mt-card flex flex-col gap-inline border-t border-border pt-field">
              <label className="flex min-h-control cursor-pointer items-center gap-inline text-sm">
                <Checkbox
                  checked={landingEnabled}
                  onChange={(e) => setLandingEnabled(e.target.checked)}
                />
                {m.showLandingPage}
              </label>
              {!landingEnabled ? (
                // A <div>, not a <label>: the picker's trigger is a <button>.
                <div className="flex flex-col gap-tight text-sm">
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
          <div className="mb-field flex flex-wrap items-center justify-between gap-inline">
            <div className="flex rounded-md border border-border p-tight text-sm">
              {(['profile', 'booking'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={surface === s}
                  onClick={() => setSurface(s)}
                  className={`inline-flex min-h-control items-center rounded-sm px-field transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${surface === s ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {s === 'booking' ? m.bookingFlow : m.previewProfile}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-border p-tight text-sm">
              {(['desktop', 'mobile'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={device === d}
                  onClick={() => setDevice(d)}
                  className={`inline-flex min-h-control items-center rounded-sm px-field capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${device === d ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {d === 'desktop' ? m.desktop : m.mobile}
                </button>
              ))}
            </div>
          </div>

          {/* The FRAME is chrome; everything inside it is BP's canvas and is not
              touched by this sweep (preview == prod, #134). `overflow-x-auto` so
              the fixed 360px mobile preview scrolls inside its frame instead of
              widening the studio at 360px.

              B2: the frame STAMPS the invitee's canvas and paints its ground.
              Emitting only the branding vars and letting `--background`,
              `--card` and `--foreground` fall through to the admin shell was
              enough while there was one canvas; the moment a host can put their
              page on paper it is the harder version of the preview != prod bug,
              because `--accent-wash` is `color-mix(…, var(--background))`. The
              accent would match the live page exactly while every wash and card
              ground behind it came from the AUTHOR's theme instead of the
              invitee's. Stamped on the frame rather than on an inner element so
              the padding around the canvas is the canvas's own ground and not a
              rim of the admin's; `overflow-x-auto` already clips it to the
              rounded corners. */}
          <div
            data-theme={canvas}
            className="overflow-x-auto rounded-xl border border-border bg-background p-card text-foreground sm:p-group"
            style={previewVars}
          >
            <div className={`${brandingClassOf(axes)} ${device === 'mobile' ? 'mx-auto w-[360px]' : 'mx-auto max-w-md'}`}>
              {surface === 'profile' ? (
                <ProfilePreview
                  displayName={displayName}
                  bio={bio}
                  avatarUrl={previewAvatarUrl}
                  coverUrl={coverUrl}
                  accent={accent}
                  canvas={canvas}
                  eventTypes={init.eventTypes}
                  m={m}
                />
              ) : (
                <BookingPreview
                  displayName={displayName}
                  avatarUrl={previewAvatarUrl}
                  accent={accent}
                  canvas={canvas}
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

/* spacing-gate:off — the BP canvas. Everything from here to the marker below is
   the invitee's view, drawn from the host's own `--bp-*` axes so the preview
   matches production exactly (#134). The admin spacing scale has no authority
   here, and a sweep that renames these utilities silently breaks preview == prod.
   The FRAME around the canvas is admin chrome and does follow the scale. */
function ProfilePreview({
  displayName,
  bio,
  avatarUrl,
  coverUrl,
  accent,
  canvas,
  eventTypes,
  m,
}: {
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  accent: string;
  /** The ground the preview paints on, so the monogram's label is derived
   *  against the same canvas the public page derives against. */
  canvas: BrandCanvas;
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
          <img
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center text-lg font-semibold"
            style={{
              background: 'var(--accent)',
              color: onAccent(clampAccent(accent, canvas)),
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
  canvas,
  locale,
  m,
}: {
  displayName: string;
  avatarUrl: string;
  accent: string;
  /** As in `ProfilePreview` — the canvas the label is derived against. */
  canvas: BrandCanvas;
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
            referrerPolicy="no-referrer"
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div
            className="flex h-10 w-10 items-center justify-center text-base font-semibold"
            style={{
              background: 'var(--accent)',
              color: onAccent(clampAccent(accent, canvas)),
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

/* spacing-gate:on */

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
    <span className={`flex items-center gap-tight text-xs ${h.cls}`}>
      {h.icon ? <i aria-hidden className={`pi ${h.icon}`} style={{ fontSize: 11 }} /> : null}
      {h.text}
    </span>
  ) : null;
}

const inputCls = 'min-h-control w-full';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-field rounded-xl border border-border bg-card p-card">
      <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-tight text-sm">
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
    <div className="flex flex-col gap-inline">
      {value ? (
        <img
          src={value}
          alt=""
          className={preview === 'avatar' ? 'h-12 w-12 rounded-full object-cover' : 'h-16 w-full rounded-md object-cover'}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-inline">
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
