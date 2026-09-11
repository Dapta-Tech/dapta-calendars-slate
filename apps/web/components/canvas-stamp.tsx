'use client';

import { useEffect, useLayoutEffect } from 'react';
import type { BrandCanvas } from '@slate/shared';
import { isProductPath } from '@/lib/theme';

/**
 * Carries a public page's canvas up to `<html>` on a CLIENT navigation.
 *
 * The server stamps the right theme on a hard load (`resolveDocumentTheme`), so
 * this is inert then. It exists for the soft navigation, where `<html>` was
 * committed once by the root layout and nothing re-renders it. `ThemeStamp` up
 * there evicts the host's product cookie the moment a `<Link>` crosses onto a
 * public route, but it cannot supply the PAGE's answer: its effect can fire
 * while the destination is still a Suspense fallback (every public route has a
 * `loading.tsx`), with `usePathname` already changed and no second run coming.
 * Measured, not theorised: crossing from the OSS landing into a stored-dark
 * booking page left `<html>` light under a dark shell.
 *
 * This is the half that can always be right. It is rendered BY the page, so its
 * effect cannot run before that page exists — it IS the page committing — and it
 * is keyed on the canvas, so moving between two booking pages with different
 * grounds re-stamps. Every public surface renders one: the four that carry a
 * `BrandedShell` get it from inside the shell, and `/manage/{uid}` and the team
 * landing page (which render no shell) pass the resolved default themselves, so
 * "a public route declares its canvas" has no exceptions to remember.
 *
 * It deliberately does NOT clean up on unmount: the destination decides the
 * theme, and on the way out that is `ThemeStamp` answering for the new route.
 *
 * A LAYOUT effect for the same reason `ThemeStamp` uses one — it has to land
 * before the browser paints, or the crossing shows a frame of the wrong palette.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function CanvasStamp({ canvas }: { canvas: BrandCanvas }) {
  useBeforePaint(() => {
    // A booking canvas may never be written onto a PRODUCT document. Today this
    // cannot fire there — `BrandedShell` is used by public routes only, and the
    // studio's live preview hand-rolls its own frame. But the shell's whole
    // selling point is that it can render the invitee's page anywhere, so the
    // obvious next refactor is to let the studio preview use it — and without
    // this line, a host previewing a light booking page would repaint their
    // entire dark console. That is ADR 0004 broken in the other direction by a
    // one-line change, which is exactly the kind of thing a guard is for.
    if (isProductPath(window.location.pathname)) return;
    if (document.documentElement.dataset.theme !== canvas) {
      document.documentElement.dataset.theme = canvas;
    }
  }, [canvas]);

  return null;
}
