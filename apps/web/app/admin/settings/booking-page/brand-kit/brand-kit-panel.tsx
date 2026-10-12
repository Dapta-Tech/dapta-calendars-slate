'use client';

import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { DEFAULT_ACCENT, NEW_HOST_ACCENT, t, type BookingMessages } from '@slate/shared';
import { withBrandKit, type BrandKit } from '@slate/types';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { StatementHeader } from '@/components/ui/page-header';
import { SettingsPanel, SettingsRow } from '@/components/ui/settings';
import { StatusChip } from '@/components/ui/status-chip';
import { BookingPreview, PreviewFrame, ProfilePreview } from '@/components/booking-preview';
import { readImageFile } from '@/lib/image-file';
import { cn } from '@/lib/cn';
import { saveBrandKitAction } from './actions';

type BrandKitMessages = BookingMessages['admin']['brandKit'];
type StudioMessages = BookingMessages['admin']['studio'];

/** Ink first: the look new pages are born with, then the studio's swatches. */
const ACCENTS = [NEW_HOST_ACCENT, '#cbe84f', '#9059fc', '#4f9cff', '#4fd18b', '#ff9f4f', '#ff6fae'];

const SHAPE_AXES = {
  font: ['sans', 'rounded', 'serif'],
  corners: ['sharp', 'soft', 'round'],
  buttons: ['rounded', 'pill', 'square'],
  cardStyle: ['outline', 'elevated', 'filled'],
} as const;
type ShapeAxis = keyof typeof SHAPE_AXES;

/** A kit with its empty fields dropped: absent means "the kit does not set this". */
function clean(kit: BrandKit): BrandKit {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kit)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out as BrandKit;
}

/**
 * The workspace brand kit editor: rows on the left (what each setting is and
 * why, the control on the right), the real booking page wearing the kit on the
 * right, rendered by the same `PreviewFrame` and `BookingFlow` the studio uses.
 * The preview is the page a TEAM renders with this kit, which is also what a
 * host's page becomes after "Apply brand kit" on a page that had no style of
 * its own.
 */
export function BrandKitPanel({
  initialKit,
  updatedAt,
  canEdit,
  bk,
  studio,
  locale,
  hostName,
  tabs,
}: {
  initialKit: BrandKit;
  updatedAt: number | null;
  canEdit: boolean;
  bk: BrandKitMessages;
  studio: StudioMessages;
  locale: string;
  hostName: string;
  tabs: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kit, setKit] = useState<BrandKit>(initialKit);
  const [savedKit, setSavedKit] = useState<string>(JSON.stringify(clean(initialKit)));
  const [savedAt, setSavedAt] = useState<number | null>(updatedAt);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const [surface, setSurface] = useState<'booking' | 'profile'>('booking');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');

  const dirty = JSON.stringify(clean(kit)) !== savedKit;
  const set = (patch: Partial<BrandKit>) => setKit((k) => ({ ...k, ...patch }));

  // The page a team renders with this kit: the kit over nothing.
  const preview = useMemo(() => withBrandKit({ brandColor: null, style: null }, clean(kit)), [kit]);
  const previewAccent = preview.brandColor ?? DEFAULT_ACCENT;
  const previewAxes = (preview.style ?? {}) as Record<string, string>;
  const logoUrl = kit.logoUrl || null;

  const save = () =>
    start(async () => {
      const next = clean(kit);
      const r = await saveBrandKitAction(next);
      if (r.ok) {
        setSavedKit(JSON.stringify(next));
        setSavedAt(r.updatedAt ?? Date.now());
        toast.success(bk.saved);
        router.refresh();
      } else {
        toast.error(bk.saveFailed);
      }
    });

  const keepOwn = { value: '', label: bk.keepPageOwn };
  const titleCase = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
  const accent = kit.accent ?? '';

  return (
    <div className="flex flex-col">
      <StatementHeader
        title={bk.title}
        statement={bk.statement}
        action={
          canEdit ? (
            <Button size="lg" onClick={save} disabled={!dirty || pending || busy} className="px-control-pad">
              {pending ? bk.saving : bk.save}
            </Button>
          ) : null
        }
      />
      {tabs}
      <div className="mb-group flex flex-wrap items-center gap-inline">
        <StatusChip
          status={savedKit !== '{}' ? 'confirmed' : 'pending'}
          label={savedKit !== '{}' ? bk.statusSet : bk.statusUnset}
          testId="brand-kit-status"
        />
        {savedAt ? (
          <span className="text-xs text-muted-foreground" suppressHydrationWarning>
            {t(bk.updatedOn, {
              date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(savedAt)),
            })}
          </span>
        ) : null}
        {!canEdit ? <span className="text-xs text-muted-foreground">{bk.readOnly}</span> : null}
      </div>

      <div className="grid gap-section lg:grid-cols-[minmax(0,26rem)_1fr]">
        <fieldset disabled={!canEdit} className="min-w-0">
          <SettingsRow title={bk.logo} hint={bk.logoHint} first testId="brand-kit-logo">
            <div className="flex flex-col gap-inline">
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-10 max-w-40 self-start object-contain" />
              ) : null}
              <div className="flex flex-wrap items-center gap-inline">
                <label
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'lg' }),
                    'cursor-pointer text-xs',
                    (busy || !canEdit) && 'pointer-events-none opacity-60',
                  )}
                  aria-busy={busy}
                >
                  <i aria-hidden className="pi pi-upload" style={{ fontSize: 12 }} />
                  {busy ? studio.imageWorking : studio.uploadImage}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={busy || !canEdit}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      setBusy(true);
                      try {
                        // The same pipeline as the avatar and the cover, at the
                        // logo's own target (a wordmark keeps its shape).
                        const r = await readImageFile(f, 'logo');
                        if (r.ok) {
                          set({ logoUrl: r.dataUrl });
                          setLogoError(null);
                        } else {
                          setLogoError(r.code === 'tooLarge' ? studio.imageTooLarge : studio.imageInvalid);
                        }
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </label>
                {logoUrl ? (
                  <Button variant="ghost" size="lg" className="text-xs text-muted-foreground" onClick={() => set({ logoUrl: null })}>
                    {studio.clear}
                  </Button>
                ) : null}
              </div>
              {logoError ? <span className="text-xs text-destructive">{logoError}</span> : null}
              <Input
                value={logoUrl && !logoUrl.startsWith('data:') ? logoUrl : ''}
                placeholder={studio.orPasteUrl}
                className="min-h-control w-full"
                onChange={(e) => set({ logoUrl: e.target.value || null })}
              />
            </div>
          </SettingsRow>

          <SettingsRow title={bk.accent} hint={bk.accentHint} testId="brand-kit-accent">
            <div className="flex flex-wrap items-center gap-tight">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set({ accent: c })}
                  aria-label={c}
                  aria-pressed={accent.toLowerCase() === c}
                  className="flex h-11 w-11 items-center justify-center rounded-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    style={{ background: c }}
                    className={`h-7 w-7 rounded-full border-2 ${accent.toLowerCase() === c ? 'border-foreground' : 'border-transparent'}`}
                  />
                </button>
              ))}
              <input
                type="color"
                aria-label={bk.accent}
                value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : NEW_HOST_ACCENT}
                onChange={(e) => set({ accent: e.target.value })}
                className="h-11 w-11 cursor-pointer rounded-md border border-input bg-background p-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {accent ? (
                <Button variant="ghost" size="lg" className="text-xs text-muted-foreground" onClick={() => set({ accent: null })}>
                  {bk.keepPageOwn}
                </Button>
              ) : null}
            </div>
          </SettingsRow>

          <SettingsRow title={bk.canvas} hint={bk.canvasHint} testId="brand-kit-canvas">
            <Select
              value={kit.theme ?? ''}
              options={[keepOwn, { value: 'light', label: studio.themeLight }, { value: 'dark', label: studio.themeDark }]}
              ariaLabel={bk.canvas}
              locale={locale}
              disabled={!canEdit}
              onChange={(v) => set({ theme: (v || undefined) as BrandKit['theme'] })}
            />
          </SettingsRow>

          {(Object.keys(SHAPE_AXES) as ShapeAxis[]).map((axis, i) => (
            <SettingsRow
              key={axis}
              title={bk[axis]}
              hint={i === 0 ? bk.shapeHint : undefined}
              testId={`brand-kit-${axis}`}
            >
              <Select
                value={(kit[axis] as string | undefined) ?? ''}
                options={[keepOwn, ...SHAPE_AXES[axis].map((v) => ({ value: v, label: titleCase(v) }))]}
                ariaLabel={bk[axis]}
                locale={locale}
                disabled={!canEdit}
                onChange={(v) => set({ [axis]: v || undefined } as Partial<BrandKit>)}
              />
            </SettingsRow>
          ))}

          <SettingsRow title={bk.howItWorks}>
            <p className="text-sm text-muted-foreground">{bk.howItWorksBody}</p>
          </SettingsRow>
        </fieldset>

        <div className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <SettingsPanel tone="well" title={bk.preview} hint={bk.previewHint}>
            <div className="flex flex-wrap items-center justify-between gap-inline">
              <div className="flex rounded-md border border-border p-tight text-sm">
                {(['booking', 'profile'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={surface === s}
                    onClick={() => setSurface(s)}
                    className={`inline-flex min-h-control items-center rounded-sm px-field transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${surface === s ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {s === 'booking' ? studio.bookingFlow : studio.previewProfile}
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
                    {d === 'desktop' ? studio.desktop : studio.mobile}
                  </button>
                ))}
              </div>
            </div>
            <PreviewFrame accent={previewAccent} axes={previewAxes} device={device} wide={surface === 'booking'}>
              {surface === 'booking' ? (
                <BookingPreview
                  hostName={hostName}
                  avatarUrl={null}
                  eventTitle={studio.introCall}
                  locale={locale}
                  device={device}
                  logoUrl={logoUrl}
                />
              ) : (
                <ProfilePreview
                  locale={locale}
                  displayName={hostName}
                  accountName={null}
                  bio=""
                  avatarUrl=""
                  coverUrl=""
                  events={[]}
                  logoUrl={logoUrl}
                />
              )}
            </PreviewFrame>
          </SettingsPanel>
        </div>
      </div>
    </div>
  );
}
