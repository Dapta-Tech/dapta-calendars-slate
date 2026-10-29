---
"@slate/web": patch
---

The dashboard's sign-in cookies can no longer be planted by a sibling host on the same site, ahead of booking pages moving to a host of their own (`book.<domain>`, which will run hosts' own tags). In production the session, the OAuth state and the return-to cookies are written as `__Host-` cookies, always with `Secure`, `Path=/` and no `Domain`: a browser takes one only from this exact host, so a `Domain=<site>` cookie tossed from another subdomain can never stand in for it.

- The session keeps reading its old, plain name only while no other host of the deployment serves booking pages, so nobody is signed out by this release and a session moves over on its next write. Once `PUBLIC_BOOKING_URL` names an origin of its own, the plain name is never read again (a plain cookie could then have been planted from there); a session that has not moved over by then signs in once more.
- The login's two short-lived cookies never take the old name: a login in flight across the release starts again.
- A removal clears both names with the attributes a `__Host-` cookie needs.
- dCal's own dashboard analytics keeps its PostHog identity in local storage on this origin (no longer a cookie shared with every subdomain), and expires the shared cookie earlier releases wrote. The landing and the app are joined by the landing id in the URL, as before.
- A production web needs https (or localhost), as its `Secure` cookies already did.
- The dCal landing uses the same PostHog project; each dashboard load expires its site-wide cookie too, and the landing restores its id from its own local storage on the next visit. The expiry targets the hostname minus its first label, which covers three-label hosts such as `app.<domain>`; a deeper host (`cal.team.example.com`) keeps an older shared cookie until it expires.
