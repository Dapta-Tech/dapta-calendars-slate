---
'@slate/web': patch
'@slate/api': patch
---

Booking link previews read well in every chat. The card puts the host, the title, the length and the button on a panel inside the middle square, the part Slack and WhatsApp keep when they show the image beside the text. A link-preview robot (Slack's states no language) gets the words and the card in the host's language; `?lang=` still wins, and people and search crawlers are answered as before. The card is now `<page>/card.png?lang=…`, so its words always match the page's; the old `opengraph-image` address still answers, and a card whose language came from request headers, or an empty one, is never cached. Team pages and team events get the same card.

The dashboard now records the language it is shown in as the host's own, once (`POST /v1/me/locale-sync`), and the language switch saves an explicit choice. That column already decides the language of the host's emails, onboarding templates, member invitations, and invitee emails for bookings that recorded no language, so a host who uses the dashboard in Spanish now gets those in Spanish too.
