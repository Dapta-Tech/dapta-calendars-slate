import { describe, expect, it, vi } from 'vitest';
import { followRedirect, redirectSite, redirectTarget } from '@/lib/success-redirect';

/** A window as `followRedirect` sees it: its own location, its parent, its top. */
function fakeWindow(framed: boolean, topRefuses = false) {
  const assign = vi.fn();
  const topLocation = { href: '' };
  const top = {
    get location() {
      if (topRefuses) throw new DOMException('Blocked a frame from navigating the top window.', 'SecurityError');
      return topLocation;
    },
  };
  const win = { location: { assign }, top, parent: top } as unknown as Window;
  if (!framed) Object.assign(win, { top: win, parent: win });
  return { win, assign, topLocation };
}

describe('redirectTarget', () => {
  it('follows only an https address, trimmed', () => {
    expect(redirectTarget(' https://example.com/thanks ')).toBe('https://example.com/thanks');
    expect(redirectTarget('http://example.com/thanks')).toBeNull();
    expect(redirectTarget('javascript:alert(1)')).toBeNull();
    expect(redirectTarget('')).toBeNull();
    expect(redirectTarget(null)).toBeNull();
    expect(redirectTarget(undefined)).toBeNull();
  });
});

describe('redirectSite', () => {
  it('names the destination by its host, without www', () => {
    expect(redirectSite('https://www.example.com/thanks?x=1')).toBe('example.com');
    expect(redirectSite('https://book.example.co/a')).toBe('book.example.co');
  });
});

describe('followRedirect', () => {
  it('moves this window when the page is not framed', () => {
    const { win, assign } = fakeWindow(false);
    followRedirect('https://example.com/thanks', win);
    expect(assign).toHaveBeenCalledWith('https://example.com/thanks');
  });

  it('moves the TOP window from inside an embed, never the frame', () => {
    const { win, assign, topLocation } = fakeWindow(true);
    followRedirect('https://example.com/thanks', win);
    expect(topLocation.href).toBe('https://example.com/thanks');
    expect(assign).not.toHaveBeenCalled();
  });

  it('stays put, without throwing, when the browser refuses to move the top window', () => {
    const { win, assign } = fakeWindow(true, true);
    expect(() => followRedirect('https://example.com/thanks', win)).not.toThrow();
    expect(assign).not.toHaveBeenCalled();
  });
});
