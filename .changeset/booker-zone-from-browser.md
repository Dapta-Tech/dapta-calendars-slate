---
'@slate/web': patch
---

The booking page opens in the visitor's own time zone, read from the browser, instead of the host's. A visitor in Miami booking a host in Bogota used to see Bogota times and had to find the zone picker before choosing one; the page listed "Your time zone" there but never applied it. Now the times, the details step, the confirmation and the booking's stored zone (which drives the invitee's emails and the manage page) are in the visitor's zone from the first look. Same on personal and team pages, one-off links and the embed.

The server cannot know the browser's zone, so the page still renders the host's zone and the first effect after hydration swaps in the browser's. A browser that hides its zone (it reports UTC under any of its names) or reports one the runtime cannot use keeps the host's, so the control is never blank. A zone the visitor already picked is never overwritten, and the picker still changes it. The "{zone}, the host's time" line beside the event is unchanged, and the host's brand preview keeps its fixed sample.

The server's first availability read now runs up to 26 hours past the end of the host's month (within the booking horizon), so a visitor west of the host gets their whole visible month in that one read instead of a second round trip.
