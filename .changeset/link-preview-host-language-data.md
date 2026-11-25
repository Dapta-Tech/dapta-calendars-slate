---
'@slate/db': patch
'@slate/types': patch
---

The public profile and team payloads carry the host's language (`member.locale`, `team.locale`), optional on the wire. A team speaks its earliest active owner's language, else the workspace owner's. Link previews fall back to it when the robot drawing them states no language. `card.png` and `opengraph-image` are reserved event link names.
