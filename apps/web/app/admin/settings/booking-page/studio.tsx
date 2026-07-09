'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ALL_BOOKING_THEMES,
  THEME_PRESETS,
  accentVars,
  widgetStyleVars,
  brandingClassOf,
  clampAccent,
  accentWasAdjusted,
  accentLabelContrast,
  onAccent,
  matchTheme,
  monogram,
  type PublicBranding,
} from '@slate/shared';
import { saveStudioAction } from './actions';

type Axes = Pick<
  PublicBranding,
  'template' | 'cardStyle' | 'corners' | 'buttons' | 'density' | 'font' | 'slotLayout' | 'dayGroup' | 'slotSelect'
>;

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
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface EventTypeLite {
  slug: string;
  title: string;
  lengthMinutes: number;
}

export interface StudioInit {
  accountCode: string;
  displayName: string;
  handle: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  accent: string;
  axes: Axes;
  eventTypes: EventTypeLite[];
}

type HandleState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export function Studio(init: StudioInit) {
  const [displayName, setDisplayName] = useState(init.displayName);
  const [handle, setHandle] = useState(init.handle);
  const [bio, setBio] = useState(init.bio);
  const [avatarUrl, setAvatarUrl] = useState(init.avatarUrl);
  const [coverUrl, setCoverUrl] = useState(init.coverUrl);
  const [accent, setAccent] = useState(init.accent);
  const [axes, setAxes] = useState<Axes>(init.axes);
  const [customizeOpen, setCustomizeOpen] = useState(matchTheme(init.axes) === null);
  const [surface, setSurface] = useState<'profile' | 'booking'>('profile');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [handleState, setHandleState] = useState<HandleState>('idle');
  const [handleSuggestion, setHandleSuggestion] = useState<string | null>(null);
  const [saved, setSaved] = useState<'idle' | 'ok' | 'err'>('idle');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const snapshot = useMemo(
    () => JSON.stringify({ displayName, handle, bio, avatarUrl, coverUrl, accent, axes }),
    [displayName, handle, bio, avatarUrl, coverUrl, accent, axes],
  );
  const initialSnapshot = useRef(snapshot);
  const isDirty = snapshot !== initialSnapshot.current;

  const activeTheme = useMemo(() => matchTheme(axes), [axes]);
  const previewVars = useMemo(
    () => ({ ...accentVars(accent), ...widgetStyleVars(axes) }) as Record<string, string>,
    [accent, axes],
  );
  const adjusted = accentWasAdjusted(accent);

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
        const r = await fetch(`${API}/v1/handle-available?handle=${encodeURIComponent(handle)}`, {
          cache: 'no-store',
        });
        const j = (await r.json()) as { available: boolean; suggestion?: string };
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
  };

  const save = () =>
    start(async () => {
      const r = await saveStudioAction({
        handle: handle !== init.handle ? handle : undefined,
        displayName,
        avatarUrl: avatarUrl.trim() || null,
        coverUrl: coverUrl.trim() || null,
        brandColor: clampAccent(accent),
        style: { ...axes, bio: bio.trim() || null },
      });
      if (r.ok) {
        setSaved('ok');
        setSaveMsg(null);
        initialSnapshot.current = snapshot;
      } else {
        setSaved('err');
        setSaveMsg(r.message ?? 'Save failed.');
      }
    });

  return (
    <div className="flex flex-col gap-6">
      {/* Header: dirty chip + Reset/Save top-right */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`rounded-sm px-2 py-1 text-xs ${
              isDirty ? 'bg-secondary text-secondary-foreground' : 'bg-muted text-muted-foreground'
            }`}
          >
            {isDirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          {saved === 'ok' ? <span className="text-sm text-primary">Saved.</span> : null}
          {saved === 'err' ? <span className="text-sm text-destructive">{saveMsg}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={!isDirty || pending}
            className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!isDirty || pending || handleBlocksSave}
            className="rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[400px_1fr]">
        {/* Controls */}
        <div className="flex flex-col gap-6">
          {/* PROFILE */}
          <Section title="Profile">
            <Field label="Display name">
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Public handle">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">/{init.accountCode}/</span>
                <input
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())}
                  className={`${inputCls} flex-1`}
                />
              </div>
              <HandleHint state={handleState} />
              {handleState === 'taken' && handleSuggestion ? (
                <button
                  type="button"
                  onClick={() => setHandle(handleSuggestion)}
                  className="self-start text-xs text-primary hover:underline"
                >
                  Try {handleSuggestion} →
                </button>
              ) : null}
            </Field>
            <Field label="Bio">
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={2} className={inputCls} />
            </Field>
          </Section>

          {/* BRAND */}
          <Section title="Brand">
            <Field label="Accent">
              <div className="mb-2 flex flex-wrap gap-2">
                {ACCENT_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setAccent(c)}
                    aria-label={c}
                    style={{ background: c }}
                    className={`h-7 w-7 rounded-full border-2 ${
                      accent.toLowerCase() === c ? 'border-foreground' : 'border-transparent'
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#cbe84f'}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-7 w-9 rounded-md border border-input bg-background"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Contrast {accentLabelContrast(accent)}:1
                {adjusted ? ` · adjusted to ${clampAccent(accent)} for legibility (AA)` : ''}
              </p>
            </Field>
            <Field label="Avatar URL">
              <input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" className={inputCls} />
            </Field>
            <Field label="Cover URL">
              <input value={coverUrl} onChange={(e) => setCoverUrl(e.target.value)} placeholder="https://…" className={inputCls} />
            </Field>
          </Section>

          {/* APPEARANCE */}
          <Section title="Appearance">
            <div className="mb-3 flex flex-wrap gap-2">
              {ALL_BOOKING_THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => applyTheme(t)}
                  className={`rounded-md border px-3 py-1.5 text-sm capitalize transition-transform active:scale-[0.97] ${
                    activeTheme === t ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                  }`}
                >
                  {t}
                </button>
              ))}
              <span className="self-center text-xs text-muted-foreground">{activeTheme ? '' : 'Custom'}</span>
            </div>
            <button
              type="button"
              onClick={() => setCustomizeOpen((o) => !o)}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {customizeOpen ? '▾' : '▸'} Customize appearance
            </button>
            {customizeOpen ? (
              <div className="mt-3 grid grid-cols-2 gap-3">
                {(Object.keys(AXIS_OPTIONS) as (keyof Axes)[]).map((k) => (
                  <label key={k} className="flex flex-col gap-1 text-sm">
                    <span className="capitalize text-muted-foreground">{k}</span>
                    <select
                      value={axes[k]}
                      onChange={(e) => setAxis(k, e.target.value)}
                      data-testid={`bp-${k}-${axes[k]}`}
                      className="rounded-md border border-input bg-background px-2 py-1.5 capitalize"
                    >
                      {AXIS_OPTIONS[k].map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            ) : null}
          </Section>

          {/* MEETINGS */}
          <Section title="Meetings">
            <ul className="flex flex-col gap-1 text-sm">
              {init.eventTypes.map((et) => (
                <li key={et.slug} className="flex items-center justify-between rounded-sm bg-muted px-3 py-1.5">
                  <span>{et.title}</span>
                  <span className="text-muted-foreground">{et.lengthMinutes} min</span>
                </li>
              ))}
              {init.eventTypes.length === 0 ? <li className="text-muted-foreground">No events yet.</li> : null}
            </ul>
          </Section>
        </div>

        {/* Live preview (sticky) */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex rounded-md border border-border p-0.5 text-sm">
              {(['profile', 'booking'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSurface(s)}
                  className={`rounded-sm px-3 py-1 capitalize ${surface === s ? 'bg-accent' : ''}`}
                >
                  {s === 'booking' ? 'Booking flow' : 'Profile'}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-border p-0.5 text-sm">
              {(['desktop', 'mobile'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDevice(d)}
                  className={`rounded-sm px-3 py-1 capitalize ${device === d ? 'bg-accent' : ''}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border p-6" style={previewVars}>
            <div className={`${brandingClassOf(axes)} ${device === 'mobile' ? 'mx-auto w-[360px]' : 'mx-auto max-w-md'}`}>
              {surface === 'profile' ? (
                <ProfilePreview
                  displayName={displayName}
                  bio={bio}
                  avatarUrl={avatarUrl}
                  coverUrl={coverUrl}
                  accent={accent}
                  eventTypes={init.eventTypes}
                />
              ) : (
                <BookingPreview accent={accent} />
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
}: {
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  accent: string;
  eventTypes: EventTypeLite[];
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
            style={{ background: 'var(--accent)', color: onAccent(clampAccent(accent)), borderRadius: 'var(--bp-radius)' }}
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
        {(eventTypes.length ? eventTypes : [{ slug: 'intro', title: 'Intro Call', lengthMinutes: 30 }]).map((et) => (
          <div key={et.slug} className="bp-card flex items-center justify-between">
            <span className="font-medium">{et.title}</span>
            <span className="text-sm text-muted-foreground">{et.lengthMinutes} min</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BookingPreview({ accent: _accent }: { accent: string }) {
  return (
    <div>
      <div className="bp-card mb-4">
        <div className="font-medium">Intro Call</div>
        <div className="text-sm text-muted-foreground">30 min</div>
      </div>
      <div className="bp-slots">
        {['9:00', '9:30', '10:00', '10:30'].map((s, i) => (
          <button key={s} type="button" aria-pressed={i === 0} className="bp-slot text-sm">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function HandleHint({ state }: { state: HandleState }) {
  const map: Record<HandleState, { text: string; cls: string } | null> = {
    idle: null,
    checking: { text: 'Checking…', cls: 'text-muted-foreground' },
    available: { text: '✓ Available', cls: 'text-primary' },
    taken: { text: '✗ Taken', cls: 'text-destructive' },
    invalid: { text: 'Invalid (3–40 chars, a–z 0–9 -)', cls: 'text-destructive' },
  };
  const h = map[state];
  return h ? <span className={`text-xs ${h.cls}`}>{h.text}</span> : null;
}

const inputCls = 'rounded-md border border-input bg-background px-3 py-2 w-full';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-card p-4">
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
