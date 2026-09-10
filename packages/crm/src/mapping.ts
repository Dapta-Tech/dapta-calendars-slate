/**
 * The PURE half of H2 (#108): which properties a source may target, how a
 * booking's answer becomes the string the provider wants, and what the editor
 * should suggest.
 *
 * NO I/O. This module is imported by the API (at delivery) and by the WEB app
 * (to filter the picker and draw the enumeration diff while the host is still
 * typing), which is why it is exported under its own `@slate/crm/mapping`
 * subpath: the browser gets the matrix and the normalizer, never the HTTP
 * adapter.
 *
 * It is vendor-shaped on purpose — `enumeration`, `bool`, the `;` multi-select
 * separator and the synonym table are HubSpot's, and ADR 0001 is why naming
 * that here is allowed (R15 governs CALENDAR vendors only).
 *
 * The two rules everything below serves, both from #64:
 *
 *  1. An incompatible mapping must be UNREACHABLE, not diagnosable. It cannot
 *     be offered in the picker and it cannot survive a save, because the
 *     alternative is a failure that arrives one booking at a time in an outbox
 *     nobody watches.
 *  2. A value the provider will reject is OMITTED, never sent. An enumeration
 *     value outside the option list returns 400 that fails the WHOLE contact
 *     write, not just that property — so one stale option must not cost a lead
 *     every other mapped answer.
 */
import {
  CRM_IDENTITY_PROPERTIES,
  crmSourceKey,
  type CrmAttendeeSourceField,
  type CrmEventSourceField,
  type CrmMappingSource,
  type CrmPropertyMapping,
  type CrmPropertyView,
} from '@slate/types';

/** HubSpot's separator for a multi-select enumeration value. */
const MULTI_SELECT_SEPARATOR = ';';

/** A multi-select enumeration, as opposed to `select` / `radio` (single). */
export function isMultiSelect(p: Pick<CrmPropertyView, 'type' | 'fieldType'>): boolean {
  return p.type === 'enumeration' && p.fieldType === 'checkbox';
}

/**
 * The intake-question types a booking form can collect. Kept as a local union
 * rather than imported so this module stays usable against a raw field
 * definition read out of a JSON column.
 */
export interface MappableField {
  name: string;
  label?: string;
  type: string;
  options?: string[];
}

/**
 * What a source needs from a target property, independent of the provider's
 * spelling. `null` means the source is not mappable at all.
 */
type TargetShape =
  | { types: readonly string[]; enumeration: 'single' | 'multi' | 'none'; preferFieldType?: string }
  | null;

/**
 * #64's compatibility table, in one place.
 *
 * `guests` is deliberately absent: guests are not contacts (#63), so the
 * question that collects them has no contact property to land on.
 */
export function targetShapeForSource(
  source: CrmMappingSource,
  fields: readonly MappableField[],
): TargetShape {
  if (source.kind === 'attendee') return attendeeTargetShape(source.field);
  if (source.kind === 'event') return eventTargetShape(source.field);
  const field = fields.find((f) => f.name === source.name);
  if (!field) return null;
  return questionTargetShape(field);
}

function questionTargetShape(field: MappableField): TargetShape {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'email':
      return { types: ['string'], enumeration: 'none' };
    case 'phone':
      // A phone answer is still a string to the provider; `phonenumber` is
      // merely the field type a host most likely wants, so it sorts first.
      return { types: ['string'], enumeration: 'none', preferFieldType: 'phonenumber' };
    case 'number':
      return { types: ['number'], enumeration: 'none' };
    case 'select':
      return { types: ['enumeration', 'string'], enumeration: 'single' };
    case 'checkbox':
      // WITH options it is a multi-choice question; WITHOUT them it is one
      // box, which is a boolean and nothing else.
      return field.options && field.options.length > 0
        ? { types: ['enumeration', 'string'], enumeration: 'multi' }
        : { types: ['bool'], enumeration: 'none' };
    default:
      // `guests`, and anything a later field type adds before this table knows
      // about it. Unmappable is the safe default: a new source kind must be
      // added here deliberately, not inherited by accident.
      return null;
  }
}

function attendeeTargetShape(field: CrmAttendeeSourceField): TargetShape {
  if (field === 'phone') {
    return { types: ['string'], enumeration: 'none', preferFieldType: 'phonenumber' };
  }
  return { types: ['string'], enumeration: 'none' };
}

function eventTargetShape(field: CrmEventSourceField): TargetShape {
  switch (field) {
    case 'startUtc':
      return { types: ['datetime', 'date'], enumeration: 'none' };
    case 'lengthMinutes':
      return { types: ['number'], enumeration: 'none' };
    default:
      return { types: ['string'], enumeration: 'none' };
  }
}

/** True when this property can receive this source at all. */
export function isCompatible(
  source: CrmMappingSource,
  property: CrmPropertyView,
  fields: readonly MappableField[],
): boolean {
  const shape = targetShapeForSource(source, fields);
  if (!shape) return false;
  if ((CRM_IDENTITY_PROPERTIES as readonly string[]).includes(property.name.toLowerCase())) {
    return false;
  }
  if (!shape.types.includes(property.type)) return false;
  if (property.type !== 'enumeration') return true;
  // A single-choice answer cannot fill a multi-select and vice versa: the
  // provider stores one as a `;`-joined list and the other as a bare value.
  if (shape.enumeration === 'single') return !isMultiSelect(property);
  if (shape.enumeration === 'multi') return isMultiSelect(property);
  return false;
}

/**
 * The picker's list for one source: compatible, not already claimed by another
 * source, `preferFieldType` first, then alphabetical by label.
 *
 * `claimedBy` maps a lowercased property name to the source key holding it, so
 * the row being edited keeps seeing its OWN current target.
 */
export function candidateProperties(
  source: CrmMappingSource,
  properties: readonly CrmPropertyView[],
  fields: readonly MappableField[],
  claimedBy: ReadonlyMap<string, string> = new Map(),
): CrmPropertyView[] {
  const mine = crmSourceKey(source);
  const shape = targetShapeForSource(source, fields);
  return properties
    .filter((p) => isCompatible(source, p, fields))
    .filter((p) => {
      const holder = claimedBy.get(p.name.toLowerCase());
      return holder === undefined || holder === mine;
    })
    .sort((a, b) => {
      if (shape?.preferFieldType) {
        const av = a.fieldType === shape.preferFieldType ? 0 : 1;
        const bv = b.fieldType === shape.preferFieldType ? 0 : 1;
        if (av !== bv) return av - bv;
      }
      return a.label.localeCompare(b.label);
    });
}

/** Which source (by `crmSourceKey`) holds each property. */
export function claimedProperties(
  mappings: readonly CrmPropertyMapping[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of mappings) {
    for (const p of m.properties) out.set(p.toLowerCase(), crmSourceKey(m.source));
  }
  return out;
}

// --- Normalization + enumeration matching ---------------------------------

/**
 * Lowercase, accent-stripped, whitespace-collapsed, punctuation-trimmed.
 *
 * The single normalizer for BOTH enumeration option matching and auto-map, so
 * the diff the editor shows and the value delivery sends can never disagree
 * about what "matches".
 */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The provider option whose `value` OR `label` normalizes to this answer. */
export function matchOption(
  answer: string,
  options: readonly { value: string; label: string }[],
): { value: string; label: string } | null {
  const n = normalize(answer);
  if (!n) return null;
  return (
    options.find((o) => normalize(o.value) === n) ??
    options.find((o) => normalize(o.label) === n) ??
    null
  );
}

export interface EnumerationDiff {
  /** The question's options that DO land on a provider option. */
  matched: string[];
  /** The ones that do not — omitted at delivery, named at configure time. */
  unmatched: string[];
}

/**
 * The configure-time diff #64 requires: "3 of 5 options match; these 2 will not
 * be sent". Empty `unmatched` on a non-enumeration target, because there is
 * nothing to reconcile.
 */
export function enumerationDiff(
  field: MappableField | undefined,
  property: CrmPropertyView | undefined,
): EnumerationDiff {
  if (!field?.options?.length || property?.type !== 'enumeration') {
    return { matched: [], unmatched: [] };
  }
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const option of field.options) {
    (matchOption(option, property.options) ? matched : unmatched).push(option);
  }
  return { matched, unmatched };
}

// --- Value coercion --------------------------------------------------------

/** Everything one booking can feed a mapping. */
export interface MappingValueContext {
  /** Raw intake answers, keyed by question name. */
  answers: Record<string, unknown>;
  /** The event type's question definitions — the source of each answer's type. */
  fields: readonly MappableField[];
  attendee: {
    phone: string | null;
    notes: string | null;
    timeZone: string | null;
    language: string | null;
  };
  event: {
    eventTypeTitle: string | null;
    /** ISO-8601 UTC. */
    startUtc: string | null;
    lengthMinutes: number | null;
    hostName: string | null;
    hostEmail: string | null;
  };
}

/** The raw value behind a source, before any provider-shaped coercion. */
function rawValue(source: CrmMappingSource, ctx: MappingValueContext): unknown {
  switch (source.kind) {
    case 'question':
      return ctx.answers[source.name];
    case 'attendee':
      return ctx.attendee[source.field];
    case 'event':
      return ctx.event[source.field];
  }
}

/**
 * One source value → the string this property wants, or `null` to OMIT it.
 *
 * Every `null` here is deliberate. Writing a blank over a real CRM value is a
 * silent data loss, and sending a value the provider rejects fails the entire
 * contact write — so "omit" is the only safe answer to anything uncertain.
 */
export function coerceValue(value: unknown, property: CrmPropertyView): string | null {
  if (value == null || value === '') return null;

  switch (property.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      return Number.isFinite(n) ? String(n) : null;
    }

    case 'bool': {
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      const n = normalize(String(value));
      if (['true', 'yes', 'y', '1', 'si', 'sí'].includes(n)) return 'true';
      if (['false', 'no', 'n', '0'].includes(n)) return 'false';
      return null;
    }

    case 'datetime': {
      const ms = toEpochMs(value);
      return ms === null ? null : String(ms);
    }

    case 'date': {
      // THE DATE TRAP (#64): a `datetime` accepts any epoch millisecond, but a
      // `date` demands MIDNIGHT UTC — anything else is a 400. Truncating here
      // is what lets both types stay offered in the picker.
      const ms = toEpochMs(value);
      if (ms === null) return null;
      return String(Date.UTC(
        new Date(ms).getUTCFullYear(),
        new Date(ms).getUTCMonth(),
        new Date(ms).getUTCDate(),
      ));
    }

    case 'enumeration': {
      const answers = Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
      const matched = answers
        .map((a) => matchOption(a, property.options)?.value)
        .filter((v): v is string => !!v);
      // An unmatched value is DROPPED, and a mapping where nothing matched
      // omits the property entirely rather than sending an empty string.
      if (matched.length === 0) return null;
      if (!isMultiSelect(property)) return matched[0]!;
      return [...new Set(matched)].join(MULTI_SELECT_SEPARATOR);
    }

    default: {
      // `string` and anything the provider adds later. An array (a multi-choice
      // answer landing on a plain text property) reads better joined than as
      // `[object Object]`.
      const text = Array.isArray(value)
        ? value.map((v) => String(v)).join(', ')
        : typeof value === 'boolean'
          ? value
            ? 'true'
            : 'false'
          : String(value);
      const trimmed = text.trim();
      return trimmed === '' ? null : trimmed;
    }
  }
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The whole delivery-time job: mappings + this booking → the property bag.
 *
 * A target the portal no longer has is skipped rather than guessed at — its
 * type is unknown, so any coercion would be a coin flip, and the editor already
 * shows that row in red. Identity is filtered again here even though the
 * contract refuses it: this bag is what reaches a PATCH, and ADR 0005's
 * guarantee should hold no matter which caller assembled it.
 */
export function buildMappedProperties(
  mappings: readonly CrmPropertyMapping[],
  properties: readonly CrmPropertyView[],
  ctx: MappingValueContext,
): Record<string, string> {
  const byName = new Map(properties.map((p) => [p.name.toLowerCase(), p]));
  const out: Record<string, string> = {};
  for (const mapping of mappings) {
    const raw = rawValue(mapping.source, ctx);
    if (raw == null || raw === '') continue;
    for (const target of mapping.properties) {
      const key = target.toLowerCase();
      if ((CRM_IDENTITY_PROPERTIES as readonly string[]).includes(key)) continue;
      const property = byName.get(key);
      if (!property) continue;
      const coerced = coerceValue(raw, property);
      if (coerced !== null) out[property.name] = coerced;
    }
  }
  return out;
}

// --- Auto-map --------------------------------------------------------------

/**
 * #64's ES→EN synonym table. Thin on purpose: it exists so a Spanish-speaking
 * host's questions land on the provider's English stock property names, not to
 * be a translation layer.
 */
const SYNONYMS: Record<string, string> = {
  empresa: 'company',
  compania: 'company',
  organizacion: 'company',
  telefono: 'phone',
  celular: 'phone',
  movil: 'phone',
  cargo: 'jobtitle',
  puesto: 'jobtitle',
  'sitio web': 'website',
  web: 'website',
  pais: 'country',
  ciudad: 'city',
  presupuesto: 'budget',
  'tamano de empresa': 'numemployees',
  'numero de empleados': 'numemployees',
};

/** The normalized handles a source answers to, best first. */
function sourceAliases(source: CrmMappingSource, fields: readonly MappableField[]): string[] {
  const raw: string[] = [];
  if (source.kind === 'question') {
    const field = fields.find((f) => f.name === source.name);
    raw.push(source.name);
    if (field?.label) raw.push(field.label);
  } else {
    raw.push(source.field);
  }
  const aliases: string[] = [];
  for (const value of raw) {
    const n = normalize(value);
    if (!n) continue;
    aliases.push(n);
    const synonym = SYNONYMS[n];
    if (synonym) aliases.push(synonym);
  }
  return [...new Set(aliases)];
}

/**
 * Suggest one property per source. SUGGESTS ONLY — #64 refuses to auto-save,
 * because writing to a host's CRM something they never approved is exactly what
 * the overwrite rule makes dangerous.
 *
 * A suggestion is only ever a property that exists in the portal, passes the
 * filter, is type-compatible, and is not already claimed. Sources are walked in
 * order and each claim is recorded, so two questions cannot both be handed the
 * same property.
 */
export function suggestMappings(
  sources: readonly CrmMappingSource[],
  properties: readonly CrmPropertyView[],
  fields: readonly MappableField[],
  alreadyClaimed: ReadonlyMap<string, string> = new Map(),
): CrmPropertyMapping[] {
  const claimed = new Map(alreadyClaimed);
  const out: CrmPropertyMapping[] = [];
  for (const source of sources) {
    const aliases = sourceAliases(source, fields);
    if (aliases.length === 0) continue;
    const candidates = candidateProperties(source, properties, fields, claimed);
    const hit = candidates.find((p) => {
      const name = normalize(p.name);
      const label = normalize(p.label);
      return aliases.some((a) => a === name || a === label);
    });
    if (!hit) continue;
    claimed.set(hit.name.toLowerCase(), crmSourceKey(source));
    out.push({ source, properties: [hit.name] });
  }
  return out;
}
