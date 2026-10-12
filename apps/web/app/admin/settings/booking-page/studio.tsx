'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ALL_BOOKING_THEMES,
  DEFAULT_ACCENT,
  NEW_HOST_ACCENT,
  NEW_HOST_THEME,
  THEME_PRESETS,
  accentCanvasContrast,
  accentLabelContrast,
  MIN_ACCENT_CONTRAST,
  matchTheme,
  t,
  type BookingMessages,
  type PublicBranding,
} from '@slate/shared';
import { useRouter } from 'next/navigation';
import { saveErrorMessage } from '@/lib/save-error';
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
import { readImageFile, type ImageErrorCode } from '@/lib/image-file';
import { BookingPreview, PreviewFrame, ProfilePreview } from '@/components/booking-preview';
import {
  applyKitAction,
  checkHandleAction,
  revertLookAction,
  saveStudioAction,
  toggleEventHiddenAction,
  type SaveResult,
} from './actions';

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
  description?: string | null;
  lengthMinutes: number;
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
  /** The account's name, the quiet line above the host's on their profile. */
  accountName?: string | null;
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
  /** The look the host can take back once (the new look, or a brand kit). */
  lookBackup?: { source: 'new-look' | 'kit'; appliedAt: number } | null;
  /** The workspace logo this page carries (snapshotted by "Apply brand kit"). */
  logoUrl?: string;
  /** Whether the workspace has a brand kit to apply. */
  hasBrandKit?: boolean;
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
  /** The host clicked "Use the new look" and has not saved yet. */
  const [adoptingNewLook, setAdoptingNewLook] = useState(false);
  const [reverting, startRevert] = useTransition();
  const [applyingKit, startApplyKit] = useTransition();

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
  // The preview's vars (`brandVars` + `widgetStyleVars`, the same functions and
  // the same canvas as BrandedShell) are emitted by `PreviewFrame`.
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
  // The look a host is born with since PR #193: ink on paper, the minimal set.
  // A host who already has it has nothing to adopt.
  const isNewLook =
    accent.toLowerCase() === NEW_HOST_ACCENT && activeTheme === 'minimal' && axes.theme === NEW_HOST_THEME;
  const adoptNewLook = () => {
    setAccent(NEW_HOST_ACCENT);
    setAxes({ ...THEME_PRESETS.minimal, theme: NEW_HOST_THEME });
    setAdoptingNewLook(true);
  };
  // Applying writes the kit onto what is STORED, so unsaved edits here would
  // either be lost or silently overwrite the kit; the control asks for a save
  // first instead.
  const applyKit = () =>
    startApplyKit(async () => {
      const r = await applyKitAction();
      if (r.ok) {
        toast.success(m.kitAppliedToast);
        router.refresh();
      } else {
        toast.error(m.applyKitFailed);
      }
    });
  const revertLook = () =>
    startRevert(async () => {
      const r = await revertLookAction();
      if (r.ok) {
        toast.success(m.lookReverted);
        // The page remounts the studio from what is stored now (see its key).
        router.refresh();
      } else {
        toast.error(m.revertFailed);
      }
    });
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
    setAdoptingNewLook(false);
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
      const payload = {
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
        style: {
          ...axes,
          bio: bio.trim() || null,
          landingEnabled,
          defaultEventSlug: defaultEventSlug || null,
          eventOrder,
          // The kit's logo rides through a save untouched; the studio does not
          // edit it (the brand kit does), and dropping it here would remove it.
          ...(init.logoUrl ? { logoUrl: init.logoUrl } : {}),
        },
        // Applying the new look keeps what is stored now as a one-step backup,
        // so it can be reverted. Only when the look on screen still IS the new
        // look: a host who clicked it and then reshaped the axes is saving
        // their own look, which is an ordinary save.
        ...(adoptingNewLook && isNewLook ? { backupAs: 'new-look' as const } : {}),
      };

      let r: SaveResult;
      try {
        r = await saveStudioAction(payload);
      } catch (e) {
        // Re-throws a session redirect and reports everything else; see
        // `saveErrorMessage` for why that first step matters.
        const message = saveErrorMessage(e, payload, {
          tooLarge: m.saveTooLarge,
          failed: m.saveFailed,
        });
        setSaved('err');
        setSaveMsg(message);
        return;
      }

      if (r.ok) {
        setSaved('ok');
        setSaveMsg(null);
        initialSnapshot.current = snapshot;
        if (payload.backupAs) router.refresh();
        setAdoptingNewLook(false);
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
            {/* The look new pages start with, one click away for a host who has
                their own, previewed before it is saved and revertible once. */}
            <div className="mb-field flex flex-col gap-tight border-b border-border pb-field">
              {init.lookBackup ? (
                <div className="flex flex-wrap items-center justify-between gap-inline">
                  <span className="text-sm" suppressHydrationWarning>
                    {t(init.lookBackup.source === 'kit' ? m.kitApplied : m.newLookApplied, {
                      date: new Intl.DateTimeFormat(init.locale, { dateStyle: 'medium' }).format(
                        new Date(init.lookBackup.appliedAt),
                      ),
                    })}
                  </span>
                  <Button variant="outline" size="lg" onClick={revertLook} disabled={reverting || pending}>
                    {reverting ? m.revertingLook : m.revertLook}
                  </Button>
                </div>
              ) : null}
              {init.hasBrandKit ? (
                <div className="flex flex-col gap-tight">
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={applyKit}
                    disabled={applyingKit || pending || isDirty}
                    className="self-start"
                  >
                    {applyingKit ? m.applyingKit : m.applyKit}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {isDirty ? m.applyKitSaveFirst : m.applyKitHint}
                  </span>
                </div>
              ) : null}
              <Button
                variant="outline"
                size="lg"
                onClick={adoptNewLook}
                disabled={isNewLook}
                aria-pressed={isNewLook}
                className="self-start"
              >
                {m.newLook}
              </Button>
              <span className="text-xs text-muted-foreground">
                {adoptingNewLook && isNewLook && isDirty ? m.newLookPreviewing : m.newLookHint}
              </span>
            </div>
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

          {/* The FRAME is chrome; everything inside it is the invitee's page.
              `PreviewFrame` (components/booking-preview.tsx) stamps the
              invitee's canvas, paints the booking ground and emits the same
              branding vars and classes `BrandedShell` does, which
              `preview-parity.spec.tsx` checks. */}
          <PreviewFrame accent={accent} axes={axes} device={device} wide={surface === 'booking'}>
              {surface === 'profile' ? (
                <ProfilePreview
                  locale={init.locale}
                  displayName={displayName}
                  accountName={init.accountName ?? null}
                  bio={bio}
                  avatarUrl={previewAvatarUrl}
                  coverUrl={coverUrl}
                  logoUrl={init.logoUrl || null}
                  // In the order the host set in the Meetings panel, unlisted last,
                  // exactly as the public page sorts them.
                  events={[...init.eventTypes].sort((a, b) => {
                    const rank = (slug: string) => {
                      const i = eventOrder.indexOf(slug);
                      return i === -1 ? eventOrder.length + 1 : i;
                    };
                    return rank(a.slug) - rank(b.slug);
                  })}
                />
              ) : (
                <BookingPreview
                  hostName={displayName}
                  avatarUrl={previewAvatarUrl || null}
                  eventTitle={m.introCall}
                  locale={init.locale}
                  device={device}
                  logoUrl={init.logoUrl || null}
                />
              )}
          </PreviewFrame>
        </div>
      </div>
    </div>
  );
}

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

/** Image picker: upload (downscaled to an inline data-URL by `@/lib/image-file`)
 *  with a preview + clear, or paste a URL.
 *
 *  `preview` is not only the thumbnail shape — it is also the downscale target,
 *  because the two must agree. A cover is a wide banner; squaring it to the
 *  avatar's 512×512 would destroy it. */
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
  // A 25MB decode is not instant, so the control says so rather than looking dead.
  const [busy, setBusy] = useState(false);
  const isData = value.startsWith('data:');
  const errText = (code: ImageErrorCode) => {
    if (code === 'invalid') return m.imageInvalid;
    if (code === 'tooLarge') return m.imageTooLarge;
    if (code === 'cannotShrink') return m.imageCannotShrink;
    return m.couldNotRead;
  };
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
            busy && 'pointer-events-none opacity-60',
          )}
          aria-busy={busy}
        >
          <i aria-hidden className="pi pi-upload" style={{ fontSize: 12 }} />
          {busy ? m.imageWorking : m.uploadImage}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              // Clear the input NOW: picking the same file twice after an error
              // fires no change event otherwise.
              e.target.value = '';
              if (!f) return;
              setBusy(true);
              try {
                const r = await readImageFile(f, preview);
                if (r.ok) {
                  onChange(r.dataUrl);
                  setErr(null);
                } else {
                  setErr(errText(r.code));
                }
              } finally {
                setBusy(false);
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
      {/* Sits under the UPLOAD control, not under the paste-a-URL field below:
          it describes what happens to a picked file, and a pasted URL is never
          resized at all. */}
      <span className="text-xs text-muted-foreground">{m.imageHelp}</span>
      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      <Input
        value={isData ? '' : value}
        placeholder={m.orPasteUrl}
        className={inputCls}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
