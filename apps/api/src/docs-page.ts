/**
 * The API reference page (`GET /docs`): the Scalar explorer, full page, and
 * nothing else. The introduction lives in the OpenAPI document itself
 * (`info.description`, see openapi.ts), so the page, the raw document and the
 * agent skill that ships it all read the same words.
 *
 * Both files come from a CDN pinned to an exact version with Subresource
 * Integrity: a changed byte refuses to load instead of running. To move to a new
 * Scalar release, change the version and recompute the hash from the file the
 * URL serves:
 *   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
 */

export const SCALAR_VERSION = '1.74.0';
export const SCALAR_SCRIPT = {
  src: `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`,
  integrity: 'sha384-VXnKAz61Xwc3tbw1P+KKrUP7YbcsSl1Ik4is5UnogJyw9XEYZ5Ay/T1i0zPYtSZH',
} as const;
/** Figtree, the face the web app uses (OFL), so the reference reads as the same product. */
export const FONT_STYLESHEET = {
  href: 'https://cdn.jsdelivr.net/npm/@fontsource-variable/figtree@5.3.0/index.css',
  integrity: 'sha384-Ydc7gpdqF/uWGh2pkKuzoIIBy0BIo1071oSRiAgAdHrf1JuvRQAVS1iqov5WEtNh',
} as const;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

/**
 * The web app's palette (packages/shared/src/tokens.css) mapped onto Scalar's
 * variables: dark is the default ground, light follows the reader's system,
 * Signal Green is the one accent. Scalar keeps its own variables in cascade
 * layers, so these unlayered rules win; `body .dark-mode` also reaches the code
 * samples Scalar always draws dark.
 */
const THEME_CSS = `
body{margin:0;background:#1a1a1c}
@media (prefers-color-scheme: light){body{background:#fff}}
body.light-mode,body.dark-mode,body .light-mode,body .dark-mode{
--scalar-font:'Figtree Variable',Figtree,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
--scalar-font-code:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;
--scalar-radius:6px;--scalar-radius-lg:8px;--scalar-radius-xl:12px;
--scalar-text-decoration:underline}
body.dark-mode,body .dark-mode{
--scalar-background-1:#1a1a1c;--scalar-background-2:#222225;--scalar-background-3:#2a2a2f;
--scalar-background-accent:rgba(61,220,132,.12);
--scalar-color-1:#fefefe;--scalar-color-2:#a9a9b1;--scalar-color-3:#909099;--scalar-color-accent:#5fe39b;
--scalar-border-color:rgba(255,255,255,.1);
--scalar-button-1:#fefefe;--scalar-button-1-color:#1a1a1c;--scalar-button-1-hover:rgba(254,254,254,.88);
--scalar-sidebar-background-1:#161618;--scalar-sidebar-item-active-background:#2a2a2f;
--scalar-sidebar-color-active:#fefefe;--scalar-sidebar-search-background:#222225}
body.light-mode,body .light-mode{
--scalar-background-1:#fff;--scalar-background-2:#fafafa;--scalar-background-3:#f2f2f3;
--scalar-background-accent:rgba(61,220,132,.14);
--scalar-color-1:#1a1a1c;--scalar-color-2:#45454c;--scalar-color-3:#67676f;--scalar-color-accent:#0e7a3f;
--scalar-border-color:#e6e6e8;
--scalar-button-1:#1a1a1c;--scalar-button-1-color:#fff;--scalar-button-1-hover:rgba(26,26,28,.88);
--scalar-sidebar-background-1:#fafafa;--scalar-sidebar-item-active-background:#f2f2f3;
--scalar-sidebar-color-active:#1a1a1c;--scalar-sidebar-search-background:#fff}
`.trim();

export type DocsPageInput = {
  /** `<product> API`, unescaped. */
  title: string;
  /** Where the explorer fetches the document: same origin as the page, path prefix kept. */
  explorerUrl: string;
  /** The raw document, for readers without JavaScript. */
  openapiUrl: string;
  /** The web app's icon, when the dashboard's address is known. */
  iconUrl?: string;
};

export function renderDocsPage({ title, explorerUrl, openapiUrl, iconUrl }: DocsPageInput): string {
  // Scalar reads this JSON from the attribute; the browser decodes the entities.
  const configuration = escapeHtml(
    JSON.stringify({
      url: explorerUrl,
      theme: 'none',
      withDefaultFonts: false,
      // Nothing on this page reports to, or chats through, Scalar's services.
      telemetry: false,
      agent: { disabled: true },
      mcp: { disabled: true },
      showDeveloperTools: 'never',
    }),
  );
  const icon = iconUrl ? `\n<link rel="icon" type="image/svg+xml" href="${escapeHtml(iconUrl)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)}</title>${icon}
<link rel="stylesheet" href="${FONT_STYLESHEET.href}" integrity="${FONT_STYLESHEET.integrity}" crossorigin="anonymous">
<style>${THEME_CSS}</style>
</head><body>
<noscript><p style="font:16px/1.5 system-ui,sans-serif;padding:24px">JavaScript is required for the interactive
reference. Use <a href="${escapeHtml(openapiUrl)}" style="color:inherit">the raw OpenAPI document</a> instead.</p></noscript>
<script id="api-reference" data-configuration="${configuration}"></script>
<script src="${SCALAR_SCRIPT.src}" integrity="${SCALAR_SCRIPT.integrity}" crossorigin="anonymous"></script>
</body></html>`;
}
