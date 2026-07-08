'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  ALL_BOOKING_THEMES,
  THEME_PRESETS,
  accentVars,
  widgetStyleVars,
  clampAccent,
  accentWasAdjusted,
  onAccent,
  matchTheme,
  monogram,
  type PublicBranding,
} from '@slate/shared';
import { saveBrandingAction } from './actions';

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

export function Studio({
  displayName,
  initialAccent,
  initialAxes,
}: {
  displayName: string;
  initialAccent: string;
  initialAxes: Axes;
}) {
  const [accent, setAccent] = useState(initialAccent);
  const [axes, setAxes] = useState<Axes>(initialAxes);
  const [saved, setSaved] = useState<'idle' | 'ok' | 'err'>('idle');
  const [pending, start] = useTransition();

  const activeTheme = useMemo(() => matchTheme(axes), [axes]);
  const previewVars = useMemo(
    () => ({ ...accentVars(accent), ...widgetStyleVars(axes) }) as Record<string, string>,
    [accent, axes],
  );
  const adjusted = accentWasAdjusted(accent);

  const applyTheme = (t: keyof typeof THEME_PRESETS) => setAxes({ ...THEME_PRESETS[t] });
  const setAxis = (k: keyof Axes, v: string) => setAxes((a) => ({ ...a, [k]: v as never }));

  const save = () =>
    start(async () => {
      const r = await saveBrandingAction({ brandColor: clampAccent(accent), style: axes });
      setSaved(r.ok ? 'ok' : 'err');
    });

  return (
    <div className="grid gap-8 lg:grid-cols-[380px_1fr]">
      {/* Controls */}
      <div className="flex flex-col gap-6">
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Theme</h3>
          <div className="flex flex-wrap gap-2">
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
            <span className="self-center text-xs text-muted-foreground">
              {activeTheme ? '' : 'Custom'}
            </span>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Accent</h3>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#cbe84f'}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-12 rounded-md border border-input bg-background"
            />
            <input
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          {adjusted ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Adjusted to {clampAccent(accent)} for legibility (AA).
            </p>
          ) : null}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Customize appearance</h3>
          <div className="grid grid-cols-2 gap-3">
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
        </section>

        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="self-start rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {saved === 'ok' ? <p className="text-sm text-primary">Saved.</p> : null}
        {saved === 'err' ? <p className="text-sm text-destructive">Save failed.</p> : null}
      </div>

      {/* Live preview (preview == prod render, branded via the engine vars) */}
      <div className="rounded-md border border-border p-6" style={previewVars}>
        <div
          className="mx-auto max-w-md"
          style={{ fontFamily: 'var(--bp-font-body)' }}
        >
          <div className="mb-4 flex items-center gap-3">
            <div
              className="flex h-12 w-12 items-center justify-center text-lg font-semibold"
              style={{
                background: 'var(--accent)',
                color: onAccent(clampAccent(accent)),
                borderRadius: 'var(--bp-radius)',
              }}
            >
              {monogram(displayName)}
            </div>
            <div style={{ fontFamily: 'var(--bp-font-display)' }} className="text-lg font-semibold">
              {displayName}
            </div>
          </div>
          <div
            className="mb-4 p-4"
            style={{
              borderRadius: 'var(--bp-radius)',
              padding: 'var(--bp-pad)',
              border: axes.cardStyle === 'outline' ? '1px solid var(--border)' : 'none',
              background: axes.cardStyle === 'filled' ? 'var(--accent-soft)' : 'var(--card)',
              boxShadow: axes.cardStyle === 'elevated' ? '0 6px 20px rgba(0,0,0,0.25)' : 'none',
            }}
          >
            <div className="font-medium">Intro Call</div>
            <div className="text-sm text-muted-foreground">30 min</div>
          </div>
          <div className="flex flex-wrap" style={{ gap: 'var(--bp-gap)' }}>
            {['9:00', '9:30', '10:00', '10:30'].map((s, i) => (
              <span
                key={s}
                style={{
                  borderRadius: 'var(--bp-btn-radius)',
                  padding: 'var(--bp-slot-pad)',
                  border: '1px solid var(--accent)',
                  background: i === 0 ? 'var(--accent)' : 'transparent',
                  color: i === 0 ? onAccent(clampAccent(accent)) : 'var(--foreground)',
                }}
                className="text-sm"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
