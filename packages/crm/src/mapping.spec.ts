import { describe, expect, it } from 'vitest';
import type { CrmMappingSource, CrmPropertyView } from '@slate/types';
import {
  buildMappedProperties,
  candidateProperties,
  claimedProperties,
  coerceValue,
  enumerationDiff,
  isCompatible,
  matchOption,
  normalize,
  suggestMappings,
  type MappableField,
} from './mapping';

/** A property as the picker sees it — the flags are filtered off upstream. */
function prop(over: Partial<CrmPropertyView> & { name: string }): CrmPropertyView {
  return {
    label: over.name,
    type: 'string',
    fieldType: 'text',
    options: [],
    ...over,
  };
}

const question = (name: string): CrmMappingSource => ({ kind: 'question', name });

describe('type compatibility (#64)', () => {
  const fields: MappableField[] = [
    { name: 'notes_q', label: 'Notes', type: 'textarea' },
    { name: 'budget', label: 'Budget', type: 'number' },
    { name: 'size', label: 'Company size', type: 'select', options: ['1-10', '11-50'] },
    { name: 'stack', label: 'Stack', type: 'checkbox', options: ['react', 'vue'] },
    { name: 'optin', label: 'Opt in', type: 'checkbox' },
    { name: 'mobile', label: 'Mobile', type: 'phone' },
    { name: 'friends', label: 'Guests', type: 'guests' },
  ];

  it('lets a text answer target a string and nothing else', () => {
    expect(isCompatible(question('notes_q'), prop({ name: 'message' }), fields)).toBe(true);
    expect(
      isCompatible(question('notes_q'), prop({ name: 'revenue', type: 'number' }), fields),
    ).toBe(false);
  });

  it('lets a number answer target only a number', () => {
    expect(isCompatible(question('budget'), prop({ name: 'rev', type: 'number' }), fields)).toBe(true);
    expect(isCompatible(question('budget'), prop({ name: 'note' }), fields)).toBe(false);
  });

  it('splits single- from multi-select enumerations', () => {
    const single = prop({ name: 'tier', type: 'enumeration', fieldType: 'select' });
    const multi = prop({ name: 'tags', type: 'enumeration', fieldType: 'checkbox' });
    expect(isCompatible(question('size'), single, fields)).toBe(true);
    expect(isCompatible(question('size'), multi, fields)).toBe(false);
    expect(isCompatible(question('stack'), multi, fields)).toBe(true);
    expect(isCompatible(question('stack'), single, fields)).toBe(false);
  });

  it('treats a checkbox WITHOUT options as a boolean', () => {
    const bool = prop({ name: 'subscribed', type: 'bool', fieldType: 'booleancheckbox' });
    expect(isCompatible(question('optin'), bool, fields)).toBe(true);
    expect(isCompatible(question('optin'), prop({ name: 'note' }), fields)).toBe(false);
    // …and a checkbox WITH options is not a boolean.
    expect(isCompatible(question('stack'), bool, fields)).toBe(false);
  });

  it('refuses `guests` outright — guests are not contacts (#63)', () => {
    expect(isCompatible(question('friends'), prop({ name: 'message' }), fields)).toBe(false);
    expect(candidateProperties(question('friends'), [prop({ name: 'message' })], fields)).toEqual([]);
  });

  it('never offers an identity property, whatever the source', () => {
    for (const name of ['email', 'firstname', 'lastname', 'FirstName']) {
      expect(isCompatible(question('notes_q'), prop({ name }), fields)).toBe(false);
    }
  });

  it('offers booking start as datetime OR date', () => {
    const src: CrmMappingSource = { kind: 'event', field: 'startUtc' };
    expect(isCompatible(src, prop({ name: 'a', type: 'datetime' }), fields)).toBe(true);
    expect(isCompatible(src, prop({ name: 'b', type: 'date' }), fields)).toBe(true);
    expect(isCompatible(src, prop({ name: 'c', type: 'string' }), fields)).toBe(false);
  });

  it('sorts a phone-shaped target first, then by label', () => {
    const props = [
      prop({ name: 'zzz', label: 'Zebra' }),
      prop({ name: 'aaa', label: 'Apple' }),
      prop({ name: 'mobilephone', label: 'Mobile', fieldType: 'phonenumber' }),
    ];
    const out = candidateProperties(question('mobile'), props, fields);
    expect(out.map((p) => p.name)).toEqual(['mobilephone', 'aaa', 'zzz']);
  });

  it('hides a property another source already claims, but keeps its own', () => {
    const props = [prop({ name: 'a' }), prop({ name: 'b' })];
    const claimed = claimedProperties([
      { source: question('other'), properties: ['a'] },
      { source: question('notes_q'), properties: ['b'] },
    ]);
    const out = candidateProperties(question('notes_q'), props, fields, claimed);
    expect(out.map((p) => p.name)).toEqual(['b']);
  });
});

describe('normalization and enumeration matching', () => {
  it('strips accents, case, and separators', () => {
    expect(normalize('  Teléfono_Móvil ')).toBe('telefono movil');
    expect(normalize('Company   Size')).toBe('company size');
  });

  it('matches an option on its value OR its label', () => {
    const options = [
      { value: 'tier_one', label: 'Tier One' },
      { value: 'dos', label: 'Dós' },
    ];
    expect(matchOption('Tier One', options)?.value).toBe('tier_one');
    expect(matchOption('tier one', options)?.value).toBe('tier_one');
    expect(matchOption('DOS', options)?.value).toBe('dos');
    expect(matchOption('nope', options)).toBeNull();
  });

  it('names exactly the options that will not be sent (#64)', () => {
    const field: MappableField = {
      name: 'size',
      type: 'select',
      options: ['1-10', '11-50', 'Enorme'],
    };
    const property = prop({
      name: 'tier',
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { value: '1_10', label: '1-10' },
        { value: '11_50', label: '11-50' },
      ],
    });
    expect(enumerationDiff(field, property)).toEqual({
      matched: ['1-10', '11-50'],
      unmatched: ['Enorme'],
    });
  });

  it('has nothing to reconcile against a non-enumeration target', () => {
    const field: MappableField = { name: 'size', type: 'select', options: ['a'] };
    expect(enumerationDiff(field, prop({ name: 'note' }))).toEqual({ matched: [], unmatched: [] });
  });
});

describe('value coercion', () => {
  it('truncates a datetime to midnight UTC for a `date` — the #64 date trap', () => {
    const midDay = '2026-03-04T15:30:00.000Z';
    const asDateTime = coerceValue(midDay, prop({ name: 'x', type: 'datetime' }));
    const asDate = coerceValue(midDay, prop({ name: 'x', type: 'date' }));
    expect(asDateTime).toBe(String(Date.parse(midDay)));
    expect(asDate).toBe(String(Date.UTC(2026, 2, 4)));
    expect(Number(asDate) % 86_400_000).toBe(0);
  });

  it('omits rather than sending anything empty or unparseable', () => {
    expect(coerceValue('', prop({ name: 'x' }))).toBeNull();
    expect(coerceValue('   ', prop({ name: 'x' }))).toBeNull();
    expect(coerceValue(null, prop({ name: 'x' }))).toBeNull();
    expect(coerceValue('abc', prop({ name: 'x', type: 'number' }))).toBeNull();
    expect(coerceValue('not a date', prop({ name: 'x', type: 'datetime' }))).toBeNull();
  });

  it('reads a boolean out of either a real boolean or its written forms', () => {
    const bool = prop({ name: 'x', type: 'bool' });
    expect(coerceValue(true, bool)).toBe('true');
    expect(coerceValue('Sí', bool)).toBe('true');
    expect(coerceValue('no', bool)).toBe('false');
    expect(coerceValue('maybe', bool)).toBeNull();
  });

  it('joins a multi-select with `;` and DROPS values outside the option list', () => {
    const multi = prop({
      name: 'tags',
      type: 'enumeration',
      fieldType: 'checkbox',
      options: [
        { value: 'react', label: 'React' },
        { value: 'vue', label: 'Vue' },
      ],
    });
    expect(coerceValue(['React', 'vue', 'svelte'], multi)).toBe('react;vue');
    // Nothing matched ⇒ the property is OMITTED, never sent empty: a value
    // outside the list 400s the whole contact write.
    expect(coerceValue(['svelte'], multi)).toBeNull();
  });
});

describe('buildMappedProperties', () => {
  const properties = [
    prop({ name: 'annualrevenue', type: 'number' }),
    prop({ name: 'phone', fieldType: 'phonenumber' }),
    prop({ name: 'mobilephone', fieldType: 'phonenumber' }),
    prop({ name: 'last_meeting', type: 'datetime' }),
  ];
  const ctx = {
    answers: { budget: '50000', empty: '' },
    fields: [{ name: 'budget', type: 'number' }] as MappableField[],
    attendee: { phone: '+573001112222', notes: null, timeZone: 'America/Bogota', language: 'es' },
    event: {
      eventTypeTitle: 'Intro call',
      startUtc: '2026-03-04T15:30:00.000Z',
      lengthMinutes: 30,
      hostName: 'Alex Rivera',
      hostEmail: 'alex@example.com',
    },
  };

  it('fans one source out onto several properties', () => {
    const out = buildMappedProperties(
      [{ source: { kind: 'attendee', field: 'phone' }, properties: ['phone', 'mobilephone'] }],
      properties,
      ctx,
    );
    expect(out).toEqual({ phone: '+573001112222', mobilephone: '+573001112222' });
  });

  it('skips a target the portal no longer has rather than guessing its type', () => {
    const out = buildMappedProperties(
      [{ source: question('budget'), properties: ['annualrevenue', 'gone_property'] }],
      properties,
      ctx,
    );
    expect(out).toEqual({ annualrevenue: '50000' });
  });

  it('never emits an identity property, even when a mapping names one', () => {
    // The contract refuses this and the picker never offers it; the builder is
    // the third guard on ADR 0005's rule.
    const out = buildMappedProperties(
      [{ source: question('budget'), properties: ['email', 'firstname', 'lastname'] }],
      [...properties, prop({ name: 'email' }), prop({ name: 'firstname' })],
      ctx,
    );
    expect(out).toEqual({});
  });

  it('skips a source the booking has no value for', () => {
    const out = buildMappedProperties(
      [
        { source: question('empty'), properties: ['annualrevenue'] },
        { source: { kind: 'attendee', field: 'notes' }, properties: ['phone'] },
      ],
      properties,
      ctx,
    );
    expect(out).toEqual({});
  });
});

describe('auto-map', () => {
  const properties = [
    prop({ name: 'company', label: 'Company name' }),
    prop({ name: 'jobtitle', label: 'Job title' }),
    prop({ name: 'phone', label: 'Phone number', fieldType: 'phonenumber' }),
    prop({ name: 'unrelated', label: 'Unrelated' }),
  ];

  it('matches Spanish question names onto stock English properties (#64)', () => {
    const fields: MappableField[] = [
      { name: 'empresa', label: 'Empresa', type: 'text' },
      { name: 'cargo', label: 'Cargo', type: 'text' },
    ];
    const out = suggestMappings(fields.map((f) => question(f.name)), properties, fields);
    expect(out).toEqual([
      { source: question('empresa'), properties: ['company'] },
      { source: question('cargo'), properties: ['jobtitle'] },
    ]);
  });

  it('never suggests the same property twice', () => {
    const fields: MappableField[] = [
      { name: 'empresa', label: 'Empresa', type: 'text' },
      { name: 'company', label: 'Company', type: 'text' },
    ];
    const out = suggestMappings(fields.map((f) => question(f.name)), properties, fields);
    expect(out).toHaveLength(1);
    expect(out[0]!.properties).toEqual(['company']);
  });

  it('suggests nothing when nothing matches', () => {
    const fields: MappableField[] = [{ name: 'zzz', label: 'Zzz', type: 'text' }];
    expect(suggestMappings([question('zzz')], properties, fields)).toEqual([]);
  });

  it('respects type compatibility — a number question never lands on a string', () => {
    const fields: MappableField[] = [{ name: 'company', label: 'Company', type: 'number' }];
    expect(suggestMappings([question('company')], properties, fields)).toEqual([]);
  });
});
