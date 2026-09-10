'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import {
  candidateProperties,
  claimedProperties,
  enumerationDiff,
  suggestMappings,
  type MappableField,
} from '@slate/crm/mapping';
import {
  CRM_ATTENDEE_SOURCE_FIELDS,
  CRM_EVENT_SOURCE_FIELDS,
  MAX_CRM_MAPPINGS_PER_EVENT,
  MAX_CRM_TARGETS_PER_MAPPING,
  crmSourceKey,
  type CrmMappingSource,
  type CrmPropertyCatalog,
  type CrmPropertyMapping,
  type CrmPropertyView,
} from '@slate/types';
import { Select, type SelectOption } from '@/components/ui/select';
import { refreshCrmPropertiesAction } from './actions';
import type { EventTypeMessages } from './event-type-form';

/**
 * H2 (#108) — the intake question → CRM contact property mapping section.
 *
 * It lives in the EVENT TYPE EDITOR rather than in Settings → Integrations
 * (#64): the admin owns the credential, but the host owns the mapping, and a
 * non-admin host may never see the Settings tab at all. It is placed last in
 * the form so Reminders keeps its adjacency to the intake questions its
 * `{{form.*}}` variables read.
 *
 * Three states, in the order a deployment meets them:
 *
 *   1. No CRM adapter on this deployment → the section does not render. A bare
 *      fork sees nothing, exactly as it did before this feature existed.
 *   2. Adapter, but this account has connected nothing → an empty state that
 *      links to Integrations. The mappings a host already saved are still
 *      shown, because they SURVIVE a disconnect (#64) — reconnecting the same
 *      portal resumes without reconfiguration.
 *   3. Connected → the table.
 *
 * Everything the picker filters on comes from `@slate/crm/mapping`, the same
 * pure module delivery uses. That is what makes "an incompatible mapping is
 * unreachable" true rather than aspirational: the editor cannot offer a pair
 * the coercion could not deliver, and the contract refuses one anyway.
 */

export interface CrmMappingSectionProps {
  provider: string;
  catalog: CrmPropertyCatalog;
  /** The event type's CURRENT questions — live, so changing a type re-filters. */
  fields: MappableField[];
  mappings: CrmPropertyMapping[];
  onChange: (next: CrmPropertyMapping[]) => void;
  m: EventTypeMessages['crmMapping'];
  locale: 'en' | 'es';
}

export function CrmMappingSection({
  provider,
  catalog: initialCatalog,
  fields,
  mappings,
  onChange,
  m,
  locale,
}: CrmMappingSectionProps) {
  // Refreshing REPLACES the list without touching the host's unsaved mappings:
  // the list is reference data, the mappings are their work in progress.
  const [catalog, setCatalog] = useState(initialCatalog);
  const [refreshing, startRefresh] = useTransition();
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const properties = catalog.properties;
  const byName = useMemo(
    () => new Map(properties.map((p) => [p.name.toLowerCase(), p])),
    [properties],
  );
  const claimed = useMemo(() => claimedProperties(mappings), [mappings]);
  /** Sources already held by a row — including rows with no target yet. */
  const takenSources = useMemo(
    () => new Set(mappings.map((row) => crmSourceKey(row.source))),
    [mappings],
  );

  /** Every source a host may map, grouped for the picker. */
  const sourceGroups = useMemo(
    () => buildSourceGroups(fields, m),
    [fields, m],
  );
  const sourceLabels = useMemo(() => {
    const out = new Map<string, string>();
    for (const group of sourceGroups) {
      for (const option of group.options) out.set(option.key, option.label);
    }
    return out;
  }, [sourceGroups]);

  const refresh = () =>
    startRefresh(async () => {
      setSuggestion(null);
      setCatalog(await refreshCrmPropertiesAction());
    });

  const suggest = () => {
    // Only sources no row already holds, so pressing this twice cannot
    // overwrite a choice the host made by hand.
    const open = sourceGroups
      .flatMap((g) => g.options)
      .map((o) => o.source)
      .filter((s) => !takenSources.has(crmSourceKey(s)));
    // Bounded by the same cap the Add button respects — a portal with many
    // matching property names must not push the list past what will save.
    const room = MAX_CRM_MAPPINGS_PER_EVENT - mappings.length;
    const suggested = suggestMappings(open, properties, fields, claimed).slice(0, Math.max(room, 0));
    setSuggestion(
      suggested.length === 0
        ? m.suggestNone
        : m.suggestFilled.replace('{n}', String(suggested.length)),
    );
    if (suggested.length > 0) onChange([...mappings, ...suggested]);
  };

  const setRow = (i: number, next: CrmPropertyMapping) =>
    onChange(mappings.map((row, j) => (j === i ? next : row)));

  const atCap = mappings.length >= MAX_CRM_MAPPINGS_PER_EVENT;

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-semibold text-muted-foreground">{m.sectionTitle}</span>
      <p className="max-w-prose text-xs text-muted-foreground">
        {m.sectionHint.replace('{provider}', provider)}
      </p>

      {/* Identity, shown rather than merely absent: the exception to the
          overwrite rule has to be visible for the rule to make sense (ADR 0005). */}
      <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border bg-background/40 p-3">
        <span className="text-xs font-medium text-muted-foreground">{m.identityTitle}</span>
        <div className="flex flex-wrap gap-2">
          {[m.identityEmail, m.identityFirstName, m.identityLastName].map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
            >
              <LockIcon />
              {label}
            </span>
          ))}
        </div>
        <p className="max-w-prose text-xs text-muted-foreground">{m.identityHint}</p>
      </div>

      {!catalog.connected ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-border bg-background/60 p-3">
          <span className="text-sm text-muted-foreground">{m.notConnectedTitle}</span>
          <p className="text-xs text-muted-foreground">
            {m.notConnectedBody}{' '}
            <Link
              href="/admin/settings/integrations"
              className="font-medium text-primary underline underline-offset-4"
            >
              {m.notConnectedLink}
            </Link>
          </p>
        </div>
      ) : (
        <>
          {catalog.reason === 'unavailable' ? (
            <p className="text-xs text-destructive" role="alert">
              {m.unavailable}
            </p>
          ) : null}

          {properties.length === 0 && catalog.reason !== 'unavailable' ? (
            <p className="text-xs text-muted-foreground">{m.noProperties}</p>
          ) : null}

          {mappings.length === 0 ? (
            <p className="text-xs text-muted-foreground">{m.noMappings}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {mappings.map((row, i) => (
                <MappingRow
                  key={`${crmSourceKey(row.source)}-${i}`}
                  row={row}
                  index={i}
                  groups={sourceGroups}
                  sourceLabels={sourceLabels}
                  properties={properties}
                  byName={byName}
                  fields={fields}
                  claimed={claimed}
                  takenSources={takenSources}
                  onChange={(next) => setRow(i, next)}
                  onRemove={() => onChange(mappings.filter((_, j) => j !== i))}
                  m={m}
                  locale={locale}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={atCap || sourceGroups.every((g) => g.options.length === 0)}
              onClick={() => {
                const next = sourceGroups
                  .flatMap((g) => g.options)
                  .find((o) => !takenSources.has(o.key));
                if (next) onChange([...mappings, { source: next.source, properties: [] }]);
              }}
              className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
            >
              {m.addMapping}
            </button>
            <button
              type="button"
              onClick={suggest}
              disabled={properties.length === 0 || atCap}
              className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
            >
              {m.suggest}
            </button>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {refreshing ? m.refreshing : m.refresh}
            </button>
            {atCap ? (
              <span className="text-xs text-muted-foreground">
                {m.capReached.replace('{max}', String(MAX_CRM_MAPPINGS_PER_EVENT))}
              </span>
            ) : null}
          </div>

          {suggestion ? (
            <p className="text-xs text-muted-foreground" role="status">
              {suggestion} {m.suggestNotSaved}
            </p>
          ) : null}
          <p className="max-w-prose text-xs text-muted-foreground">{m.createInProviderHint}</p>
        </>
      )}
    </div>
  );
}

/** One mapping: a source, its target properties, and the enumeration diff. */
function MappingRow({
  row,
  index,
  groups,
  sourceLabels,
  properties,
  byName,
  fields,
  claimed,
  takenSources,
  onChange,
  onRemove,
  m,
  locale,
}: {
  row: CrmPropertyMapping;
  index: number;
  groups: SourceGroup[];
  sourceLabels: ReadonlyMap<string, string>;
  properties: CrmPropertyView[];
  byName: ReadonlyMap<string, CrmPropertyView>;
  fields: MappableField[];
  claimed: ReadonlyMap<string, string>;
  takenSources: ReadonlySet<string>;
  onChange: (next: CrmPropertyMapping) => void;
  onRemove: () => void;
  m: EventTypeMessages['crmMapping'];
  locale: 'en' | 'es';
}) {
  const sourceKey = crmSourceKey(row.source);
  const source = row.source;
  const field =
    source.kind === 'question' ? fields.find((f) => f.name === source.name) : undefined;

  // Compatible AND unclaimed, computed from the LIVE question list — changing a
  // question's type re-filters this picker on the next render.
  const candidates = candidateProperties(row.source, properties, fields, claimed);

  const sourceOptions: SelectOption[] = groups.flatMap((group) =>
    group.options.map((o) => ({
      value: o.key,
      label: `${group.label} · ${o.label}`,
      // A source held by ANOTHER ROW is shown but not selectable; this row's
      // own source always is. Derived from the rows rather than from claimed
      // properties, because a row whose target is still empty holds its source
      // too — and letting two of them pick the same one produces a save the
      // contract refuses.
      disabled: o.key !== sourceKey && takenSources.has(o.key),
    })),
  );

  const targets = row.properties.length > 0 ? row.properties : [''];

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[12rem] flex-1">
          <Select
            value={sourceKey}
            onChange={(value) => {
              const next = groups.flatMap((g) => g.options).find((o) => o.key === value);
              if (next) onChange({ ...row, source: next.source, properties: [] });
            }}
            options={sourceOptions}
            placeholder={m.sourcePlaceholder}
            ariaLabel={`${m.sourceLabel} ${index + 1}`}
            searchable
            locale={locale}
          />
        </div>
        <span aria-hidden className="text-xs text-muted-foreground">
          &rsaquo;
        </span>
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
          {targets.map((target, t) => (
            <div key={`${target}-${t}`} className="flex flex-col gap-0.5">
              <Select
                value={target}
                onChange={(value) => {
                  const next = [...targets];
                  next[t] = value;
                  onChange({ ...row, properties: next.filter((v) => v !== '') });
                }}
                options={targetOptions(candidates, target, byName, targets, t)}
                placeholder={m.propertyPlaceholder}
                ariaLabel={`${m.propertyLabel} ${index + 1}`}
                searchable
                locale={locale}
              />
              {/* A stored target the portal no longer has. The whole new error
                  surface (#64): delivery already degrades gracefully, so this
                  only has to be visible, not blocking. */}
              {target !== '' && !byName.has(target.toLowerCase()) ? (
                <span className="text-xs text-destructive" role="alert">
                  {m.missingProperty}
                </span>
              ) : null}
            </div>
          ))}
          {row.properties.length > 0 && row.properties.length < MAX_CRM_TARGETS_PER_MAPPING ? (
            <button
              type="button"
              onClick={() => onChange({ ...row, properties: [...row.properties, ''] })}
              className="self-start text-xs text-muted-foreground hover:text-primary"
            >
              {m.addTarget}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${m.removeMapping} — ${sourceLabels.get(sourceKey) ?? sourceKey}`}
          className="text-muted-foreground hover:text-destructive"
        >
          ×
        </button>
      </div>
      <EnumerationDiffLine field={field} targets={row.properties} byName={byName} m={m} />
    </div>
  );
}

/**
 * The configure-time enumeration reconciliation (#64).
 *
 * It exists because the alternative is a 400 that fails the WHOLE contact write
 * at delivery, one booking at a time, in an outbox nobody watches. Named here,
 * the host can fix it before a single booking is lost.
 */
function EnumerationDiffLine({
  field,
  targets,
  byName,
  m,
}: {
  field: MappableField | undefined;
  targets: string[];
  byName: ReadonlyMap<string, CrmPropertyView>;
  m: EventTypeMessages['crmMapping'];
}) {
  const lines = targets
    .map((t) => byName.get(t.toLowerCase()))
    .filter((p): p is CrmPropertyView => !!p)
    .map((property) => ({ property, diff: enumerationDiff(field, property) }))
    .filter(({ diff }) => diff.matched.length + diff.unmatched.length > 0);

  if (lines.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {lines.map(({ property, diff }) => {
        const total = diff.matched.length + diff.unmatched.length;
        if (diff.unmatched.length === 0) {
          return (
            <span key={property.name} className="text-xs text-muted-foreground">
              {property.label}: {m.optionsMatch}
            </span>
          );
        }
        return (
          <span key={property.name} className="text-xs text-destructive" role="alert">
            {property.label}:{' '}
            {diff.matched.length === 0
              ? m.optionsNone
              : m.optionsPartial
                  .replace('{matched}', String(diff.matched.length))
                  .replace('{total}', String(total))
                  .replace('{values}', diff.unmatched.join(', '))}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The picker's options for one target slot.
 *
 * A CURRENT value the portal no longer has is kept in the list rather than
 * dropped, so opening the page does not silently rewrite a mapping the host
 * saved. A property another slot of the SAME row already holds is removed:
 * `candidateProperties` only knows about claims by other SOURCES, and the
 * contract refuses a property listed twice — so without this the second slot
 * could produce a save that fails.
 */
function targetOptions(
  candidates: CrmPropertyView[],
  current: string,
  byName: ReadonlyMap<string, CrmPropertyView>,
  siblings: readonly string[] = [],
  slot = -1,
): SelectOption[] {
  const takenBySibling = new Set(
    siblings.filter((v, i) => i !== slot && v !== '').map((v) => v.toLowerCase()),
  );
  const options = candidates
    .filter((p) => !takenBySibling.has(p.name.toLowerCase()))
    .map((p) => ({ value: p.name, label: `${p.label} (${p.name})` }));
  if (current !== '' && !byName.has(current.toLowerCase())) {
    options.unshift({ value: current, label: current });
  } else if (current !== '' && !options.some((o) => o.value === current)) {
    const p = byName.get(current.toLowerCase())!;
    options.unshift({ value: p.name, label: `${p.label} (${p.name})` });
  }
  return options;
}

interface SourceOption {
  key: string;
  label: string;
  source: CrmMappingSource;
}
interface SourceGroup {
  label: string;
  options: SourceOption[];
}

/**
 * Every mappable source, grouped.
 *
 * `guests` is excluded because guests are not contacts (#63), and a question
 * with no name is excluded because it is a row the host has not finished
 * writing yet.
 */
function buildSourceGroups(
  fields: MappableField[],
  m: EventTypeMessages['crmMapping'],
): SourceGroup[] {
  const questions: SourceOption[] = fields
    .filter((f) => f.name && f.type !== 'guests')
    .map((f) => ({
      key: `question:${f.name}`,
      label: f.label || f.name,
      source: { kind: 'question', name: f.name } as const,
    }));

  const attendeeLabels: Record<(typeof CRM_ATTENDEE_SOURCE_FIELDS)[number], string> = {
    phone: m.attendeePhone,
    notes: m.attendeeNotes,
    timeZone: m.attendeeTimeZone,
    language: m.attendeeLanguage,
  };
  const eventLabels: Record<(typeof CRM_EVENT_SOURCE_FIELDS)[number], string> = {
    eventTypeTitle: m.eventTypeTitle,
    startUtc: m.eventStart,
    lengthMinutes: m.eventLength,
    hostName: m.eventHostName,
    hostEmail: m.eventHostEmail,
  };

  return [
    { label: m.groupQuestions, options: questions },
    {
      label: m.groupAttendee,
      options: CRM_ATTENDEE_SOURCE_FIELDS.map((field) => ({
        key: `attendee:${field}`,
        label: attendeeLabels[field],
        source: { kind: 'attendee', field } as const,
      })),
    },
    {
      label: m.groupEvent,
      options: CRM_EVENT_SOURCE_FIELDS.map((field) => ({
        key: `event:${field}`,
        label: eventLabels[field],
        source: { kind: 'event', field } as const,
      })),
    },
  ];
}

function LockIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
