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
  return { ApiError, oauthConsent: vi.fn(), oauthConsentWithoutRequest: vi.fn() };
});
vi.mock('@/lib/admin-api', () => ({
  adminApi: { oauthConsent: api.oauthConsent, oauthConsentWithoutRequest: api.oauthConsentWithoutRequest },
  ApiError: api.ApiError,
}));
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
const page = (uid?: string) => ConsentPage({ searchParams: Promise.resolve(uid === undefined ? {} : { uid }) });
const external = () => new api.ApiError(404, 'Sign-in happens at the external authorization server.', 'EXTERNAL_AUTHORIZATION_SERVER');
const notFoundBody = () => new api.ApiError(404, 'Not found.', 'NOT_FOUND');

describe('/auth/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a 404 while an external authorization server signs people in', async () => {
    api.oauthConsent.mockRejectedValue(external());
    await expect(page('abc')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('is a 404 there with no request id, or a malformed one, too', async () => {
    api.oauthConsentWithoutRequest.mockRejectedValue(external());
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(page('not a uid!')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(api.oauthConsent).not.toHaveBeenCalled();
  });

  it('keeps the expired card for an unknown or used request of the built-in server', async () => {
    api.oauthConsent.mockRejectedValue(new api.ApiError(404, 'This request is no longer valid.', 'NOT_FOUND'));
    const html = renderToStaticMarkup((await page('abc')) as ReactElement);
    expect(html).toContain(m.expiredTitle);
  });

  it('keeps the expired card for a missing request id with the built-in server or OAuth off', async () => {
    api.oauthConsentWithoutRequest.mockRejectedValue(notFoundBody());
    expect(renderToStaticMarkup((await page()) as ReactElement)).toContain(m.expiredTitle);
  });
});
