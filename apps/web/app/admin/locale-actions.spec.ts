/**
 * The language switch saves the host's own language as well as the cookie. The
 * save is awaited, so the switch stays disabled until it answers and two quick
 * choices land in order; a failed save is tried once more; an unreachable API
 * never stops the dashboard from changing language. There is deliberately no
 * timeout: an abandoned request could still land after a later choice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const api = vi.hoisted(() => ({ updateMyLocale: vi.fn(), syncLocale: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ adminApi: api }));

import { setLocaleAction, syncLocaleAction } from './locale-actions';

beforeEach(() => {
  jar.set.mockReset();
  api.updateMyLocale.mockReset();
  api.syncLocale.mockReset();
});

describe('setLocaleAction', () => {
  it('sets the cookie and saves the host language before it returns', async () => {
    let saved = false;
    api.updateMyLocale.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      saved = true;
      return { ok: true };
    });
    await setLocaleAction('es');
    expect(jar.set).toHaveBeenCalledWith('slate_locale', 'es', expect.objectContaining({ path: '/' }));
    expect(api.updateMyLocale).toHaveBeenCalledWith('es');
    expect(saved).toBe(true);
  });

  it('tries a failed save once more', async () => {
    api.updateMyLocale.mockRejectedValueOnce(new Error('API down')).mockResolvedValueOnce({ ok: true });
    await setLocaleAction('en');
    expect(api.updateMyLocale).toHaveBeenCalledTimes(2);
  });

  it('still changes the dashboard language when the API stays down', async () => {
    api.updateMyLocale.mockRejectedValue(new Error('API down'));
    await expect(setLocaleAction('es')).resolves.toBeUndefined();
    expect(jar.set).toHaveBeenCalledWith('slate_locale', 'es', expect.anything());
  });

  it('reads anything but Spanish as English', async () => {
    api.updateMyLocale.mockResolvedValue({ ok: true });
    await setLocaleAction('fr');
    expect(api.updateMyLocale).toHaveBeenCalledWith('en');
  });
});

describe('syncLocaleAction', () => {
  it('reports only a supported language', async () => {
    await syncLocaleAction('fr');
    expect(api.syncLocale).not.toHaveBeenCalled();
    api.syncLocale.mockResolvedValue({ ok: true });
    await syncLocaleAction('es');
    expect(api.syncLocale).toHaveBeenCalledWith('es');
  });
});
