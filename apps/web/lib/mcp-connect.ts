/**
 * Pure builders for the agent pages: the snippet each AI app needs to connect,
 * the scope catalog and the tool list.
 *
 * Nothing here reads the environment or the DOM, so the same functions run on the
 * server (the MCP URL is resolved there, at runtime, see `mcp-config.ts`) and in
 * tests. No host name is hard-coded: every snippet takes the MCP URL as input.
 *
 * NO KEY. Every connect snippet carries the URL alone: the app signs in with the
 * person's account (OAuth) the first time it calls the server, so a link, a
 * pasted command or a committed config file carries no credential. The key
 * variable below is for the skill zip, which teaches the REST API.
 */

/** The environment variable the skill reads the API key from. */
export const API_KEY_ENV = 'DAPTA_CALENDARS_API_KEY';

/** How every API key this product mints begins (`dcl_<8 hex>_<secret>`). */
export const KEY_PREFIX = 'dcl_';

/**
 * The name the server is registered under in each agent's config: `dcal`, the
 * connector's name (decision D3). An install made under the old
 * `dapta-calendars` keeps working, since the name is only the agent's own
 * label for the server and never reaches it.
 */
export const SERVER_NAME = 'dcal';

/**
 * An address that can go into a shell command as it is: a scheme, a host,
 * an optional port and a path of URL-safe characters, nothing a shell reads
 * (`$`, quotes, `;`, `&`, `|`, spaces). The snippets paste the address
 * unquoted, so one that is not safe is not printed at all.
 */
export function isShellSafeUrl(url: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%/-]*)?$/.test(url);
}

/** The single entry Cursor stores under `mcpServers.dcal`: the URL alone, Cursor runs the sign-in. */
export function cursorServerEntry(mcpUrl: string): { url: string } {
  return { url: mcpUrl };
}

/** `base64(JSON.stringify(entry))`, the `config` of a Cursor install link. */
export function encodeCursorConfig(entry: object): string {
  return Buffer.from(JSON.stringify(entry), 'utf8').toString('base64');
}

/** The one-click link. Cursor asks the user to confirm; it never installs on its own. */
export function cursorDeeplink(mcpUrl: string): string {
  const config = encodeURIComponent(encodeCursorConfig(cursorServerEntry(mcpUrl)));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${config}`;
}

/** `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project). */
export function cursorMcpJson(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: cursorServerEntry(mcpUrl) } }, null, 2);
}

/** Claude Code, for every project of this user; `/mcp` then runs the sign-in. */
export function claudeCodeCommand(mcpUrl: string): string {
  return `claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl}`;
}

/** Codex: add the server by URL, then `codexLoginCommand` runs the sign-in. */
export function codexAddCommand(mcpUrl: string): string {
  return `codex mcp add ${SERVER_NAME} --url ${mcpUrl}`;
}

export const codexLoginCommand = `codex mcp login ${SERVER_NAME}`;

/**
 * OpenClaw: save the server as a remote, streamable-HTTP entry that logs in
 * with OAuth (`mcp.servers.dcal` in its config), per OpenClaw's
 * `openclaw mcp set` docs; `openclawLoginCommand` then runs the sign-in.
 */
export function openclawSetCommand(mcpUrl: string): string {
  const entry = JSON.stringify({ url: mcpUrl, transport: 'streamable-http', auth: 'oauth' });
  return `openclaw mcp set ${SERVER_NAME} '${entry}'`;
}

export const openclawLoginCommand = `openclaw mcp login ${SERVER_NAME}`;

/**
 * Hermes (Nous Research): an `mcp_servers` entry in `~/.hermes/config.yaml`
 * with `auth: oauth`, per Hermes' MCP docs; `hermesLoginCommand` then runs
 * the sign-in in the browser.
 */
export function hermesConfig(mcpUrl: string): string {
  return `mcp_servers:\n  ${SERVER_NAME}:\n    url: "${mcpUrl}"\n    auth: oauth`;
}

export const hermesLoginCommand = `hermes mcp login ${SERVER_NAME}`;

/** Everything the connect guide prints for one address, built on the server. */
export interface McpSnippets {
  url: string;
  /** The connector's listing in Claude's directory, or null where there is none (`claudeDirectoryUrl`). */
  claudeDirectory: string | null;
  claudeCode: string;
  codexAdd: string;
  codexLogin: string;
  openclawSet: string;
  openclawLogin: string;
  hermesConfig: string;
  hermesLogin: string;
  cursorDeeplink: string;
  cursorJson: string;
}

export function mcpSnippets(mcpUrl: string, claudeDirectory: string | null = null): McpSnippets {
  return {
    url: mcpUrl,
    claudeDirectory,
    claudeCode: claudeCodeCommand(mcpUrl),
    codexAdd: codexAddCommand(mcpUrl),
    codexLogin: codexLoginCommand,
    openclawSet: openclawSetCommand(mcpUrl),
    openclawLogin: openclawLoginCommand,
    hermesConfig: hermesConfig(mcpUrl),
    hermesLogin: hermesLoginCommand,
    cursorDeeplink: cursorDeeplink(mcpUrl),
    cursorJson: cursorMcpJson(mcpUrl),
  };
}

export function exportKeyCommand(): string {
  return `export ${API_KEY_ENV}="${KEY_PREFIX}your_key_here"`;
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

/** Every MCP tool, in the server's catalog order (`apps/api/src/mcp/tools.ts`). */
export const MCP_TOOLS: readonly ToolInfo[] = [
  { name: 'find_available_slots', kind: 'read', scope: 'availability:read', publicOk: true },
  { name: 'find_team_slots', kind: 'read', scope: 'availability:read', publicOk: true },
  { name: 'hold_slot', kind: 'write', scope: 'bookings:write', publicOk: true },
  { name: 'book_meeting', kind: 'write', scope: null, publicOk: true },
  { name: 'book_team_meeting', kind: 'write', scope: 'bookings:write', publicOk: true },
  { name: 'whoami', kind: 'read', scope: null, publicOk: false },
  { name: 'list_my_accounts', kind: 'read', scope: null, publicOk: false },
  { name: 'list_event_types', kind: 'read', scope: 'event-types:read', publicOk: false },
  { name: 'get_booking_page_link', kind: 'read', scope: 'event-types:read', publicOk: false },
  { name: 'list_bookings', kind: 'read', scope: 'bookings:read', publicOk: false },
  { name: 'list_pending_bookings', kind: 'read', scope: 'bookings:read', publicOk: false },
  { name: 'get_booking', kind: 'read', scope: 'bookings:read', publicOk: false },
  { name: 'create_booking', kind: 'write', scope: 'bookings:write', publicOk: false },
  { name: 'reschedule_booking', kind: 'destructive', scope: 'bookings:write', publicOk: false },
  { name: 'confirm_booking', kind: 'write', scope: 'bookings:write', publicOk: false },
  { name: 'decline_booking', kind: 'destructive', scope: 'bookings:write', publicOk: false },
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
