import { afterEach, describe, expect, it, vi } from 'vitest';

// `product-name.ts` reads the env once at module load, so every case
// re-imports it after stubbing the name.
async function load(productName: string) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', productName);
  return import('./product-name');
}

afterEach(() => vi.unstubAllEnvs());

describe('CONNECTOR_NAME', () => {
  it('is dCal on a Dapta build, whatever long name the build carries', async () => {
    for (const name of ['Dapta Calendars', 'dCalendars']) {
      const m = await load(name);
      expect(m.PRODUCT_NAME).toBe(name);
      expect(m.CONNECTOR_NAME).toBe('dCal');
    }
  });

  it("is a fork's own product name, with nothing of Dapta's", async () => {
    expect((await load('Acme Booking')).CONNECTOR_NAME).toBe('Acme Booking');
    expect((await load('')).CONNECTOR_NAME).toBe('Calendars');
  });
});
