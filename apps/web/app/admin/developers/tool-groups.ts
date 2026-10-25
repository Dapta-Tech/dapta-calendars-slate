/**
 * The MCP's tools, grouped the way the connect page and the Tools page present
 * them. Names only, no prose: the copy for each group and tool is in the
 * message catalog (`admin.tools.groups` and `admin.tools.items`).
 *
 * Kept as plain data because the web app shares no module with the API, where
 * the server's catalog lives (`apps/api/src/mcp/tools.ts`). `tool-groups.spec.ts`
 * reads that file and holds this one to it: every tool in exactly one group,
 * none invented, so a new tool fails the spec until it is placed here.
 */
export const TOOL_GROUPS = {
  availability: ['find_available_slots', 'find_team_slots'],
  booking: ['book_meeting', 'book_team_meeting', 'create_booking'],
  holds: ['hold_slot'],
  bookings: ['list_bookings', 'get_booking', 'reschedule_booking', 'cancel_booking'],
  requests: ['list_pending_bookings', 'confirm_booking', 'decline_booking'],
  account: ['whoami', 'list_my_accounts', 'list_event_types', 'get_booking_page_link'],
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

/** The group order on the page. */
export const TOOL_GROUP_ORDER: readonly ToolGroup[] = ['availability', 'booking', 'holds', 'bookings', 'requests', 'account'];

/** PrimeIcons class for each group's tile. */
export const TOOL_GROUP_ICONS: Record<ToolGroup, string> = {
  availability: 'pi-clock',
  booking: 'pi-calendar-plus',
  holds: 'pi-bookmark',
  bookings: 'pi-calendar',
  requests: 'pi-inbox',
  account: 'pi-users',
};

export const TOOL_COUNT = Object.values(TOOL_GROUPS).reduce((n, names) => n + names.length, 0);
