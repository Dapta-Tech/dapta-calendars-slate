// @vitest-environment jsdom
/**
 * Preview == production, asserted rather than promised.
 *
 * The studio renders a host's event page inside `PreviewFrame`; the public route
 * renders it inside `BrandedShell`. For every value of every one of the ten
 * style axes, this renders both from the SAME stored config and checks that
 * they agree on everything that decides how the page looks: the canvas they
 * stamp, the custom properties they emit, the branding classes, the booking
 * ground, and the page's own HTML, element for element.
 *
 * The page's HTML can only agree because the preview renders the real island
 * (`BookingFlow`), not a copy of its markup. If someone ever puts a mock back,
 * the last assertion is the one that fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_ACCENT, NEW_HOST_ACCENT, NEW_HOST_THEME, THEME_PRESETS } from '@slate/shared';
import { teamBranding } from '@/lib/brand-kit';


vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));

import { BookingFlow } from './booking-flow';
import { BrandedShell } from './branded-shell';
import { BookingPreview, PreviewFrame, ProfilePreview, previewFlowProps } from './booking-preview';
import { ProfileView } from './profile-view';
import { getMessages } from '@slate/shared';

const ACCENT = '#2f6fed';
const AXES: Record<string, readonly string[]> = {
  template: ['classic', 'split', 'banded'],
  cardStyle: ['outline', 'elevated', 'filled'],
  corners: ['sharp', 'soft', 'round'],
  buttons: ['rounded', 'pill', 'square'],
  density: ['comfortable', 'compact'],
  font: ['sans', 'rounded', 'serif'],
  slotLayout: ['grid', 'list'],
  dayGroup: ['flat', 'boxed'],
  slotSelect: ['soft', 'solid'],
  theme: ['dark', 'light'],
};
const BASE = { ...THEME_PRESETS.modern, theme: 'light' };
const SAMPLE = { hostName: 'Riley Chen', avatarUrl: null, eventTitle: 'Intro call', locale: 'en' };

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

/** `--a: 1; --b: 2` as a map, so order does not matter. */
function vars(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

const BRANDING = /^(branded-surface|tpl-|card-|slots-|day-|sel-)/;
function brandingClasses(el: Element): string[] {
  return [...el.classList].filter((c) => BRANDING.test(c)).sort();
}

/** `useId` values depend on where in a tree a component sits; nothing else may differ. */
function page(doc: Document): string {
  const flow = doc.querySelector('.bp-flow');
  expect(flow, 'no .bp-flow rendered').not.toBeNull();
  return flow!.outerHTML.replace(/_R_[a-z0-9_]+_/gi, 'ID');
}

function renderPreview(style: Record<string, string>, device: 'desktop' | 'mobile') {
  return parse(
    renderToStaticMarkup(
      <PreviewFrame accent={ACCENT} axes={style as never} device={device} wide>
        <BookingPreview {...SAMPLE} device={device} />
      </PreviewFrame>,
    ),
  );
}

function renderPublic(style: Record<string, string>) {
  return parse(
    renderToStaticMarkup(
      <BrandedShell brandColor={ACCENT} style={style}>
        <main>
          <BookingFlow {...previewFlowProps(SAMPLE)} />
        </main>
      </BrandedShell>,
    ),
  );
}

describe('the studio preview renders what the public page renders', () => {
  for (const [axis, values] of Object.entries(AXES)) {
    for (const value of values) {
      it(`${axis}: ${value}`, () => {
        const style = { ...BASE, [axis]: value } as Record<string, string>;
        const pub = renderPublic(style);
        const shell = pub.querySelector('.branded-surface')!;

        for (const device of ['mobile', 'desktop'] as const) {
          const pre = renderPreview(style, device);
          const frame = pre.querySelector('[data-theme]')!;
          const surface = pre.querySelector('.branded-surface')!;

          // The same ground, painted from the same frozen palette.
          expect(frame.getAttribute('data-theme')).toBe(shell.getAttribute('data-theme'));
          expect(frame.classList.contains('bp-ground')).toBe(true);
          expect(shell.classList.contains('bp-ground')).toBe(true);
          // The same custom properties, from the same functions and canvas.
          expect(vars(frame)).toEqual(vars(shell));
          // The same class-driven axes.
          expect(brandingClasses(surface)).toEqual(brandingClasses(shell));
          // The same page.
          expect(page(pre)).toBe(page(pub));
        }
      });
    }
  }

  // "Use the new look" sets the accent and all ten axes at once. The preview
  // the host decides on has to be the page they get.
  it('the new look: ink on paper, the minimal set', () => {
    const style = { ...THEME_PRESETS.minimal, theme: NEW_HOST_THEME } as Record<string, string>;
    const pub = parse(
      renderToStaticMarkup(
        <BrandedShell brandColor={NEW_HOST_ACCENT} style={style}>
          <main>
            <BookingFlow {...previewFlowProps(SAMPLE)} />
          </main>
        </BrandedShell>,
      ),
    );
    const shell = pub.querySelector('.branded-surface')!;
    for (const device of ['mobile', 'desktop'] as const) {
      const pre = parse(
        renderToStaticMarkup(
          <PreviewFrame accent={NEW_HOST_ACCENT} axes={style as never} device={device} wide>
            <BookingPreview {...SAMPLE} device={device} />
          </PreviewFrame>,
        ),
      );
      const frame = pre.querySelector('[data-theme]')!;
      expect(frame.getAttribute('data-theme')).toBe('light');
      expect(frame.getAttribute('data-theme')).toBe(shell.getAttribute('data-theme'));
      expect(vars(frame)).toEqual(vars(shell));
      expect(brandingClasses(pre.querySelector('.branded-surface')!)).toEqual(brandingClasses(shell));
      expect(page(pre)).toBe(page(pub));
      // The zone control is part of the page both render, the same control.
      expect(pre.querySelector('.bp-flow #tz')!.outerHTML).toBe(pub.querySelector('.bp-flow #tz')!.outerHTML);
    }
  });

  it('is inert: the host cannot click, focus or hear the picture of their page', () => {
    const pre = renderPreview(BASE as Record<string, string>, 'mobile');
    const wrapper = pre.querySelector('.bp-flow')!.closest('[inert]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the studio profile preview renders what the public profile renders', () => {
  const EVENTS = [
    { slug: 'design-review', title: 'Design review', description: 'Bring a screen.', lengthMinutes: 45 },
    { slug: 'intro', title: 'Intro call', description: null, lengthMinutes: 15 },
  ];
  const view = (doc: Document) =>
    doc.querySelector('.bp-profile')!.outerHTML.replace(/ href="[^"]*"/g, '').replace(/_R_[a-z0-9_]+_/gi, 'ID');

  for (const [axis, values] of Object.entries(AXES)) {
    for (const value of values) {
      it(`${axis}: ${value}`, () => {
        const style = { ...BASE, [axis]: value } as Record<string, string>;
        const pub = parse(
          renderToStaticMarkup(
            <BrandedShell brandColor={ACCENT} style={style}>
              <ProfileView
                m={getMessages('en')}
                name="Riley Chen"
                context="Northwind Studio"
                bio="Product design reviews."
                avatarUrl={null}
                coverUrl={null}
                events={EVENTS}
                hrefFor={(slug) => `/northwind/riley-chen/${slug}`}
                emptyText={getMessages('en').landing.noEvents}
              />
            </BrandedShell>,
          ),
        );
        const pre = parse(
          renderToStaticMarkup(
            <PreviewFrame accent={ACCENT} axes={style as never} device="mobile" wide={false}>
              <ProfilePreview
                locale="en"
                displayName="Riley Chen"
                accountName="Northwind Studio"
                bio="Product design reviews."
                avatarUrl=""
                coverUrl=""
                events={EVENTS}
              />
            </PreviewFrame>,
          ),
        );
        const shell = pub.querySelector('.branded-surface')!;
        const frame = pre.querySelector('[data-theme]')!;
        expect(frame.getAttribute('data-theme')).toBe(shell.getAttribute('data-theme'));
        expect(vars(frame)).toEqual(vars(shell));
        expect(brandingClasses(pre.querySelector('.branded-surface')!)).toEqual(brandingClasses(shell));
        expect(view(pre)).toBe(view(pub));
      });
    }
  }
});

/**
 * The brand kit screen previews a page wearing the kit through the same
 * `PreviewFrame`, and a team page wears the kit through `teamBranding`. For
 * every kit, including a logo, the two must be the same page.
 */
describe('the brand kit preview renders what a page wearing the kit renders', () => {
  const LOGO = 'https://cdn.example.test/northwind.svg';
  const KITS = {
    empty: {},
    'accent only': { accent: '#2f6fed' },
    'full, light': { accent: '#2f6fed', theme: 'light', font: 'serif', corners: 'round', buttons: 'pill', cardStyle: 'filled', logoUrl: LOGO },
    'full, dark': { accent: '#ff6fae', theme: 'dark', font: 'rounded', corners: 'sharp', buttons: 'square', cardStyle: 'elevated', logoUrl: LOGO },
  } as const;

  for (const [name, kit] of Object.entries(KITS)) {
    it(name, () => {
      const b = teamBranding(kit as never);
      const logoUrl = (b.style?.logoUrl as string | undefined) ?? null;
      const pub = parse(
        renderToStaticMarkup(
          <BrandedShell brandColor={b.brandColor} style={b.style}>
            <main>
              <BookingFlow {...previewFlowProps({ ...SAMPLE, logoUrl })} />
            </main>
          </BrandedShell>,
        ),
      );
      const shell = pub.querySelector('.branded-surface')!;
      for (const device of ['mobile', 'desktop'] as const) {
        const pre = parse(
          renderToStaticMarkup(
            <PreviewFrame accent={b.brandColor ?? DEFAULT_ACCENT} axes={(b.style ?? {}) as never} device={device} wide>
              <BookingPreview {...SAMPLE} device={device} logoUrl={logoUrl} />
            </PreviewFrame>,
          ),
        );
        const frame = pre.querySelector('[data-theme]')!;
        expect(frame.getAttribute('data-theme')).toBe(shell.getAttribute('data-theme'));
        expect(vars(frame)).toEqual(vars(shell));
        expect(brandingClasses(pre.querySelector('.branded-surface')!)).toEqual(brandingClasses(shell));
        expect(page(pre)).toBe(page(pub));
        expect(!!pre.querySelector('.bp-event .bp-logo')).toBe(!!logoUrl);
      }
    });
  }

  it('draws nothing new for a page without a logo, and the logo when there is one', () => {
    const plain = renderToStaticMarkup(<BookingFlow {...previewFlowProps(SAMPLE)} />);
    const nulled = renderToStaticMarkup(<BookingFlow {...previewFlowProps({ ...SAMPLE, logoUrl: null })} />);
    expect(nulled).toBe(plain);
    expect(plain).not.toContain('bp-logo');
    const withLogo = renderToStaticMarkup(<BookingFlow {...previewFlowProps({ ...SAMPLE, logoUrl: LOGO })} />);
    expect(withLogo).toContain(`src="${LOGO}"`);

    const m = getMessages('en');
    const profile = (logoUrl: string | null) =>
      renderToStaticMarkup(
        <ProfileView m={m} name="Riley Chen" events={[]} hrefFor={() => '#'} emptyText="-" logoUrl={logoUrl} />,
      );
    expect(profile(null)).toBe(
      renderToStaticMarkup(<ProfileView m={m} name="Riley Chen" events={[]} hrefFor={() => '#'} emptyText="-" />),
    );
    expect(profile(LOGO)).toContain('bp-cover-wrap');
  });
});
