/**
 * The manage page when the service is busy or the host's calendar cannot be
 * read. The page is reached from an email about a booking the visitor already
 * made, so neither may look like the booking is in trouble: a busy service is a
 * busy notice that retries (never the error boundary), and a picker whose times
 * could not be read says so, with a way to ask again, while the booking and the
 * way to cancel it stay on screen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getMessages } from '@slate/shared';

const api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getAvailability: vi.fn(),
  getManageView: vi.fn(),
  getRescheduleAvailability: vi.fn(),
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/locale', () => ({ publicLocale: async () => 'en' }));
vi.mock('@/lib/theme.server', () => ({ resolveDocumentTheme: async () => 'dark' }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
vi.mock('./actions', () => ({ cancelAction: vi.fn(), rescheduleAction: vi.fn() }));

import ManagePage from './page';
import { ApiBusyError } from '@/lib/busy';
import { NOW, booking, profile } from '../../[accountCode]/__fixtures__/public-surface';

const copy = getMessages('en').trouble;
const render = async () =>
  renderToStaticMarkup(
    await ManagePage({
      params: Promise.resolve({ uid: 'bk_pinned_0001' }),
      searchParams: Promise.resolve({ token: 'tok_pinned' }),
    }),
  );
// The page's copy goes through React's escaping; compare like with like.
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.parse(NOW) - 86_400_000));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  api.getProfile.mockResolvedValue(profile({ theme: 'light' }));
  api.getManageView.mockResolvedValue({ ok: true, booking: booking() });
});

describe('the manage page when something on our side gets in the way', () => {
  it('a busy service renders the busy notice, never the error boundary', async () => {
    api.getManageView.mockRejectedValue(new ApiBusyError(4_000));
    const out = await render();
    expect(out).toContain(html(copy.busyTitle));
    expect(out).toContain(html(copy.busyBody));
  });

  it('times that could not be read because the service was busy: the picker says so; the booking stays', async () => {
    api.getAvailability.mockRejectedValue(new ApiBusyError(4_000));
    const out = await render();
    expect(out).toContain(html(copy.manageTimesBusy));
    expect(out).toContain(`>${html(copy.tryAgain)}</button>`);
    expect(out).toContain('Design review');
    expect(out).toContain(html(getMessages('en').manage.cancel));
  });

  it('a calendar that could not be read is not "no open times"', async () => {
    api.getAvailability.mockResolvedValue({ slots: [], emptyReason: 'CALENDAR_UNAVAILABLE' });
    let out = await render();
    expect(out).toContain(html(copy.manageTimesUnavailable));
    expect(out).not.toContain(html(getMessages('en').manage.noOpenTimes));
    api.getAvailability.mockRejectedValue(new Error('API failed: 502'));
    out = await render();
    expect(out).toContain(html(copy.manageTimesUnavailable));
  });

  it('nothing free is still said as nothing free', async () => {
    api.getAvailability.mockResolvedValue({ slots: [] });
    const out = await render();
    expect(out).toContain(html(getMessages('en').manage.noOpenTimes));
    expect(out).not.toContain(html(copy.manageTimesUnavailable));
  });
});
