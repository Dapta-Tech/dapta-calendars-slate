/*!
 * dCal: inline embed host script.
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
  /* The booking page asks for the campaign this page was opened with, so a
     booking made in the frame keeps it (a frame's own URL rarely carries one). */
  var CONTEXT_REQUEST_TYPE = 'dapta-calendars:context-request';
  var CONTEXT_TYPE = 'dapta-calendars:context';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var MAX_UTM_VALUE = 128;
  var SELECTOR = 'iframe[data-dapta-calendars]';
  /* A frame taller than this is a runaway measurement, not a booking page. */
  var MAX_HEIGHT = 20000;
  /* Below this a reading is noise, not a page, and is not applied at all.
     Nothing this script sizes is a 40px document, and once the snippet's floor
     has been released there is nothing else to catch a bad number. */
  var MIN_TRUSTED_HEIGHT = 120;

  if (typeof window === 'undefined' || !window.addEventListener) return;

  /* The five utm_* keys of this page's own address, and nothing else: no
     path, no other parameter, no cookie. */
  function pageUtm() {
    var out = {};
    var found = false;
    try {
      var params = new URLSearchParams(window.location.search);
      for (var i = 0; i < UTM_KEYS.length; i++) {
        var value = params.get(UTM_KEYS[i]);
        if (value && value.length <= MAX_UTM_VALUE) {
          out[UTM_KEYS[i]] = value;
          found = true;
        }
      }
    } catch (e) {
      return null;
    }
    return found ? out : null;
  }

  /* The frame this page placed whose document posted `source`, or null. */
  function frameOf(source) {
    var frames = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === source) return frames[i];
    }
    return null;
  }

  window.addEventListener(
    'message',
    function (event) {
      var data = event.data;
      /* Every page on the internet may post here. Read nothing until the
         payload is the exact shape this script published. */
      if (!data || typeof data !== 'object') return;
      if (data.type === CONTEXT_REQUEST_TYPE) {
        /* Answered only to a frame this page placed, and only to the origin
           that asked, which is that frame's document wherever it now lives. */
        if (!frameOf(event.source) || !event.origin || event.origin === 'null') return;
        event.source.postMessage({ type: CONTEXT_TYPE, utm: pageUtm() }, event.origin);
        return;
      }
      if (data.type !== MESSAGE_TYPE) return;

      var height = Number(data.height);
      if (!isFinite(height) || height < MIN_TRUSTED_HEIGHT) return;
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
          /* The snippet's `min-height` is the PRE-JS floor: it holds the box
             open until a real measurement arrives, and after that it is only a
             way for a short page to sit under dead space it does not fill — a
             landing page with one event is about 400px against a 700px floor.
             Released here, which deliberately also discards a floor a host
             raised by hand: this script's contract is that the frame matches
             its content, and a reserved box taller than the content is the
             thing it exists to remove. Only readings at or above
             MIN_TRUSTED_HEIGHT get this far, so nothing collapses a frame. */
          frame.style.minHeight = '0px';
          return;
        }
      }
    },
    false,
  );
})();
