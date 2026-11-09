/**
 * The MCP against the dashboard API, route by route.
 *
 * Every route of the dashboard API reference (`API_REFERENCE` in
 * `../api-reference.ts`) is either served by an MCP tool (`API_ROUTE_TOOLS`)
 * or left out with a reason (`API_ROUTE_EXCLUSIONS`). `mcp-parity.spec.ts`
 * walks the reference and fails when a route has neither, so a route added to
 * the dashboard cannot be left out of the MCP without someone saying why.
 *
 * Data only. Read it as the MCP's coverage map: the `not-yet` exclusions are
 * the work left to reach parity, area by area.
 */

/**
 * Which tool serves each route, written exactly as the reference names it. A
 * tool may serve several routes; a route has one tool.
 */
export const API_ROUTE_TOOLS: Readonly<Record<string, string>> = {
  'GET /v1/me': 'whoami',
  'GET /v1/me/workspaces': 'list_my_accounts',

  'GET /v1/host/bookings': 'list_bookings',
  'GET /v1/host/bookings/:uid': 'get_booking',
  'POST /v1/host/bookings': 'create_booking',
  'POST /v1/host/bookings/:uid/cancel': 'cancel_booking',
  'POST /v1/host/bookings/:uid/confirm': 'confirm_booking',
  'POST /v1/host/bookings/:uid/decline': 'decline_booking',

  'GET /v1/me/availability': 'find_available_slots',

  'GET /v1/event-types': 'list_event_types',
};

/**
 * Why a route has no tool.
 *
 * - `excluded`: decided against exposing it over MCP (docs/MCP.md). Reversing
 *   that is a product decision, not a missing tool.
 * - `dashboard-only`: it only works with a person in the browser (a provider's
 *   sign-in window, the onboarding, the browser's own time zone), or it is an
 *   act the account keeps for a person in the dashboard.
 * - `not-yet`: nothing argues against a tool; it has not been written. These
 *   are the work left to reach parity.
 */
export type ExclusionKind = 'excluded' | 'dashboard-only' | 'not-yet';

export interface RouteExclusion {
  kind: ExclusionKind;
  reason: string;
}

const EVENT_TYPE_EDITS = 'Event-type edits are not exposed over MCP (docs/MCP.md).';
const TEAM_ADMIN = 'Team administration is not exposed over MCP (docs/MCP.md).';
const WEBHOOKS = 'Webhooks are not exposed over MCP (docs/MCP.md): one sends booking data to any address it names.';
const API_KEYS = 'API keys are not exposed over MCP (docs/MCP.md): an agent does not mint or revoke credentials.';
const PROVIDER_SIGN_IN = "Finishes a provider's sign-in window, which needs a person in the browser.";
const ONBOARDING = 'Part of the onboarding a person goes through in the dashboard.';

const notYet = (reason: string): RouteExclusion => ({ kind: 'not-yet', reason });
const excluded = (reason: string): RouteExclusion => ({ kind: 'excluded', reason });
const dashboardOnly = (reason: string): RouteExclusion => ({ kind: 'dashboard-only', reason });

export const API_ROUTE_EXCLUSIONS: Readonly<Record<string, RouteExclusion>> = {
  // Identity
  'POST /v1/me/workspaces/:accountId/accept': dashboardOnly("Joining another account is the person's own consent, given in the dashboard."),

  // Event types
  'GET /v1/event-types/:id': notYet('No tool reads one event type with all its settings.'),
  'POST /v1/event-types': excluded(EVENT_TYPE_EDITS),
  'PATCH /v1/event-types/:id': excluded(EVENT_TYPE_EDITS),
  'DELETE /v1/event-types/:id': excluded(EVENT_TYPE_EDITS),
  'POST /v1/event-types/reminder-preview': notYet('No tool renders a reminder email.'),
  'GET /v1/event-types/:id/one-off-links': notYet('No tool lists single-use links.'),
  'POST /v1/event-types/:id/one-off-links': notYet('No tool creates a single-use link.'),
  'DELETE /v1/event-types/:id/one-off-links/:linkId': notYet('No tool revokes a single-use link.'),

  // Schedules
  'GET /v1/schedules': notYet('No tool lists schedules.'),
  'GET /v1/schedules/:id': notYet('No tool reads a schedule.'),
  'POST /v1/schedules': notYet('No tool creates a schedule.'),
  'PATCH /v1/schedules/:id': notYet('No tool changes working hours.'),
  'DELETE /v1/schedules/:id': notYet('No tool deletes a schedule.'),

  // Booking page
  'GET /v1/booking-page': notYet('No tool reads the booking page look; get_booking_page_link gives only its address.'),
  'PATCH /v1/booking-page': notYet('No tool changes the booking page look.'),
  'POST /v1/booking-page/apply-kit': notYet('No tool applies the brand kit.'),
  'POST /v1/booking-page/revert': notYet('No tool undoes an applied look.'),
  'GET /v1/brand-kit': notYet('No tool reads the brand kit.'),
  'PUT /v1/brand-kit': notYet('No tool sets the brand kit.'),
  'GET /v1/account/branding': notYet('No tool reads whether the product branding shows.'),
  'PATCH /v1/account/branding': notYet('No tool hides or shows the product branding.'),
  'GET /v1/account/vanity': notYet('No tool reads the short link name.'),
  'PATCH /v1/account/vanity': notYet('No tool sets the short link name.'),

  // Teams
  'GET /v1/teams': notYet('No tool lists teams; find_team_slots works from a team link.'),
  'POST /v1/teams': excluded(TEAM_ADMIN),
  'PATCH /v1/teams/:id': excluded(TEAM_ADMIN),
  'DELETE /v1/teams/:id': excluded(TEAM_ADMIN),
  'GET /v1/teams/:id/members': notYet("No tool lists a team's members."),
  'POST /v1/teams/:id/members': excluded(TEAM_ADMIN),
  'PATCH /v1/teams/:id/members/:memberId': excluded(TEAM_ADMIN),
  'DELETE /v1/teams/:id/members/:memberId': excluded(TEAM_ADMIN),
  'GET /v1/teams/:id/event-types': notYet("No tool lists a team's event types on their own; list_event_types includes them."),

  // Members
  'GET /v1/members': notYet("No tool lists the account's members."),
  'POST /v1/members': notYet('No tool invites someone to the account.'),
  'POST /v1/members/:id/resend-invite': notYet('No tool sends an invitation again.'),
  'PATCH /v1/members/:id': notYet("No tool changes a member's role or status."),
  'DELETE /v1/members/:id': notYet('No tool removes a member.'),
  'POST /v1/members/:id/transfer-ownership': dashboardOnly('Handing the account over cannot be undone by the person who gives it; it stays a deliberate act in the dashboard.'),

  // Connections
  'GET /v1/connections': notYet('No tool lists the connected calendars.'),
  'POST /v1/connections': dashboardOnly(PROVIDER_SIGN_IN),
  'GET /v1/connections/status': notYet('No tool reports whether each connection still works.'),
  'POST /v1/connections/token': dashboardOnly(PROVIDER_SIGN_IN),
  'POST /v1/connections/discover': dashboardOnly(PROVIDER_SIGN_IN),
  'GET /v1/connections/:id/calendars': notYet('No tool lists the calendars inside a connection.'),
  'PATCH /v1/connections/:id': notYet('No tool chooses which calendars are checked.'),
  'POST /v1/connections/:id/ping': notYet('No tool checks that a connection answers.'),
  'POST /v1/connections/:id/test': notYet('No tool tests a connection end to end.'),
  'DELETE /v1/connections/:id': notYet('No tool disconnects a calendar.'),

  // Integrations
  'GET /v1/integrations': notYet('No tool lists the integrations.'),
  'GET /v1/integrations/capabilities': notYet('No tool reads what each integration can do.'),
  'GET /v1/integrations/crm/contact-properties': notYet("No tool reads the CRM's contact properties."),
  'POST /v1/integrations': dashboardOnly(PROVIDER_SIGN_IN),
  'DELETE /v1/integrations/:provider': notYet('No tool disconnects an integration.'),

  // Notifications
  'GET /v1/notification-settings': notYet('No tool lists the notification emails.'),
  'PATCH /v1/notification-settings/:key': notYet('No tool changes a notification email.'),
  'POST /v1/notification-settings/:key/preview': notYet('No tool renders a notification email.'),
  'DELETE /v1/notification-settings/:key/template': notYet('No tool resets a notification email to its default.'),

  // Webhooks
  'GET /v1/webhooks': excluded(WEBHOOKS),
  'POST /v1/webhooks': excluded(WEBHOOKS),
  'PATCH /v1/webhooks/:id': excluded(WEBHOOKS),
  'POST /v1/webhooks/:id/ping': excluded(WEBHOOKS),
  'GET /v1/webhooks/:id/deliveries': excluded(WEBHOOKS),
  'DELETE /v1/webhooks/:id': excluded(WEBHOOKS),

  // API keys
  'GET /v1/api-keys': excluded(API_KEYS),
  'POST /v1/api-keys': excluded(API_KEYS),
  'DELETE /v1/api-keys/:id': excluded(API_KEYS),

  // Profile
  'PATCH /v1/me/settings': notYet("No tool changes the caller's name, time zone or language."),
  'PATCH /v1/me/handle': notYet("No tool changes the caller's link name."),
  'GET /v1/handle-available': notYet('No tool checks whether a link name is free.'),
  'POST /v1/me/timezone-sync': dashboardOnly("Follows the browser's own time zone."),

  // Onboarding
  'GET /v1/me/setup-status': dashboardOnly(ONBOARDING),
  'GET /v1/me/onboarding': dashboardOnly(ONBOARDING),
  'POST /v1/me/onboarding/qualification': dashboardOnly(ONBOARDING),
  'POST /v1/me/onboarding/setup': dashboardOnly(ONBOARDING),
  'POST /v1/me/onboarding/early': dashboardOnly(ONBOARDING),
  'POST /v1/me/attribution': dashboardOnly('Records where a sign-up came from, once, from the browser that signed up.'),
};

/** How many routes each tool or exclusion kind accounts for. */
export function parityCoverage(): Record<'tool' | ExclusionKind, number> {
  const out: Record<'tool' | ExclusionKind, number> = { tool: 0, excluded: 0, 'dashboard-only': 0, 'not-yet': 0 };
  out.tool = Object.keys(API_ROUTE_TOOLS).length;
  for (const e of Object.values(API_ROUTE_EXCLUSIONS)) out[e.kind] += 1;
  return out;
}
