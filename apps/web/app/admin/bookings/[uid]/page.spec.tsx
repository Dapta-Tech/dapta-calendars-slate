/**
 * The booking page the host's request email opens. It loads the ONE booking by
 * uid (so a request the list's first page leaves out still opens), offers the
 * action the list would, shows who booked and what they answered when the API
 * sends it (to the booking's host and co-hosts), shows the campaign the booking
 * came from when it has one, and is a 404 for a uid that is not this account's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const admin = vi.hoisted(() => ({ getBooking: vi.fn(), me: vi.fn() }));
vi.mock('@/lib/admin-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin-api')>('@/lib/admin-api');
  return { ApiError: actual.ApiError, adminApi: admin };
});
const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'es' }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => locale.current }));
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('../booking-actions', () => ({
  PendingActions: ({ uid }: { uid: string }) => <div data-testid="pending-actions" data-uid={uid} />,
  CancelAction: ({ uid }: { uid: string }) => <div data-testid="cancel-action" data-uid={uid} />,
}));

import { ApiError } from '@/lib/admin-api';
import BookingPage from './page';

const UID = '6f1c2a9e-1b7d-4c55-9a0e-3d2f8b7c4e10';
const DAY = 86_400_000;
type Guest = { name: string; email: string; phone: string | null; others: string[]; answers: { label: string; value: string }[] };
const GUEST: Guest = {
  name: 'Sam Visitor',
  email: 'sam@example.org',
  phone: '+57 300 000 0000',
  others: ['Ana Ruiz (ana@example.org)'],
  answers: [
    { label: 'Company', value: 'Example Co' },
    { label: 'What would you like to discuss?', value: 'Pricing\nand onboarding' },
    { label: 'Notes', value: 'Please call first' },
  ],
};
const booking = (
  over: Partial<{ status: string; startUtc: string; utm: Record<string, string> | null; guest: Guest | null }> = {},
) => ({
  uid: UID,
  status: 'pending',
  title: 'Intro Call',
  startUtc: new Date(Date.now() + DAY).toISOString(),
  endUtc: new Date(Date.now() + DAY + 1_800_000).toISOString(),
  hostMemberId: 'm1',
  ...over,
});

async function render(uid = UID): Promise<string> {
  return renderToStaticMarkup((await BookingPage({ params: Promise.resolve({ uid }) })) as ReactElement);
}

describe('the booking page the request email opens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locale.current = 'en';
    admin.me.mockResolvedValue({ timeZone: 'America/Bogota' });
  });

  it('loads that one booking by uid and offers Confirm and Decline on a request', async () => {
    admin.getBooking.mockResolvedValue(booking());

    const html = await render();

    expect(admin.getBooking).toHaveBeenCalledWith(UID, 'en');
    expect(html).toContain('Intro Call');
    expect(html).toContain(`data-testid="pending-actions" data-uid="${UID}"`);
    expect(html).not.toContain('cancel-action');
    expect(html).toContain('pending');
    // Back to the whole list, and the zone the time is in.
    expect(html).toContain('href="/admin/bookings"');
    expect(html).toContain('Times shown in America/Bogota');
  });

  it('offers Cancel on an accepted booking still ahead, and nothing on one already past', async () => {
    admin.getBooking.mockResolvedValue(booking({ status: 'accepted' }));
    const ahead = await render();
    expect(ahead).toContain('data-testid="cancel-action"');
    expect(ahead).not.toContain('pending-actions');

    admin.getBooking.mockResolvedValue(booking({ status: 'rejected' }));
    const done = await render();
    expect(done).not.toContain('cancel-action');
    expect(done).not.toContain('pending-actions');
    expect(done).toContain('rejected');
  });

  it("is a 404 for a uid the API does not find in this account (another tenant's reads the same)", async () => {
    admin.getBooking.mockRejectedValue(new ApiError(404, 'Booking not found.', 'NOT_FOUND'));

    await expect(render('someone-elses')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('shows the campaign the booking came from, each utm_* under its own key, in link order', async () => {
    admin.getBooking.mockResolvedValue(
      booking({ status: 'accepted', utm: { utm_campaign: 'q4 launch', utm_source: 'newsletter', utm_content: '<b>ad-1</b>' } }),
    );

    const html = await render();

    expect(html).toContain('data-testid="booking-campaign"');
    expect(html).toContain('Campaign');
    expect(html).toContain('From the UTM parameters on the link the invitee booked from.');
    // Keys as the host put them on the link, in BOOKING_UTM_KEYS order.
    const order = ['utm_source', 'utm_campaign', 'utm_content'].map((k) => html.indexOf(`>${k}</dt>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<dd class="min-w-0 break-words font-medium">newsletter</dd>');
    expect(html).toContain('q4 launch');
    expect(html).not.toContain('utm_medium');
    // A value came on a public link: rendered as text, never as markup.
    expect(html).toContain('&lt;b&gt;ad-1&lt;/b&gt;');
    expect(html).not.toContain('<b>ad-1</b>');
  });

  it('shows no campaign block on a booking without one, or from an API that does not send it', async () => {
    admin.getBooking.mockResolvedValue(booking({ utm: null }));
    expect(await render()).not.toContain('booking-campaign');

    admin.getBooking.mockResolvedValue(booking());
    const older = await render();
    expect(older).not.toContain('booking-campaign');
    expect(older).not.toContain('Campaign');
  });

  it('says it in Spanish too', async () => {
    locale.current = 'es';
    admin.getBooking.mockResolvedValue(booking({ utm: { utm_source: 'google' } }));

    const html = await render();

    expect(html).toContain('Campaña');
    expect(html).toContain('De los parámetros UTM del enlace desde el que reservó el invitado.');
    expect(html).toContain('>utm_source</dt>');
  });

  it('shows who booked and what they answered, as the host email lists them', async () => {
    admin.getBooking.mockResolvedValue(booking({ guest: GUEST }));

    const html = await render();

    expect(html).toContain('data-testid="booking-guest"');
    expect(html).toContain('Guest details');
    expect(html).toContain('Their answers');
    const order = ['Sam Visitor', 'sam@example.org', '+57 300 000 0000', 'Ana Ruiz (ana@example.org)', 'Example Co', 'Please call first'].map(
      (v) => html.indexOf(v),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('>What would you like to discuss?</dt>');
    // A multi-line answer keeps its lines.
    expect(html).toContain('whitespace-pre-line');
    expect(html).toContain('Pricing\nand onboarding');
    // Before the campaign, when there is one.
    admin.getBooking.mockResolvedValue(booking({ guest: GUEST, utm: { utm_source: 'google' } }));
    const both = await render();
    expect(both.indexOf('booking-guest')).toBeLessThan(both.indexOf('booking-campaign'));
  });

  it('leaves out what the guest did not give, and the answers block when there are none', async () => {
    admin.getBooking.mockResolvedValue(booking({ guest: { ...GUEST, phone: null, others: [], answers: [] } }));

    const html = await render();

    expect(html).toContain('Sam Visitor');
    expect(html).not.toContain('Phone');
    expect(html).not.toContain('Other guests');
    expect(html).not.toContain('Their answers');
  });

  it("shows no guest block when the API sends none (not the booking's host, or an older API)", async () => {
    admin.getBooking.mockResolvedValue(booking({ guest: null }));
    expect(await render()).not.toContain('booking-guest');

    admin.getBooking.mockResolvedValue(booking());
    const older = await render();
    expect(older).not.toContain('booking-guest');
    expect(older).not.toContain('Guest details');
  });

  it('renders what a visitor typed as text, never as markup or a link', async () => {
    admin.getBooking.mockResolvedValue(
      booking({ guest: { ...GUEST, name: '<img src=x onerror=alert(1)>', answers: [{ label: 'Company', value: '<a href="http://evil.test">x</a>' }] } }),
    );

    const html = await render();

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="http://evil.test"');
    expect(html).not.toContain('mailto:');
  });

  it('asks the API in Spanish and says it in Spanish too', async () => {
    locale.current = 'es';
    admin.getBooking.mockResolvedValue(booking({ guest: { ...GUEST, answers: [{ label: 'Notas', value: 'Llamar antes' }] } }));

    const html = await render();

    expect(admin.getBooking).toHaveBeenCalledWith(UID, 'es');
    for (const word of ['Datos del invitado', 'Nombre', 'Correo', 'Teléfono', 'Otros invitados', 'Sus respuestas', 'Notas']) {
      expect(html).toContain(word);
    }
  });

  it('lets any other failure reach the error boundary rather than calling it missing', async () => {
    admin.getBooking.mockRejectedValue(new ApiError(503, 'down'));

    await expect(render()).rejects.toMatchObject({ status: 503 });
    expect(notFound).not.toHaveBeenCalled();
  });
});
