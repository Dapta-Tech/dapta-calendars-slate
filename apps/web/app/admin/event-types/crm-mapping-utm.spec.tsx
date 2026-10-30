/**
 * The CRM mapping section offers the booking's campaign as a source: a
 * "Campaign (UTM)" group with the five `utm_*` keys, EN and ES, after the
 * questions, the attendee and the event. A saved campaign row reads back under
 * its own label, and a target that cannot take free text is flagged like any
 * other incompatible pair.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { getMessages } from '@slate/shared';
import type { CrmPropertyCatalog, CrmPropertyMapping } from '@slate/types';

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('./actions', () => ({ refreshCrmPropertiesAction: vi.fn() }));

import { CrmMappingSection, buildSourceGroups } from './crm-mapping-section';

const en = getMessages('en').admin.eventTypes.crmMapping;
const es = getMessages('es').admin.eventTypes.crmMapping;

const CATALOG: CrmPropertyCatalog = {
  provider: 'hubspot',
  connected: true,
  fetchedAt: 0,
  reason: null,
  properties: [
    { name: 'utm_source', label: 'UTM source', type: 'string', fieldType: 'text', options: [] },
    { name: 'annualrevenue', label: 'Annual revenue', type: 'number', fieldType: 'number', options: [] },
  ],
};

function render(mappings: CrmPropertyMapping[], locale: 'en' | 'es' = 'en'): string {
  return renderToStaticMarkup(
    <CrmMappingSection
      provider="HubSpot"
      catalog={CATALOG}
      fields={[{ name: 'company', label: 'Company', type: 'text' }]}
      mappings={mappings}
      onChange={() => undefined}
      m={locale === 'es' ? es : en}
      locale={locale}
    />,
  );
}

describe('the campaign as a CRM mapping source', () => {
  it('is the last group, with the five utm_* keys in link order', () => {
    const groups = buildSourceGroups([{ name: 'company', label: 'Company', type: 'text' }], en);
    const campaign = groups.at(-1)!;
    expect(groups.map((g) => g.label)).toEqual(['Intake questions', 'Attendee details', 'Event details', 'Campaign (UTM)']);
    expect(campaign.options.map((o) => o.key)).toEqual([
      'utm:utm_source',
      'utm:utm_medium',
      'utm:utm_campaign',
      'utm:utm_term',
      'utm:utm_content',
    ]);
    expect(campaign.options.map((o) => o.label)).toEqual([
      'Source (utm_source)',
      'Medium (utm_medium)',
      'Campaign (utm_campaign)',
      'Term (utm_term)',
      'Content (utm_content)',
    ]);
    expect(campaign.options[0]!.source).toEqual({ kind: 'utm', field: 'utm_source' });
  });

  it('says it in Spanish, keeping each key as it is', () => {
    const campaign = buildSourceGroups([], es).at(-1)!;
    expect(campaign.label).toBe('Campaña (UTM)');
    expect(campaign.options.map((o) => o.label)).toEqual([
      'Fuente (utm_source)',
      'Medio (utm_medium)',
      'Campaña (utm_campaign)',
      'Término (utm_term)',
      'Contenido (utm_content)',
    ]);
  });

  it('reads a saved campaign row back under its label, onto a text property, with no warning', () => {
    const html = render([{ source: { kind: 'utm', field: 'utm_source' }, properties: ['utm_source'] }]);
    expect(html).toContain('Campaign (UTM) · Source (utm_source)');
    expect(html).toContain('UTM source');
    expect(html).not.toContain(en.incompatibleProperty);
    expect(html).not.toContain(en.missingQuestion);
  });

  it('flags a campaign row aimed at a number property, which the save would refuse', () => {
    const html = render([{ source: { kind: 'utm', field: 'utm_campaign' }, properties: ['annualrevenue'] }], 'es');
    expect(html).toContain('Campaña (UTM) · Campaña (utm_campaign)');
    expect(html).toContain(es.incompatibleProperty);
  });
});
