import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// `lib/product-name.ts` reads the env once at module load, so every case
// re-imports the brand module after stubbing the name.
async function renderMark(productName: string | undefined) {
  vi.resetModules();
  if (productName === undefined) vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', '');
  else vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', productName);
  const { BrandMark } = await import('./brand');
  return renderToStaticMarkup(<BrandMark className="h-6 w-auto" labelled />);
}

afterEach(() => vi.unstubAllEnvs());

describe('BrandMark', () => {
  it('renders the dC artwork on a Dapta build', async () => {
    for (const name of ['Dapta Calendars', 'dCalendars']) {
      const html = await renderMark(name);
      expect(html).toContain('<svg');
      expect(html).toContain('viewBox="0 0 1141.464 715.8"');
      expect(html).toContain('fill="#3ddc84"');
      expect(html).toContain('fill="currentColor"');
      expect(html).toContain(`<title>${name}</title>`);
      expect(html).not.toContain('bg-primary');
    }
  });

  it('falls back to a letter chip on a fork', async () => {
    const html = await renderMark('Acme Booking');
    expect(html).not.toContain('<svg');
    expect(html).toContain('bg-primary');
    expect(html).toContain('>A<');
  });

  it('never carries Dapta artwork on the default name', async () => {
    const html = await renderMark(undefined);
    expect(html).not.toContain('<svg');
    expect(html).toContain('>C<');
  });

  it('gives each instance its own mask id so two marks can coexist', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', 'Dapta Calendars');
    const { CalendarsMark } = await import('./calendars-logo');
    const html = renderToStaticMarkup(
      <>
        <CalendarsMark />
        <CalendarsMark />
      </>,
    );
    const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(html).toContain(`mask="url(#${id})"`);
  });
});
