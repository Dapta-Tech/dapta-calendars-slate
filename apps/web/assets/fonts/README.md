# Share-card typeface

Figtree, the brand face, vendored as TrueType so `next/og` can rasterize the
booking page's link preview (`opengraph-image.tsx` under the public routes) in
the same face the page is set in. Loaded by `apps/web/lib/og-fonts.ts`.

## Why a second copy

The app already self-hosts Figtree through `next/font/google` (`app/layout.tsx`).
That path produces a CSS `@font-face` and a hashed `.woff2`, and Satori, the
rasterizer behind `next/og`, needs the font binary in a format it parses: TTF,
OTF or WOFF, never WOFF2. So this is the same release in the one format that
works, next to the code that reads it.

## Provenance

The Google Fonts CSS API answers with `format('truetype')` for a legacy user
agent:

```bash
curl -H "User-Agent: Mozilla/4.0" \
  "https://fonts.googleapis.com/css?family=Figtree:400&subset=latin"
```

`latin` subset (Spanish included), two weights: 400 for the supporting line and
700 for the headline. A card has two voices; every extra weight is bytes read
while a social crawler waits.

A host whose page uses the `rounded` or `serif` font axis still gets Figtree on
the card: those axes are system font stacks on the page, with no file to vendor.

## License

Figtree (designer: Erik Kennedy) is released under the SIL Open Font License
1.1, which permits redistributing it inside this repository. Full text:
<https://openfontlicense.org>.
