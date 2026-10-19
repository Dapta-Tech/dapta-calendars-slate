// @vitest-environment jsdom
/**
 * The skill's download button: a 200 is saved as the zip, under the route's
 * file name; a refusal becomes a line that says what to do, keyed by the
 * route's `error` code; and while the zip is built a second press does
 * nothing and the button keeps focus.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages } from '@slate/shared';
import { REVOKE_AFTER_MS, SkillDownload, skillErrorMessage } from './skill-download';

const en = getMessages('en').admin.developer;
const es = getMessages('es').admin.developer;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const fetchMock = vi.fn();
const createObjectURL = vi.fn(() => 'blob:skill-zip');
const revokeObjectURL = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(m = en) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<SkillDownload m={m} />));
  return host;
}

const button = () => host!.querySelector<HTMLButtonElement>('[data-testid="setup-skill-download"]')!;
const alertLine = () => host!.querySelector<HTMLElement>('[role="alert"]');
const press = () => act(async () => button().click());

/** What `fetch` resolves to: just the parts the button reads. */
const answer = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  blob: async () => new Blob(['PK'], { type: 'application/zip' }),
});

describe('SkillDownload', () => {
  it('saves a 200 as the zip, under the file name the route gives it, then lets the URL go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const clicked: Array<{ href: string; download: string; attached: boolean }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });
    fetchMock.mockResolvedValue(answer(200, null));
    await mount();
    await press();

    expect(fetchMock).toHaveBeenCalledWith('/api/developers/skill', { cache: 'no-store' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([{ href: 'blob:skill-zip', download: 'dapta-calendars-skill.zip', attached: true }]);
    // The temporary link is gone, and no error line was shown.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(alertLine()).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_AFTER_MS);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:skill-zip');
    click.mockRestore();
  });

  it.each([
    ['UNAUTHENTICATED', 401, en.guideSkillErrorSession],
    ['FORBIDDEN', 403, en.guideSkillErrorForbidden],
    ['API_URL_NOT_CONFIGURED', 503, en.guideSkillUnavailable],
    ['UPSTREAM_BUSY', 503, en.guideSkillErrorGeneric],
    ['OPENAPI_UNAVAILABLE', 502, en.guideSkillErrorGeneric],
  ])('says what to do on %s, in an alert, and saves nothing', async (code, status, line) => {
    fetchMock.mockResolvedValue(answer(status, { error: code, message: 'ignored' }));
    await mount();
    await press();
    expect(alertLine()!.textContent).toBe(line);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('says to try again when the request itself fails, or the answer is not JSON', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await mount();
    await press();
    expect(alertLine()!.textContent).toBe(en.guideSkillErrorGeneric);

    fetchMock.mockResolvedValueOnce({ ...answer(500, null), json: async () => Promise.reject(new SyntaxError('html')) });
    await press();
    expect(alertLine()!.textContent).toBe(en.guideSkillErrorGeneric);
  });

  it('clears the error line on the next try, and speaks the reader’s language', async () => {
    fetchMock.mockResolvedValueOnce(answer(403, { error: 'FORBIDDEN' }));
    await mount(es);
    await press();
    expect(alertLine()!.textContent).toBe('Solo los propietarios y administradores pueden descargar el skill.');
    fetchMock.mockResolvedValueOnce(answer(200, null));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await press();
    expect(alertLine()).toBeNull();
    click.mockRestore();
  });

  it('ignores a second press while the zip is built, and keeps focus on the button', async () => {
    let finish: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mount();
    button().focus();
    await press();
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().textContent).toBe(en.guideSkillPending);
    expect(button().hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(button());

    await press();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => finish(answer(403, { error: 'FORBIDDEN' })));
    expect(button().hasAttribute('aria-disabled')).toBe(false);
    expect(button().textContent).toBe(en.guideSkillButton);
  });

  it('is a native button at the 44px control height, so the keyboard reaches and presses it as any button', async () => {
    await mount();
    expect(button().tagName).toBe('BUTTON');
    expect(button().getAttribute('type')).toBe('button');
    expect(button().className).toContain('h-11');
    expect(button().querySelector('i.pi-download')!.hasAttribute('aria-hidden')).toBe(true);
  });

  it('falls back to the generic line for a code it does not know, or none', () => {
    expect(skillErrorMessage(en, undefined)).toBe(en.guideSkillErrorGeneric);
    expect(skillErrorMessage(en, 'SOMETHING_NEW')).toBe(en.guideSkillErrorGeneric);
  });
});
