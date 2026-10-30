import type { BookingMessages } from '@slate/shared';

/**
 * The admin rail's information architecture, apart from the shell that draws
 * it so the rules (who sees what, where each item goes) are testable without a
 * render.
 */

type AdminMessages = BookingMessages['admin'];

export type NavIcon =
  | 'home'
  | 'calendar'
  | 'clock'
  | 'ticket'
  | 'users'
  | 'calendarPlus'
  | 'cog'
  | 'mcp'
  | 'tools'
  | 'api'
  | 'book'
  | 'agents';

/**
 * Everything for agents and builders lives under `/admin/developers`: the
 * connect guide and the Tools page (rail items of their own), then the API
 * keys and webhooks (the "API and webhooks" group). The group's last item, API
 * docs, is the API's own reference on the API's origin (`apiDocsNavHref`);
 * `DEVELOPERS_DOCS_HREF` only redirects there, for links made before.
 */
export const DEVELOPERS_HREF = '/admin/developers';
export const DEVELOPERS_CONNECT_HREF = '/admin/developers/connect';
export const DEVELOPERS_TOOLS_HREF = '/admin/developers/tools';
export const DEVELOPERS_KEYS_HREF = '/admin/developers/keys';
export const DEVELOPERS_WEBHOOKS_HREF = '/admin/developers/webhooks';
export const DEVELOPERS_DOCS_HREF = '/admin/developers/docs';

export interface SubNavItem {
  key: keyof AdminMessages['developerNav'];
  href: string;
  /** Icon class, shown in the collapsed rail's flyout where a row has room for one. */
  icon: string;
  /** Leaves the app: a plain anchor in a new tab, with the external-link arrow, never `aria-current`. */
  external?: true;
}

/** The group's pages inside the app. */
export const DEVELOPER_PAGES: readonly SubNavItem[] = [
  { key: 'keys', href: DEVELOPERS_KEYS_HREF, icon: 'pi-key' },
  { key: 'webhooks', href: DEVELOPERS_WEBHOOKS_HREF, icon: 'pi-send' },
];

/**
 * The API reference (`/docs` on the API's public origin, resolved on the server
 * from runtime env), or null when the deployment does not say where its API is
 * served: then the group has no API docs item rather than a dead link.
 */
export function apiDocsNavHref(apiOrigin: string | null): string | null {
  return apiOrigin ? `${apiOrigin}/docs` : null;
}

export interface NavItem {
  key: keyof AdminMessages['nav'];
  href: string;
  icon: NavIcon;
  /** Active when the path starts with any of these (instead of href). */
  match?: string[];
  /** Leaves the app: a plain anchor in a new tab, never `aria-current`. */
  external?: true;
  /**
   * The rail's one call to action: a tinted row that breathes a soft glow
   * until you are on it, as the dForms rail draws the same item.
   */
  prominent?: true;
  /**
   * Pages under this item. The item becomes a disclosure instead of a link: an
   * accordion in the wide rail and the drawer, a flyout menu on the collapsed
   * rail. `match` (or `href`) then marks the group active.
   */
  children?: readonly SubNavItem[];
}

// Same information architecture + order as the old app: Home, Bookings,
// Availability, Event Types, Teams, Calendars, Settings. Calendars is a
// top-level item (route /admin/connections), no longer a Settings sub-tab.
// Labels are resolved from the active locale's catalog (F8).
const PRODUCT_NAV: readonly NavItem[] = [
  { key: 'home', href: '/admin', icon: 'home' },
  { key: 'bookings', href: '/admin/bookings', icon: 'calendar' },
  { key: 'availability', href: '/admin/availability', icon: 'clock' },
  { key: 'eventTypes', href: '/admin/event-types', icon: 'ticket' },
  { key: 'teams', href: '/admin/teams', icon: 'users' },
  { key: 'calendars', href: '/admin/connections', icon: 'calendarPlus' },
  { key: 'settings', href: '/admin/settings', icon: 'cog' },
];

/** Connect your agent, Tools, then the API and webhooks group (owners and admins only). */
function agentNav(apiDocsHref: string | null): NavItem[] {
  return [
    { key: 'connect', href: DEVELOPERS_CONNECT_HREF, icon: 'mcp', prominent: true },
    { key: 'tools', href: DEVELOPERS_TOOLS_HREF, icon: 'tools' },
    {
      key: 'api',
      href: DEVELOPERS_HREF,
      icon: 'api',
      // The group is its own pages, not the whole `/admin/developers` prefix,
      // which the connect guide and Tools share.
      match: DEVELOPER_PAGES.map((page) => page.href),
      // API docs opens the reference itself, in a new tab like Docs: never an
      // in-app page between, and never the reference inside the dashboard.
      children: [
        ...DEVELOPER_PAGES,
        ...(apiDocsHref ? [{ key: 'docs', href: apiDocsHref, icon: 'pi-file-code', external: true } as const] : []),
      ],
    },
  ];
}

/**
 * The rail for one viewer, in the order Dapta's other sidecar (dForms) uses:
 * the product's own pages first, then "Connect your agent" and "Tools", then
 * "Docs".
 *
 * "Connect your agent" is the guide that connects an AI app to the MCP server
 * with the person's account: its own prominent item (`prominent`), so it is
 * found without being looked for, and its icon is the rotating AI app logos.
 * "Tools" says what a connected agent can do, in plain words. After them, a
 * quiet "API and webhooks" group holds what builders use: API keys, webhooks
 * and the API docs (`apiDocsHref`, the API's own reference, external). Only
 * owners and admins get any of the three: a sign-in
 * reaches only the workspaces where the person is an owner or admin, and the
 * API refuses keys and webhooks to a plain member, so for a member each would
 * lead to "no access" or to a connection that fails.
 *
 * Docs is the product documentation in the reader's language, external,
 * because it leaves the app. It exists only when the deployment says where its
 * docs live (`docsHref`, resolved on the server from `DOCS_URL`): a fork with
 * nothing configured carries no dead link and no link to someone else's docs.
 *
 * Last, and only on a deployment that has a platform (`platformHref`, from
 * NEXT_PUBLIC_PLATFORM_URL): "Dapta Agents", the door to the wider platform,
 * exactly as the dForms rail ends. In the list rather than a separate block so
 * the rail reads as one list, external like Docs, and absent on a fork.
 */
export function adminNav({
  isAdmin,
  docsHref,
  apiDocsHref = null,
  platformHref = null,
}: {
  isAdmin: boolean;
  docsHref: string | null;
  apiDocsHref?: string | null;
  platformHref?: string | null;
}): NavItem[] {
  return [
    ...PRODUCT_NAV,
    ...(isAdmin ? agentNav(apiDocsHref) : []),
    ...(docsHref ? [{ key: 'docs', href: docsHref, icon: 'book', external: true } as const] : []),
    ...(platformHref ? [{ key: 'agents', href: platformHref, icon: 'agents', external: true } as const] : []),
  ];
}

/**
 * The platform door's address: the deployment's platform URL tagged as a click
 * from this app's sidebar (`utm_source=calendars`, `utm_medium=sidebar`, the
 * same tags as the Docs item), or null when there is no platform (a fork).
 */
export function platformNavHref(base: string | undefined): string | null {
  const raw = base?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.searchParams.set('utm_source', 'calendars');
    url.searchParams.set('utm_medium', 'sidebar');
    return url.toString();
  } catch {
    return null;
  }
}
