'use client';

import { useId } from 'react';
import {
  EVENT_TRACKING_HOST_SCRIPT_KEYS,
  EVENT_TRACKING_KEYS,
  MAX_POSTHOG_HOST,
  MAX_POSTHOG_KEY,
  MAX_TRACKING_ID,
  POSTHOG_HOSTS,
  eventTrackingSchema,
  type EventTracking,
} from '@slate/types';
import { EventTypeMessages, Field, inputCls } from './shared';

export type TrackingKey = (typeof EVENT_TRACKING_KEYS)[number];

export type TrackingDraft = Record<TrackingKey, string>;

/** The editor's text per vendor, '' for an id the event does not set. */
export function trackingDraftOf(tracking: EventTracking | null | undefined): TrackingDraft {
  const draft = {} as TrackingDraft;
  for (const key of EVENT_TRACKING_KEYS) draft[key] = tracking?.[key] ?? '';
  return draft;
}

/** The fields the section shows: every workspace's, then GTM, GA4 and HubSpot where allowed. */
export function trackingKeysShown(hostScriptsEnabled: boolean): TrackingKey[] {
  return EVENT_TRACKING_KEYS.filter(
    (key) => hostScriptsEnabled || !(EVENT_TRACKING_HOST_SCRIPT_KEYS as readonly string[]).includes(key),
  );
}

/** The shown fields the API would refuse, in the order the section lists them. */
export function invalidTrackingKeys(draft: TrackingDraft, keys: TrackingKey[]): TrackingKey[] {
  return keys.filter((key) => !eventTrackingSchema.shape[key].safeParse(draft[key]).success);
}

export type TrackingText = keyof EventTypeMessages['tracking'];

export const TRACKING_FIELDS: Record<
  TrackingKey,
  { label: TrackingText; help: TrackingText; invalid: TrackingText; placeholder: string; max: number }
> = {
  metaPixelId: { label: 'metaLabel', help: 'metaHelp', invalid: 'metaInvalid', placeholder: '123456789012345', max: MAX_TRACKING_ID },
  ga4Id: { label: 'ga4Label', help: 'ga4Help', invalid: 'ga4Invalid', placeholder: 'G-XXXXXXXXXX', max: MAX_TRACKING_ID },
  posthogKey: { label: 'posthogKeyLabel', help: 'posthogKeyHelp', invalid: 'posthogKeyInvalid', placeholder: 'phc_...', max: MAX_POSTHOG_KEY },
  posthogHost: { label: 'posthogHostLabel', help: 'posthogHostHelp', invalid: 'posthogHostInvalid', placeholder: '', max: MAX_POSTHOG_HOST },
  gtmId: { label: 'gtmLabel', help: 'gtmHelp', invalid: 'gtmInvalid', placeholder: 'GTM-XXXXXXX', max: MAX_TRACKING_ID },
  hubspotTrackingId: { label: 'hubspotLabel', help: 'hubspotHelp', invalid: 'hubspotInvalid', placeholder: '12345678', max: MAX_TRACKING_ID },
};

/** The PostHog cloud select's value: US is the default, so it is stored as none. */
export function posthogCloudOf(host: string): '' | 'eu' {
  return /^https:\/\/eu\.i\.posthog\.com\/?$/i.test(host.trim()) ? 'eu' : '';
}

/**
 * Tracking and pixels on the event's booking page, per event type: one field
 * per vendor, each with the line that says what its tag hears. Saved with the
 * event, live at once (there is no draft here). The PostHog cloud is a choice
 * of two, not an address: any other host would be the host's own code.
 */
export function TrackingSection({
  draft,
  onChange,
  onBlur,
  invalid,
  inputRefs,
  keys,
  hostScriptsEnabled,
  m,
}: {
  draft: TrackingDraft;
  onChange: (key: TrackingKey, value: string) => void;
  onBlur: (key: TrackingKey) => void;
  /** Fields to show an error on (invalid AND already left or saved). */
  invalid: TrackingKey[];
  inputRefs: React.MutableRefObject<Partial<Record<TrackingKey, HTMLInputElement | HTMLSelectElement | null>>>;
  keys: TrackingKey[];
  hostScriptsEnabled: boolean;
  m: EventTypeMessages['tracking'];
}) {
  const baseId = useId();
  return (
    <section className="flex flex-col gap-inline" aria-labelledby={`${baseId}-title`}>
      <span id={`${baseId}-title`} className="text-sm font-semibold text-muted-foreground">
        {m.title}
      </span>
      <p className="text-xs text-muted-foreground">{m.subtitle}</p>
      <div className="grid gap-field sm:grid-cols-2">
        {keys.map((key) => {
          const { label, help, invalid: invalidText, placeholder, max } = TRACKING_FIELDS[key];
          const bad = invalid.includes(key);
          const hintId = `${baseId}-${key}-hint`;
          const errorId = `${baseId}-${key}-error`;
          const described = bad ? `${errorId} ${hintId}` : hintId;
          return (
            <div key={key} className="flex flex-col gap-tight">
              <Field label={m[label]}>
                {key === 'posthogHost' ? (
                  <select
                    id={`et-tracking-${key}`}
                    ref={(el) => {
                      inputRefs.current[key] = el;
                    }}
                    value={posthogCloudOf(draft[key])}
                    onChange={(e) => onChange(key, e.target.value === 'eu' ? POSTHOG_HOSTS[1] : '')}
                    onBlur={() => onBlur(key)}
                    aria-invalid={bad ? true : undefined}
                    aria-describedby={described}
                    className={inputCls}
                  >
                    <option value="">{m.posthogHostUs}</option>
                    <option value="eu">{m.posthogHostEu}</option>
                  </select>
                ) : (
                  <input
                    id={`et-tracking-${key}`}
                    ref={(el) => {
                      inputRefs.current[key] = el;
                    }}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={max}
                    placeholder={placeholder}
                    value={draft[key]}
                    onChange={(e) => onChange(key, e.target.value)}
                    onBlur={() => onBlur(key)}
                    aria-invalid={bad ? true : undefined}
                    aria-describedby={described}
                    className={inputCls}
                  />
                )}
              </Field>
              {bad ? (
                <p id={errorId} className="text-xs text-destructive" role="alert">
                  {m[invalidText]}
                </p>
              ) : null}
              <p id={hintId} className="text-xs text-muted-foreground">
                {m[help]}
              </p>
            </div>
          );
        })}
      </div>
      {hostScriptsEnabled ? null : <p className="text-xs text-muted-foreground">{m.hostScriptsUnavailable}</p>}
    </section>
  );
}
