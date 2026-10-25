/**
 * What this build calls the product, and whether it is Dapta's own build.
 *
 * The name comes from the deployment (`NEXT_PUBLIC_PRODUCT_NAME`, inlined at
 * build time): a bare fork keeps the default `Calendars` or names itself, and
 * gets a neutral typographic brand. Dapta's pipeline sets it to name the real
 * product, and only then may Dapta's artwork render (see
 * `components/brand/brand.tsx`). Same principle as `MadeWithBadge`: a fork is
 * never forced to carry Dapta branding.
 *
 * Both spellings Dapta's pipeline has used identify a Dapta build, so deploying
 * this ahead of a pipeline change cannot silently turn Dapta's own build into a
 * fork (the marks would vanish and the chrome would fall back to a letter chip).
 */
const RAW_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';

/** True only on a build that identifies itself as Dapta's own. */
export const IS_DAPTA_BRAND = RAW_NAME === 'Dapta Calendars' || RAW_NAME === 'dCalendars';

/** The customer-facing product name, exactly as the deployment set it. */
export const PRODUCT_NAME = RAW_NAME;

/**
 * The short name the MCP connector goes by wherever a person meets it: the
 * connect guide, the Tools page, the home promo and the name typed into an AI
 * app. On Dapta's build it is `dCal`, the name the server gives its resource
 * and the rail's wordmark reads (the build's product name is longer); a fork
 * gets its own product name and none of Dapta's.
 */
export const CONNECTOR_NAME = IS_DAPTA_BRAND ? 'dCal' : PRODUCT_NAME;
