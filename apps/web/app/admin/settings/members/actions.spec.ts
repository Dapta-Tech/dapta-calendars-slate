import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A resend spends the same daily invitation allowance as an invite. Its 429
 * carries the API's English text, so the action maps it to a code the page
 * words in the reader's language, exactly as the invite does.
 */
const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class FakeApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
const resendInvite = vi.fn();
vi.mock('@/lib/admin-api', () => ({
  adminApi: { resendInvite: (id: string, b: unknown) => resendInvite(id, b) },
  ApiError: FakeApiError,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ unstable_rethrow: () => {} }));

import { resendInviteAction } from './actions';

describe('resendInviteAction', () => {
  beforeEach(() => {
    resendInvite.mockReset();
  });

  it("maps the daily limit to LIMIT, never the API's English message", async () => {
    resendInvite.mockImplementation(() =>
      Promise.reject(new FakeApiError(429, 'At most 50 invitations a day per workspace. Try again tomorrow.', 'INVITE_LIMIT')),
    );
    expect(await resendInviteAction('m-1', 'es')).toEqual({ ok: false, code: 'LIMIT' });
  });

  it('keeps TOO_SOON for a resend inside the minute', async () => {
    resendInvite.mockImplementation(() =>
      Promise.reject(new FakeApiError(429, 'An invitation just went out.', 'RESEND_TOO_SOON')),
    );
    expect(await resendInviteAction('m-1', 'es')).toEqual({ ok: false, code: 'TOO_SOON' });
  });
});
