/**
 * Pure builders for the "MCP & API" page: the Cursor deeplink, the config
 * snippets for each agent, the scope catalog and the tool list.
 *
 * Nothing here reads the environment or the DOM, so the same functions run on the
 * server (the MCP URL is resolved there, at runtime — see `mcp-config.ts`) and in
 * tests. No host name is hard-coded: every snippet takes the MCP URL as input.
 *
 * KEY HANDLING. No snippet ever contains a key. Every one of them points at the
 * environment variable below, so a link, a chat paste or a committed `mcp.json`
 * cannot leak a credential.
 */

/** The environment variable every snippet reads the API key from. */
export const API_KEY_ENV = 'DAPTA_CALENDARS_API_KEY';

/** The name the server is registered under in the agent's config. */
export const SERVER_NAME = 'dapta-calendars';

/** The single server entry Cursor stores under `mcpServers.<name>`. */
export function cursorServerEntry(mcpUrl: string): {
  url: string;
  headers: { Authorization: string };
} {
  // `${env:NAME}` is Cursor's interpolation, resolved on the user's machine when
  // the server starts: the link carries the variable's NAME, never its value.
  return { url: mcpUrl, headers: { Authorization: `Bearer \${env:${API_KEY_ENV}}` } };
}

/** `base64(JSON.stringify(entry))` — the `config` of a Cursor install link. */
export function encodeCursorConfig(entry: object): string {
  return Buffer.from(JSON.stringify(entry), 'utf8').toString('base64');
}

/** The one-click link. Cursor asks the user to confirm; it never auto-installs. */
export function cursorDeeplink(mcpUrl: string): string {
  const config = encodeURIComponent(encodeCursorConfig(cursorServerEntry(mcpUrl)));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${config}`;
}

/** The copyable `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). */
export function cursorMcpJson(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: cursorServerEntry(mcpUrl) } }, null, 2);
}

export function claudeCodeCommand(mcpUrl: string): string {
  return [
    `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} \\`,
    // Single quotes on purpose: the shell must NOT expand the variable, or Claude
    // Code would store the plaintext key in its config. It stores the literal
    // `${VAR}` and resolves it each time the server starts.
    `  --header 'Authorization: Bearer \${${API_KEY_ENV}}'`,
  ].join('\n');
}

/** `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project. */
export function codexConfigToml(mcpUrl: string): string {
  return [`[mcp_servers.${SERVER_NAME}]`, `url = "${mcpUrl}"`, `bearer_token_env_var = "${API_KEY_ENV}"`].join('\n');
}

/** What any other agent or SDK needs: the URL and the one header. */
export function genericConnection(mcpUrl: string): { url: string; header: string } {
  return { url: mcpUrl, header: `Authorization: Bearer <your ${API_KEY_ENV}>` };
}

export function exportKeyCommand(): string {
  return `export ${API_KEY_ENV}="dcl_your_key_here"`;
}

// --- Scopes -----------------------------------------------------------------

export type ToolKind = 'read' | 'write' | 'destructive';

export interface ScopeInfo {
  scope: string;
  kind: ToolKind;
}

/**
 * Every scope a key can carry, in the order the create form shows them.
 * `bookings:cancel` is new with the MCP server; a key list that predates it simply
 * never shows it, and an API that predates it rejects it at create time (the form
 * surfaces that error rather than hiding the box).
 */
export const SCOPE_CATALOG: readonly ScopeInfo[] = [
  { scope: 'event-types:read', kind: 'read' },
  { scope: 'availability:read', kind: 'read' },
  { scope: 'bookings:read', kind: 'read' },
  { scope: 'bookings:write', kind: 'write' },
  { scope: 'bookings:cancel', kind: 'destructive' },
  { scope: 'calendars:read', kind: 'read' },
];

/** The scope's plain-language label, or the raw scope when the catalog lacks it. */
export function scopeLabel(labels: Record<string, string>, scope: string): string {
  return labels[scope] ?? scope;
}

// --- Tools ------------------------------------------------------------------

export interface ToolInfo {
  name: string;
  kind: ToolKind;
  /** The scope a key needs, or `null` when no particular scope is required. */
  scope: string | null;
  /** True when the tool also works with no key at all, on a public booking page. */
  publicOk: boolean;
}

/** The ten launch tools (plan section 3). */
export const MCP_TOOLS: readonly ToolInfo[] = [
  { name: 'find_available_slots', kind: 'read', scope: 'availability:read', publicOk: true },
  { name: 'book_meeting', kind: 'write', scope: null, publicOk: true },
  { name: 'whoami', kind: 'read', scope: null, publicOk: false },
  { name: 'list_event_types', kind: 'read', scope: 'event-types:read', publicOk: false },
  { name: 'get_booking_page_link', kind: 'read', scope: 'event-types:read', publicOk: false },
  { name: 'list_bookings', kind: 'read', scope: 'bookings:read', publicOk: false },
  { name: 'get_booking', kind: 'read', scope: 'bookings:read', publicOk: false },
  { name: 'create_booking', kind: 'write', scope: 'bookings:write', publicOk: false },
  { name: 'reschedule_booking', kind: 'write', scope: 'bookings:write', publicOk: false },
  { name: 'cancel_booking', kind: 'destructive', scope: 'bookings:cancel', publicOk: false },
];

// --- Key list ---------------------------------------------------------------

/** The optional fields the API list adds; every one may be absent on an older API. */
export interface KeyDetails {
  scopes?: string[] | null;
  eventTypeIds?: string[] | null;
  expiresAt?: number | string | null;
  lastUsedAt?: number | string | null;
}

/** Epoch ms from a number, an ISO string or nothing. */
export function toMs(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export type ExpiryState = 'never' | 'active' | 'expired';

export function expiryState(expiresAt: number | string | null | undefined, now: number): ExpiryState {
  const ms = toMs(expiresAt);
  if (ms === null) return 'never';
  return ms <= now ? 'expired' : 'active';
}

/** Presets offered in the create form. `0` means no expiry. */
export const EXPIRY_PRESET_DAYS = [0, 30, 90, 365] as const;

export function expiresAtMsFromDays(days: number, now: number): number | undefined {
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return now + Math.floor(days) * 24 * 60 * 60 * 1000;
}
