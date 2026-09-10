/*!
 * Dapta Calendars — inline embed host script.
 *
 * Drop this beside a declarative iframe and every embedded booking page on the
 * page sizes itself to its own content:
 *
 *   <iframe data-dapta-calendars src="https://HOST/acme/alex/intro-call?embed=1"
 *           title="Book a meeting" loading="lazy"
 *           style="width:100%;border:0;min-height:700px;"></iframe>
 *   <script src="https://HOST/embed.js" async></script>
 *
 * The iframe is declarative on purpose. With this script blocked, or with
 * JavaScript off entirely, the iframe still renders and still takes bookings —
 * it just keeps the `min-height` it was given instead of resizing. A widget
 * that a script has to hydrate renders nothing at all in that case.
 *
 * Hand-written ES5, served static, no build step and NO global: the popup
 * variant is what needs a `window.*` namespace, and reserving an empty one now
 * buys nothing while still having to be documented.
 */
(function () {
  'use strict';

  var MESSAGE_TYPE = 'dapta-calendars:resize';
  var SELECTOR = 'iframe[data-dapta-calendars]';
  /* A frame taller than this is a runaway measurement, not a booking page. */
  var MAX_HEIGHT = 20000;

  if (typeof window === 'undefined' || !window.addEventListener) return;

  window.addEventListener(
    'message',
    function (event) {
      var data = event.data;
      /* Every page on the internet may post here. Read nothing until the
         payload is the exact shape this script published. */
      if (!data || typeof data !== 'object') return;
      if (data.type !== MESSAGE_TYPE) return;

      var height = Number(data.height);
      if (!isFinite(height) || height <= 0) return;
      if (height > MAX_HEIGHT) height = MAX_HEIGHT;

      /* Identity, not a heuristic: only the document inside a given frame can
         be `event.source` for that frame. Matching this way rather than by URL
         is what lets N embeds of DIFFERENT event types share one host page and
         each size itself — and it keeps working when the framed document has
         been redirected to another origin than the one `src` names, which the
         canonical-host 308 does to links shared before the rename. */
      var frames = document.querySelectorAll(SELECTOR);
      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i];
        if (frame.contentWindow === event.source) {
          frame.style.height = height + 'px';
          return;
        }
      }
    },
    false,
  );
})();
