/**
 * The consent page belongs to this API's own OAuth server. With an external
 * authorization server the API answers its consent read with a 404 of its own
 * code, and the page is a 404 too; a stale request of the built-in server
 * keeps its "this request expired" card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { getMessages } from '@slate/shared';

const api = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  return { ApiError, oauthConsent: vi.fn() };
});
vi.mock('@/lib/admin-api', () => ({ adminApi: { oauthConsent: api.oauthConsent }, ApiError: api.ApiError }));
vi.mock('@/lib/locale', () => ({ getLocale: async () => 'en' }));
vi.mock('@/components/brand/brand', () => ({ BrandMark: () => null }));
vi.mock('./consent-actions', () => ({ ConsentActions: () => null }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import ConsentPage from './page';

const m = getMessages('en').admin.oauthConsent;
const page = (uid: string) => ConsentPage({ searchParams: Promise.resolve({ uid }) });

describe('/auth/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a 404 while an external authorization server signs people in', async () => {
    api.oauthConsent.mockRejectedValue(new api.ApiError(404, 'Sign-in happens at the external authorization server.', 'EXTERNAL_AUTHORIZATION_SERVER'));
    await expect(page('abc')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('keeps the expired card for an unknown or used request of the built-in server', async () => {
    api.oauthConsent.mockRejectedValue(new api.ApiError(404, 'This request is no longer valid.', 'NOT_FOUND'));
    const html = renderToStaticMarkup((await page('abc')) as ReactElement);
    expect(html).toContain(m.expiredTitle);
  });
});
