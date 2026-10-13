'use client';

import { useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import { SettingsRow } from '@/components/ui/settings';
import { StatusChip, type BookingChipStatus } from '@/components/ui/status-chip';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/toast';
import { saveBrandingAction } from './actions';

export interface BrandingState {
  /** The stored choice, kept even while it is not honoured. */
  hideBranding: boolean;
  /** The account may turn the branding off now (paying Dapta AI customer, or an open deployment). */
  canHide: boolean;
  /** What the public pages carry right now. */
  showing: boolean;
}

/** The three states a host can be in, named once so the chip and the copy agree. */
export type BrandingMode = 'on' | 'off' | 'lapsed';

export function brandingMode(s: BrandingState): BrandingMode {
  if (!s.hideBranding) return 'on';
  return s.canHide ? 'off' : 'lapsed';
}

const CHIP: Record<BrandingMode, BookingChipStatus> = { on: 'cancelled', off: 'confirmed', lapsed: 'pending' };

/**
 * Settings → General: "Show Dapta branding on my pages".
 *
 *  - on (the default): the switch is on; a paying account can turn it off.
 *  - off (entitled): the switch is off, and the pages carry no Dapta branding.
 *  - off but lapsed: the switch shows the stored choice (off), with the
 *    sentence that the subscription ended and the branding is showing again.
 *    The choice is kept, so re-subscribing brings it back untouched; an owner
 *    can still turn the branding back on, which never needs the subscription.
 *
 * Not entitled, the switch is disabled with "Included with your Dapta AI
 * subscription", linked to the Dapta AI app when the deployment names it
 * (NEXT_PUBLIC_PLATFORM_URL; no host is written in this tree). Members see the
 * row read-only: only owners and admins change it.
 */
export function BrandingSetting({
  initial,
  canEdit,
  platformUrl,
  messages: m,
}: {
  initial: BrandingState;
  canEdit: boolean;
  platformUrl: string | null;
  messages: BookingMessages['admin']['brandingSetting'];
}) {
  const [state, setState] = useState(initial);
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const mode = brandingMode(state);
  const chipLabel = mode === 'on' ? m.chipShowing : mode === 'off' ? m.chipHidden : m.chipShowingAgain;
  // Only turning the branding OFF needs the subscription. Turning it back ON
  // never does, so a lapsed choice (stored off, not paying) stays usable.
  const enabled = canEdit && !pending && (state.canHide || state.hideBranding);

  const note =
    mode === 'lapsed' ? (
      <p data-testid="branding-lapsed" className="text-xs text-muted-foreground">
        {m.lapsed}
      </p>
    ) : !state.canHide ? (
      <p data-testid="branding-included" className="text-xs text-muted-foreground">
        {platformUrl ? (
          <a href={platformUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            {m.included}
          </a>
        ) : (
          m.included
        )}
      </p>
    ) : null;

  return (
    <SettingsRow first title={m.title} hint={m.hint} testId="branding-setting">
      <div className="flex flex-col gap-tight">
        <div className="flex min-h-control flex-wrap items-center gap-x-field gap-y-tight">
          <span className="flex items-center gap-inline text-sm text-foreground">
            <Switch
              checked={!state.hideBranding}
              disabled={!enabled}
              aria-label={m.switchLabel}
              onCheckedChange={(show) =>
                start(async () => {
                  const r = await saveBrandingAction(!show);
                  if (r.ok) {
                    setState(r.branding);
                    success(m.saved);
                  } else error(m.saveFailed);
                })
              }
            />
            <span className={enabled ? undefined : 'text-muted-foreground'}>{m.switchLabel}</span>
          </span>
          <StatusChip status={CHIP[mode]} label={chipLabel} testId="branding-chip" />
        </div>
        {note}
        {!canEdit ? <p className="text-xs text-muted-foreground">{m.membersReadOnly}</p> : null}
      </div>
    </SettingsRow>
  );
}
