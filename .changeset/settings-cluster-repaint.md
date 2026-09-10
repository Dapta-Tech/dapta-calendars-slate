---
'@slate/shared': minor
---

Retire the arrow glyphs from the admin copy the settings cluster, availability,
teams, connections and login read, and add the strings the controls that replace
them need. `viewPublicTeam`, `tryHandle`, `configureEventTypes`,
`inviteFromMembers`, `backToTeams` and `backToTeamsList` lose the `→`/`←` they
carried in both locales; the HubSpot connect instructions describe the provider's
own navigation in prose rather than with arrows; and `home.copied` and the
studio's `available`/`taken` drop the `✓`/`✗` now that those states render a real
icon. New keys cover eight destructive confirmations that either faked a dialog
with two inline buttons or asked nothing at all, plus the labels the new icon
controls need (`common.opensNewTab`, `availability.removeOverride`,
`developer.creating`/`loading`, `connections.addingConnection`).

The token sheet's contrast law now also covers TRANSLUCENT grounds. Every
assertion before this measured a solid token on a solid ground, while the admin
is built out of `bg-primary/10` under `text-primary`, `bg-destructive/10` under
`text-destructive`, `bg-muted/30…/60` under both text voices, and
`bg-background/60` inside a card — none of which had ever been measured. It is
arithmetic over the sheet that ships, using the compositing the spec already had,
and it pins one number the screens depend on: a translucent accent LINE reads
1.6:1 on paper at every alpha the admin uses, which is why every state-bearing
border in those screens is now the solid edge token.
