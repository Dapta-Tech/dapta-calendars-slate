/**
 * The dashboard API reference: every route of the signed-in surface
 * (`HostController` and `AdminCrudController`, all under `/v1`), with the area
 * it belongs to, who may call it and whether it destroys something.
 *
 * It is the list the MCP is measured against. `mcp/parity.ts` maps each route
 * here to the MCP tool that does the same thing, or names why none does, and
 * `mcp/mcp-parity.spec.ts` fails when a route has neither. So a route added to
 * the dashboard cannot be left out of the MCP without someone deciding it.
 *
 * Held to the truth by `api-reference.spec.ts`:
 *
 * - the routes here equal the routes the two controllers serve, read off their
 *   own Nest metadata, in both directions;
 * - `access` agrees with the permission checks in the handler's code;
 * - every DELETE is marked destructive.
 *
 * Routes are written exactly as the controllers declare them
 * (`METHOD /v1/path/:param`). Data only: no I/O, no framework.
 *
 * The public booking routes (`PublicController`), the API-key surfaces
 * (`/v1/machine/*`, `/v2/*`) and the MCP and OAuth doors are not here: an
 * agent already reaches them with a booking link or an API key.
 */

export type ApiArea =
  | 'identity'
  | 'onboarding'
  | 'profile'
  | 'bookingPage'
  | 'availability'
  | 'bookings'
  | 'eventTypes'
  | 'schedules'
  | 'teams'
  | 'members'
  | 'connections'
  | 'integrations'
  | 'apiKeys'
  | 'webhooks'
  | 'notifications';

/** The order the reference is read in: what an agent does most, first. */
export const API_AREAS: readonly ApiArea[] = [
  'identity',
  'bookings',
  'availability',
  'eventTypes',
  'schedules',
  'bookingPage',
  'teams',
  'members',
  'connections',
  'integrations',
  'notifications',
  'webhooks',
  'apiKeys',
  'profile',
  'onboarding',
];

/**
 * Who may call a route, as the handler enforces it (`permissions.ts`).
 *
 * - `member`: any signed-in member of the account, acting on themselves or
 *   reading what the whole account shares.
 * - `own`: a member on a resource they own; an owner or admin on anyone's
 *   (`assertOwnsOrAdmin`, or an admin check only for team resources).
 * - `admin`: owners and admins only (`assertAdmin`).
 * - `owner`: the owner only (`assertOwner`).
 */
export type ApiAccess = 'member' | 'own' | 'admin' | 'owner';

export interface ApiEndpoint {
  area: ApiArea;
  access: ApiAccess;
  /** Deletes, cancels, revokes or hands over something that cannot simply be undone. */
  destructive?: true;
  /** What the route does, in one line. */
  summary: string;
}

export const API_REFERENCE: Readonly<Record<string, ApiEndpoint>> = {
  // Identity: who is signed in and which accounts they reach.
  'GET /v1/me': { area: 'identity', access: 'member', summary: 'The signed-in member, their account and role.' },
  'GET /v1/me/workspaces': { area: 'identity', access: 'member', summary: 'The accounts this person belongs to or is invited to.' },
  'POST /v1/me/workspaces/:accountId/accept': {
    area: 'identity',
    access: 'member',
    summary: 'Accept an invitation to another account.',
  },

  // Bookings, as the host sees them.
  'GET /v1/host/bookings': { area: 'bookings', access: 'member', summary: 'List the bookings, filtered by dates and status.' },
  'GET /v1/host/bookings/:uid': { area: 'bookings', access: 'member', summary: 'One booking, with who booked and what they answered.' },
  'POST /v1/host/bookings': { area: 'bookings', access: 'member', summary: 'Book a slot on behalf of an invitee.' },
  'POST /v1/host/bookings/:uid/cancel': {
    area: 'bookings',
    access: 'member',
    destructive: true,
    summary: 'Cancel a booking, or a date of a repeating event and the dates after it.',
  },
  'POST /v1/host/bookings/:uid/confirm': { area: 'bookings', access: 'member', summary: 'Accept a booking request that waits for the host.' },
  'POST /v1/host/bookings/:uid/decline': {
    area: 'bookings',
    access: 'member',
    destructive: true,
    summary: 'Decline a booking request and free its time.',
  },

  // Availability.
  'GET /v1/me/availability': { area: 'availability', access: 'member', summary: "Open slots of one of the host's own event types." },

  // Event types and their one-off links.
  'GET /v1/event-types': { area: 'eventTypes', access: 'member', summary: 'List the event types, personal and team.' },
  'GET /v1/event-types/:id': { area: 'eventTypes', access: 'own', summary: 'One event type with all its settings.' },
  'POST /v1/event-types': { area: 'eventTypes', access: 'own', summary: 'Create an event type; a team one needs an owner or admin.' },
  'PATCH /v1/event-types/:id': { area: 'eventTypes', access: 'own', summary: 'Change an event type.' },
  'DELETE /v1/event-types/:id': { area: 'eventTypes', access: 'own', destructive: true, summary: 'Delete an event type.' },
  'POST /v1/event-types/reminder-preview': {
    area: 'eventTypes',
    access: 'member',
    summary: 'Render a reminder email as the invitee would get it.',
  },
  'GET /v1/event-types/:id/one-off-links': { area: 'eventTypes', access: 'own', summary: "List an event type's single-use links." },
  'POST /v1/event-types/:id/one-off-links': { area: 'eventTypes', access: 'own', summary: 'Create a single-use booking link.' },
  'DELETE /v1/event-types/:id/one-off-links/:linkId': {
    area: 'eventTypes',
    access: 'own',
    destructive: true,
    summary: 'Revoke a single-use booking link.',
  },

  // Schedules (working hours).
  'GET /v1/schedules': { area: 'schedules', access: 'member', summary: 'List the schedules.' },
  'GET /v1/schedules/:id': { area: 'schedules', access: 'own', summary: 'One schedule with its weekly hours and date overrides.' },
  'POST /v1/schedules': { area: 'schedules', access: 'member', summary: "Create a schedule under the caller." },
  'PATCH /v1/schedules/:id': { area: 'schedules', access: 'own', summary: 'Change a schedule.' },
  'DELETE /v1/schedules/:id': { area: 'schedules', access: 'own', destructive: true, summary: 'Delete a schedule.' },

  // The booking page and its look.
  'GET /v1/booking-page': { area: 'bookingPage', access: 'member', summary: "The caller's booking page and its look." },
  'PATCH /v1/booking-page': { area: 'bookingPage', access: 'member', summary: "Change the caller's booking page look." },
  'POST /v1/booking-page/apply-kit': { area: 'bookingPage', access: 'member', summary: "Apply the account's brand kit to the caller's page." },
  'POST /v1/booking-page/revert': { area: 'bookingPage', access: 'member', summary: 'Undo the last applied look, once.' },
  'GET /v1/brand-kit': { area: 'bookingPage', access: 'member', summary: "The account's brand kit." },
  'PUT /v1/brand-kit': { area: 'bookingPage', access: 'admin', summary: "Set the account's brand kit." },
  'GET /v1/account/branding': { area: 'bookingPage', access: 'member', summary: 'Whether the product branding shows on booking pages.' },
  'PATCH /v1/account/branding': { area: 'bookingPage', access: 'admin', summary: 'Hide or show the product branding.' },
  'GET /v1/account/vanity': { area: 'bookingPage', access: 'member', summary: "The account's short link name." },
  'PATCH /v1/account/vanity': { area: 'bookingPage', access: 'admin', summary: "Set or clear the account's short link name." },

  // Teams.
  'GET /v1/teams': { area: 'teams', access: 'member', summary: 'List the teams.' },
  'POST /v1/teams': { area: 'teams', access: 'admin', summary: 'Create a team.' },
  'PATCH /v1/teams/:id': { area: 'teams', access: 'admin', summary: 'Rename or reconfigure a team.' },
  'DELETE /v1/teams/:id': { area: 'teams', access: 'admin', destructive: true, summary: 'Delete a team.' },
  'GET /v1/teams/:id/members': { area: 'teams', access: 'member', summary: "A team's members and their roles." },
  'POST /v1/teams/:id/members': { area: 'teams', access: 'admin', summary: 'Add a member to a team.' },
  'PATCH /v1/teams/:id/members/:memberId': { area: 'teams', access: 'admin', summary: "Change a member's role in a team." },
  'DELETE /v1/teams/:id/members/:memberId': {
    area: 'teams',
    access: 'admin',
    destructive: true,
    summary: 'Remove a member from a team.',
  },
  'GET /v1/teams/:id/event-types': { area: 'teams', access: 'member', summary: "A team's event types." },

  // Account members.
  'GET /v1/members': { area: 'members', access: 'admin', summary: "List the account's members and invitations." },
  'POST /v1/members': { area: 'members', access: 'admin', summary: 'Invite someone to the account.' },
  'POST /v1/members/:id/resend-invite': { area: 'members', access: 'admin', summary: 'Send an invitation again.' },
  'PATCH /v1/members/:id': { area: 'members', access: 'admin', summary: "Change a member's role or status." },
  'DELETE /v1/members/:id': { area: 'members', access: 'admin', destructive: true, summary: 'Remove a member from the account.' },
  'POST /v1/members/:id/transfer-ownership': {
    area: 'members',
    access: 'owner',
    destructive: true,
    summary: 'Hand the account over to another member.',
  },

  // Calendar connections (each member's own).
  'GET /v1/connections': { area: 'connections', access: 'member', summary: "The caller's connected calendars." },
  'POST /v1/connections': { area: 'connections', access: 'member', summary: 'Save a calendar connection after the provider sign-in.' },
  'GET /v1/connections/status': { area: 'connections', access: 'member', summary: 'Whether each connection still works.' },
  'POST /v1/connections/token': { area: 'connections', access: 'member', summary: "A short-lived token for the provider's sign-in window." },
  'POST /v1/connections/discover': { area: 'connections', access: 'member', summary: 'Find the calendars a provider sign-in can see.' },
  'GET /v1/connections/:id/calendars': { area: 'connections', access: 'member', summary: "The calendars inside one connection." },
  'PATCH /v1/connections/:id': { area: 'connections', access: 'member', summary: 'Choose which calendars to check and where events go.' },
  'POST /v1/connections/:id/ping': { area: 'connections', access: 'member', summary: 'Check that a connection answers.' },
  'POST /v1/connections/:id/test': { area: 'connections', access: 'member', summary: 'Read a connection end to end, as a booking would.' },
  'DELETE /v1/connections/:id': { area: 'connections', access: 'member', destructive: true, summary: 'Disconnect a calendar.' },

  // Integrations (CRM and others).
  'GET /v1/integrations': { area: 'integrations', access: 'admin', summary: 'The integrations and their state.' },
  'GET /v1/integrations/capabilities': { area: 'integrations', access: 'admin', summary: 'What each integration can do here.' },
  'GET /v1/integrations/crm/contact-properties': {
    area: 'integrations',
    access: 'member',
    summary: "The connected CRM's contact properties, for mapping form questions.",
  },
  'POST /v1/integrations': { area: 'integrations', access: 'admin', summary: 'Connect an integration.' },
  'DELETE /v1/integrations/:provider': {
    area: 'integrations',
    access: 'admin',
    destructive: true,
    summary: 'Disconnect an integration.',
  },

  // Notification emails.
  'GET /v1/notification-settings': { area: 'notifications', access: 'admin', summary: 'The notification emails and their settings.' },
  'PATCH /v1/notification-settings/:key': { area: 'notifications', access: 'admin', summary: 'Turn an email on or off, or edit its text.' },
  'POST /v1/notification-settings/:key/preview': { area: 'notifications', access: 'admin', summary: 'Render a notification email.' },
  'DELETE /v1/notification-settings/:key/template': {
    area: 'notifications',
    access: 'admin',
    destructive: true,
    summary: 'Drop an edited email text and go back to the default.',
  },

  // Webhooks.
  'GET /v1/webhooks': { area: 'webhooks', access: 'admin', summary: 'List the webhooks.' },
  'POST /v1/webhooks': { area: 'webhooks', access: 'admin', summary: 'Add a webhook.' },
  'PATCH /v1/webhooks/:id': { area: 'webhooks', access: 'admin', summary: 'Pause or resume a webhook.' },
  'POST /v1/webhooks/:id/ping': { area: 'webhooks', access: 'admin', summary: 'Send a test delivery.' },
  'GET /v1/webhooks/:id/deliveries': { area: 'webhooks', access: 'admin', summary: "A webhook's recent deliveries." },
  'DELETE /v1/webhooks/:id': { area: 'webhooks', access: 'admin', destructive: true, summary: 'Delete a webhook.' },

  // API keys.
  'GET /v1/api-keys': { area: 'apiKeys', access: 'admin', summary: 'List the API keys.' },
  'POST /v1/api-keys': { area: 'apiKeys', access: 'admin', summary: 'Mint an API key.' },
  'DELETE /v1/api-keys/:id': { area: 'apiKeys', access: 'admin', destructive: true, summary: 'Revoke an API key.' },

  // The caller's own profile and settings.
  'PATCH /v1/me/settings': { area: 'profile', access: 'member', summary: "The caller's name, time zone and language." },
  'PATCH /v1/me/handle': { area: 'profile', access: 'member', summary: "Change the caller's booking link name." },
  'GET /v1/handle-available': { area: 'profile', access: 'member', summary: 'Whether a link name is free.' },
  'POST /v1/me/timezone-sync': { area: 'profile', access: 'member', summary: "Follow the browser's time zone." },

  // Onboarding.
  'GET /v1/me/setup-status': { area: 'onboarding', access: 'member', summary: 'Which setup steps are done.' },
  'GET /v1/me/onboarding': { area: 'onboarding', access: 'member', summary: 'Where the onboarding stands.' },
  'POST /v1/me/onboarding/qualification': { area: 'onboarding', access: 'admin', summary: 'Answer the onboarding questions.' },
  'POST /v1/me/onboarding/setup': { area: 'onboarding', access: 'member', summary: 'Create the first event type from a template.' },
  'POST /v1/me/onboarding/early': { area: 'onboarding', access: 'admin', summary: 'Leave the onboarding early.' },
  'POST /v1/me/attribution': { area: 'onboarding', access: 'member', summary: 'Record where the sign-up came from.' },
};

export interface ApiEndpointEntry extends ApiEndpoint {
  route: string;
  method: string;
  path: string;
}

/** The reference as a list, area by area in `API_AREAS` order. */
export function apiEndpoints(): ApiEndpointEntry[] {
  const all = Object.entries(API_REFERENCE).map(([route, e]) => {
    const [method, path] = route.split(' ') as [string, string];
    return { ...e, route, method, path };
  });
  return API_AREAS.flatMap((area) => all.filter((e) => e.area === area));
}
