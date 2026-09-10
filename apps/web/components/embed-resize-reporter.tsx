'use client';

import { useEffect } from 'react';
import { EMBED_ROOT_CLASS } from '@/lib/embed';
import { postResize } from '@/lib/embed-messages';

/**
 * The height reporter (E). Renders nothing; its whole job is to tell the host
 * page how tall this document is, so `public/embed.js` can size the frame.
 *
 * It measures the EMBED ROOT — the `.dc-embed` element the route hangs on
 * `BrandedShell` — and deliberately not `documentElement.scrollHeight`, which
 * is the obvious choice and is wrong here in a way that only shows up in one
 * direction. The root layout gives `<body>` `min-h-dvh`, and inside an iframe
 * the viewport IS the frame: so once the frame has grown to 1400px, the
 * document's scroll height is at least 1400px whatever the content does. The
 * frame would grow with the page and then never shrink back — pick a slot, the
 * calendar folds away, and the form sits under several hundred pixels of empty
 * space the host page paid for. Measuring the content element instead is not
 * floored by the frame's own height, so the report is honest in both
 * directions.
 *
 * It can measure the content honestly at all only because embed mode unsets the
 * day column's own scroller (`.branded-surface.dc-embed .bp-daycol-scroll` in
 * globals.css). With that scroller on, the content box is the CLIPPED box —
 * correct for a real page, but inside an auto-resizing frame it would hide
 * slots behind an inner scrollbar the host never asked for.
 *
 * Mounted only when the route is in embed mode, and a no-op when the document
 * is not actually framed, so a booking page opened directly posts nothing.
 */
export function EmbedResizeReporter() {
  useEffect(() => {
    const root =
      document.querySelector<HTMLElement>(`.${EMBED_ROOT_CLASS}`) ?? document.documentElement;
    let frame = 0;
    let last = -1;

    const measure = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      // The element's own box PLUS how far down the document it starts, so a
      // margin above it is not cut off the top of the frame.
      const height = Math.ceil(rect.height + rect.top + window.scrollY);
      // Only on a real change: a ResizeObserver fires for sub-pixel noise, and
      // every post is a message the host page has to handle.
      if (height === last) return;
      last = height;
      postResize(height);
    };

    // Coalesce to one post per frame. A month change re-lays out the grid, the
    // day column and the panel; without this that is three messages for one
    // visible change.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(root);

    // The first measurement happens before webfonts and the avatar land, and
    // both change the height. `load` is the cheap catch-all for that.
    window.addEventListener('load', schedule);
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('load', schedule);
      observer.disconnect();
    };
  }, []);

  return null;
}
