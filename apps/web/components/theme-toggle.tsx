'use client';

import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, type Theme } from '@/lib/theme';

/**
 * The product theme switch — the control that makes the light half of the token
 * sheet reachable (#90). Lives in the rail footer beside "View public page" and
 * "Sign out", and matches them exactly: same 44px hit target, same muted icon
 * treatment, same press feedback.
 *
 * One click does three things and none of them is a navigation:
 *
 *  1. flips `data-theme` on `<html>` — the repaint, immediate;
 *  2. writes the cookie, so the NEXT document is server-stamped correctly and
 *     there is no flash on the next full load;
 *  3. reports the new value to the shell, so every instance's icon follows.
 *
 * CONTROLLED rather than self-stateful, for the same reason the collapse rail is:
 * the shell renders this footer TWICE — once in the desktop rail, once in the
 * mobile drawer — and only one of them is interactive at a given width. With
 * local state, toggling in one and then crossing the 768px breakpoint shows the
 * other still wearing the old icon. One owner in `AdminShell`, both instances
 * agree.
 *
 * Not a server action. `setLocaleAction` is the right shape for locale, which
 * has to re-render server-rendered copy; a theme is CSS custom properties, and
 * a round-trip to repaint is a round-trip wasted. The cookie is not `HttpOnly`
 * for the same reason — this component is what writes it.
 *
 * The label names the DESTINATION ("Switch to light theme") rather than the
 * state, because a button reading "Dark" is ambiguous about whether that is
 * where you are or where you are going.
 */
export function ThemeToggle({
  theme,
  onFlip,
  messages,
}: {
  /** The shell's theme state, seeded server-side from the cookie. */
  theme: Theme;
  onFlip: (next: Theme) => void;
  messages: { toLight: string; toDark: string };
}) {
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'light' ? messages.toLight : messages.toDark;

  const flip = () => {
    document.documentElement.dataset.theme = next;
    try {
      const secure = window.location.protocol === 'https:' ? '; secure' : '';
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${secure}`;
    } catch {
      /* A blocked cookie costs the preference on the next load, not this paint. */
    }
    onFlip(next);
  };

  return (
    <button
      type="button"
      onClick={flip}
      title={label}
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]"
    >
      <i aria-hidden className={`pi ${next === 'light' ? 'pi-sun' : 'pi-moon'}`} style={{ fontSize: 16 }} />
    </button>
  );
}
