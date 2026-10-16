import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => locale.current }));

import BookingNotFound from './not-found';

/** A uid this workspace does not have: said inside the dashboard, in the host's language. */
describe("the booking page's not-found", () => {
  it('names what is missing and offers the way back to the list', async () => {
    locale.current = 'en';
    const html = renderToStaticMarkup((await BookingNotFound()) as ReactElement);
    expect(html).toContain('Booking not found');
    expect(html).toContain('There is no booking at this link in this workspace.');
    expect(html).toMatch(/href="\/admin\/bookings"[^>]*>.*Bookings/);
  });

  it('speaks Spanish to a Spanish host', async () => {
    locale.current = 'es';
    const html = renderToStaticMarkup((await BookingNotFound()) as ReactElement);
    expect(html).toContain('Reserva no encontrada');
    expect(html).toContain('Reservas');
  });
});
