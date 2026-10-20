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
  | 'book'
  | 'agents';

/** The MCP group: the pages under it, and the prefix that marks it active. */
export const DEVELOPERS_HREF = '/admin/developers';
export const DEVELOPERS_KEYS_HREF = '/admin/developers/keys';
export const DEVELOPERS_WEBHOOKS_HREF = '/admin/developers/webhooks';
export const DEVELOPERS_DOCS_HREF = '/admin/developers/docs';

export interface SubNavItem {
  key: keyof AdminMessages['developerNav'];
  href: string;
  /** Icon class, shown in the collapsed rail's flyout where a row has room for one. */
  icon: string;
}

export const DEVELOPER_PAGES: readonly SubNavItem[] = [
  { key: 'keys', href: DEVELOPERS_KEYS_HREF, icon: 'pi-key' },
  { key: 'webhooks', href: DEVELOPERS_WEBHOOKS_HREF, icon: 'pi-send' },
  { key: 'docs', href: DEVELOPERS_DOCS_HREF, icon: 'pi-file-code' },
];

export interface NavItem {
  key: keyof AdminMessages['nav'];
  href: string;
  icon: NavIcon;
  /** Active when the path starts with any of these (in addition to href). */
  match?: string[];
  /** Leaves the app: a plain anchor in a new tab, never `aria-current`. */
  external?: true;
  /**
   * Pages under this item. The item becomes a disclosure instead of a link: an
   * accordion in the wide rail and the drawer, a flyout menu on the collapsed
   * rail. `href` is then the prefix that marks the group active.
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

/**
 * The rail for one viewer, in the order Dapta's other sidecar (dForms) uses for
 * the same two items: the product's own pages first, then "MCP", then "Docs".
 *
 * MCP (keyed `developers`) holds the agent and API surface: connecting an agent
 * and its keys, webhooks, and the docs for what a key can call. Its own item
 * rather than a Settings tab, so it is found without being looked for, and its
 * icon is the rotating Claude, ChatGPT and Cursor logos. Only owners and admins
 * get it: the API refuses keys and webhooks to a plain member, and an item that
 * leads to "no access" is worse than no item.
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
  platformHref = null,
}: {
  isAdmin: boolean;
  docsHref: string | null;
  platformHref?: string | null;
}): NavItem[] {
  return [
    ...PRODUCT_NAV,
    ...(isAdmin
      ? [{ key: 'developers', href: DEVELOPERS_HREF, icon: 'mcp', children: DEVELOPER_PAGES } as const]
      : []),
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
