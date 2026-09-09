import { NextResponse, type NextRequest } from 'next/server';
import { getMessages } from '@slate/shared';
import {
  accessTokenExpired,
  getSession,
  refreshUpstreamSession,
  setSession,
} from '@/lib/auth-session';
import { getLocale } from '@/lib/locale';
import { requestOrigin } from '@/lib/request-origin';

/**
 * Session refresh for the one context that cannot write cookies itself: a 401
 * during a Server Component render (`admin-api.ts`, where `cookies().set()`
 * throws). The render redirects here; this handler trades the refresh token for
 * a fresh access token, stores it, and sends the person back to /admin.
 *
 * There are two ways for that not to happen, and they end differently (#114):
 *
 *  - the refresh token is expired or revoked → hand off to the logout route,
 *    exactly where a render-time 401 went before refresh existed;
 *  - the identity service could not be reached → answer `503` and change
 *    NOTHING. The cookie stays, the upstream session stays, and the person gets
 *    a page that says to try again. Signing out here would end a session that
 *    had nothing wrong with it because a deploy happened to land on a token
 *    expiry, which is the whole reason this branch exists.
 *
 * No `next` parameter, on purpose: a redirect target taken from the query is an
 * open-redirect surface on the auth path, and /admin is where the pre-refresh
 * flow already landed. Server actions never come through here — they refresh
 * inline, so the URL bar stays where the person left it.
 *
 * A note on the shape: this is a state-mutating GET with no CSRF token, so a
 * forced top-level navigation can trigger it (the session cookie is
 * `sameSite: 'lax'`). The outcomes are a rotation the victim's own browser
 * receives, a sign-out, or a page that changes nothing — and
 * `/api/auth/logout` has always been reachable the same way and always signs
 * out, so this adds no new class of mischief.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const signOut = NextResponse.redirect(new URL('/api/auth/logout?reason=expired', origin));
  const session = await getSession();

  // ONE refresh per expiry, never a loop — the ceiling `hostFetch` gets from
  // counting attempts, this route has to get from the token itself, because it
  // is driven by browser redirects and remembers nothing between arrivals.
  //
  // The API answers 401 for more than an expired token: a claim it cannot
  // resolve, a secret that does not match. Minting another token fixes none of
  // those and the identity service will happily mint one every time, so without
  // this guard the second arrival looks exactly like the first and /admin → here
  // → /admin runs until the browser gives up, spending a refresh-token rotation
  // per lap. A token still inside its lifetime therefore means the 401 was not
  // an expiry, and signing out is the honest answer.
  if (session?.provider === 'workos' && !accessTokenExpired(session.accessToken)) {
    return signOut;
  }

  const refreshed = await refreshUpstreamSession(session);
  // Nothing was learned about the credential, so nothing may be spent on it.
  // A terminal page rather than a redirect anywhere: /admin would 401 and come
  // straight back here, and /login under the workos provider auto-redirects
  // into the very identity service that has just failed to answer.
  if (refreshed.outcome === 'unavailable') return unavailable();
  if (refreshed.outcome === 'expired') return signOut;
  // The SAME predicate as the guard above, and that is what makes termination
  // structural rather than a matter of the identity service's configuration:
  // "we stored it" and "the next arrival will sign out instead of refreshing"
  // become one question. A looser check here would admit a token with less life
  // left than the arrival guard requires — the render would 401, come back, and
  // this route would refresh again, one rotation per lap, forever.
  if (accessTokenExpired(refreshed.session.accessToken)) return signOut;

  await setSession(refreshed.session);
  return NextResponse.redirect(new URL('/admin', origin));
}

const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The retryable landing: a `503` carrying the i18n copy (EN + ES), a link back
 * to /admin, and a way out.
 *
 * The retry is the person's own deliberate act rather than a redirect that
 * would bounce straight off the same unreachable service — there is no
 * meta-refresh and no script here, on purpose, because an automatic retry is
 * how a page like this becomes a lap against a service that is already
 * struggling.
 *
 * The sign-out link is the escape hatch, and it exists because `unavailable` is
 * not always transient: a non-401/403 4xx means a contract drift that waiting
 * will never fix, and without a second affordance the only way off this page
 * would be to know that /api/auth/logout can be typed by hand. It costs the
 * session only when a person deliberately clicks it, so the contract that only
 * an `expired` verdict signs anybody out is intact.
 *
 * The markup is self-contained because a route handler renders no React tree
 * and the app's stylesheet is not in scope here. The palette is a deliberate
 * standalone copy rather than a read of `@slate/shared`'s tokens.css, which is
 * a stylesheet this response cannot link; it will not follow a reskin.
 */
async function unavailable(): Promise<NextResponse> {
  const locale = await getLocale();
  const m = getMessages(locale).admin.session;
  const html = [
    '<!doctype html>',
    `<html lang="${escapeHtml(locale)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(m.unavailableTitle)}</title>`,
    '<style>',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#18181b;',
    'font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
    'main{max-width:28rem;padding:2rem;text-align:center}',
    'h1{margin:0 0 .5rem;font-size:1.5rem}',
    'p{margin:0 0 1.5rem;color:#52525b}',
    'nav{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:center;align-items:center}',
    'a{display:inline-block;padding:.625rem 1.25rem;border-radius:.375rem;background:#18181b;',
    'color:#fafafa;font-weight:600;text-decoration:none}',
    'a.secondary{background:none;color:#52525b;font-weight:400;text-decoration:underline}',
    '@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}',
    'p{color:#a1a1aa}a{background:#fafafa;color:#18181b}',
    'a.secondary{background:none;color:#a1a1aa}}',
    '</style>',
    '</head>',
    '<body><main>',
    `<h1>${escapeHtml(m.unavailableTitle)}</h1>`,
    `<p>${escapeHtml(m.unavailableBody)}</p>`,
    '<nav>',
    `<a href="/admin">${escapeHtml(m.retry)}</a>`,
    `<a class="secondary" href="/api/auth/logout">${escapeHtml(m.signOut)}</a>`,
    '</nav>',
    '</main></body></html>',
  ].join('');
  return new NextResponse(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '5',
    },
  });
}
