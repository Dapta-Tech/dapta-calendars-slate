import { Logger } from '@nestjs/common';
import type { AnalyticsProps } from '@slate/shared';
import type { AccountIdentity, AnalyticsEffects, HostIdentity, RawCaptureInput } from '../analytics-effects';
import type { McpCall, McpClientInfo, ToolFailure } from './support';

/** The vendor's name for one tool call in its MCP analytics. */
export const MCP_TOOL_CALL_EVENT = '$mcp_tool_call';

/**
 * The server name on the event. Not the protocol's `serverInfo.name`
 * (`dapta-calendars`): it is cased like the other Dapta MCPs that report into
 * the same project (`dForms`, `Dapta`), so the MCP screens split them by this
 * property.
 */
export const MCP_ANALYTICS_SERVER_NAME = 'dCal';

/** Who an anonymous call (a public booking tool, no credential) is filed under. Never an address. */
export const MCP_ANONYMOUS_DISTINCT_ID = 'dcal-mcp-anonymous';

/** How long a resolved identity is reused before it is read again. */
const IDENTITY_TTL_MS = 5 * 60_000;

/** At most this many identities are remembered; the oldest go first. */
const IDENTITY_CACHE_MAX = 2_000;

/**
 * One finished tool call, as usage reporting sees it. Built from the same
 * facts as the audit line and less: never the arguments (not even their
 * hash), the result, an error message, an affected booking, a name or an
 * email, and never the caller's address.
 */
export interface McpToolCallEvent {
  tool: string;
  ok: boolean;
  /** The failure code (`NOT_FOUND`, `TIMEOUT`, ...) when the call failed. */
  errorCode: string | null;
  durationMs: number;
  protocolVersion: string;
  client: McpClientInfo;
  /** How the caller authenticated: an API key, an OAuth connection or sign-in, or nothing. */
  credentialType: 'api_key' | 'oauth' | 'none';
  /** The account the call acted in, null when it acted in none. */
  accountId: string | null;
  /** The member the call acted as; null for an API key (keys belong to the account) or with no account. */
  memberId: string | null;
  /** A credential acting in an account as no member (an API key): its public `dcl_<8hex>` handle. */
  keyPrefix: string | null;
  /** A sign-in through an external server that acted in no account: the person there (`sub`). */
  subject: string | null;
}

/**
 * The usage event of one tool call. `call` is the call as the tool ran it
 * (after `account_id` picked an account), so a sign-in that named one is
 * reported in that account.
 */
export function toolCallEvent(tool: string, call: McpCall, failure: ToolFailure | undefined, durationMs: number): McpToolCallEvent {
  const principal = call.principal;
  const login = call.login;
  return {
    tool,
    ok: !failure,
    errorCode: failure?.code ?? null,
    durationMs,
    protocolVersion: call.protocolVersion,
    client: { ...call.client },
    credentialType: principal ? (principal.kind === 'oauth' ? 'oauth' : 'api_key') : login ? 'oauth' : 'none',
    accountId: principal?.accountId ?? null,
    memberId: principal?.memberId ?? null,
    keyPrefix: principal && !principal.memberId ? principal.prefix : null,
    subject: !principal && login ? login.token.subject : null,
  };
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/**
 * Reports each MCP tool call to product analytics as one `$mcp_tool_call`, in
 * the vocabulary PostHog's MCP analytics reads (the same one dForms and
 * Dapta's own MCP server send), so the MCPs land on the same screens, told
 * apart by `$mcp_server_name` (`dCal`) and `product` (`calendars`).
 *
 * What it sends is fixed here and nowhere else: the tool's name, whether it
 * failed and with which code, how long it took, the protocol version, the
 * client's name, version and user agent, the server, how the caller signed in
 * and whether the call was internal. Never the arguments (not even their
 * hash), the result, an error message, an invitee's name or email, a booking
 * id or an account name.
 *
 * Who it is about:
 *  - a credential acting as a member (an OAuth connection, or a sign-in in an
 *    account): the member's email, like every other server event, grouped by
 *    the account's code. No email on file: dropped;
 *  - an API key (an account's, no member's): the key's public handle, grouped
 *    by the account, with `$process_person_profile: false`;
 *  - a sign-in that acted in no account: the person's id at the external
 *    server, with `$process_person_profile: false`;
 *  - no credential: one constant id, with `$process_person_profile: false`.
 *
 * Identities are read once and reused for a few minutes, so a burst of calls
 * does not cost a query each. Never an address or anything derived from one.
 *
 * `report` never rejects and the gateway never awaits it: a slow or failing
 * database or vendor cannot slow or fail a tool call. With analytics off (no
 * provider, every bare fork) it returns before reading anything.
 */
export class McpUsageReporter {
  private readonly log = new Logger('McpUsage');
  private readonly identities = new Map<string, Cached<HostIdentity | AccountIdentity | null>>();

  constructor(
    private readonly analytics: AnalyticsEffects | null,
    private readonly serverVersion: string,
    private readonly clock: () => number = Date.now,
  ) {}

  async report(event: McpToolCallEvent): Promise<void> {
    const analytics = this.analytics;
    if (!analytics?.enabled) return;
    try {
      const properties: AnalyticsProps = {
        $mcp_tool_name: event.tool,
        // The vendor's SDK repeats the tool name here on a tool call; dForms and Dapta's MCP send it too.
        $mcp_resource_name: event.tool,
        $mcp_is_error: !event.ok,
        $mcp_duration_ms: event.durationMs,
        $mcp_protocol_version: event.protocolVersion,
        $mcp_server_name: MCP_ANALYTICS_SERVER_NAME,
        $mcp_server_version: this.serverVersion,
        $mcp_source: 'posthog_mcp_analytics',
        credential_type: event.credentialType,
      };
      if (!event.ok && event.errorCode) properties.$mcp_error_type = event.errorCode.toLowerCase();
      if (event.client.name) properties.$mcp_client_name = event.client.name;
      if (event.client.version) properties.$mcp_client_version = event.client.version;
      if (event.client.userAgent) properties.$mcp_client_user_agent = event.client.userAgent;
      if (event.client.vendor) properties.$mcp_vendor_client = event.client.vendor;

      const who = await this.who(analytics, event);
      if (!who) return;
      if (who.personless) properties.$process_person_profile = false;
      // dForms' name for the same fact, so one cross-product MCP filter drops staff from both.
      properties.staff_access = who.input.isInternal;
      await analytics.captureRaw(MCP_TOOL_CALL_EVENT, { ...who.input, properties }, this.clock());
    } catch (err) {
      this.log.error(`failed to report MCP tool call: ${String(err)}`);
    }
  }

  /** Who the event is about, or null to drop it. */
  private async who(
    analytics: AnalyticsEffects,
    event: McpToolCallEvent,
  ): Promise<{ input: Omit<RawCaptureInput, 'properties'>; personless: boolean } | null> {
    if (event.accountId && event.memberId) {
      const { accountId, memberId } = event;
      const member = await this.cached(`member:${accountId}:${memberId}`, () =>
        analytics.memberIdentity(accountId, memberId, MCP_TOOL_CALL_EVENT),
      );
      // No email on file: dropped, never sent under a made-up id that would
      // merge unrelated people (the rule every host event follows).
      if (!member) return null;
      return {
        input: { distinctId: member.email, accountId, accountKey: member.accountKey, isInternal: member.isInternal },
        personless: false,
      };
    }
    if (event.accountId && event.keyPrefix) {
      const { accountId } = event;
      const account = await this.cached(`account:${accountId}`, () => analytics.accountIdentity(accountId));
      if (!account) return null;
      return {
        input: { distinctId: event.keyPrefix, accountId, accountKey: account.accountKey, isInternal: account.isInternal },
        personless: true,
      };
    }
    const distinctId = event.subject ?? MCP_ANONYMOUS_DISTINCT_ID;
    return { input: { distinctId, accountId: null, accountKey: null, isInternal: false }, personless: true };
  }

  private async cached<T extends HostIdentity | AccountIdentity | null>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.clock();
    const hit = this.identities.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
    const value = await load();
    this.identities.delete(key);
    if (this.identities.size >= IDENTITY_CACHE_MAX) {
      const oldest = this.identities.keys().next().value;
      if (oldest !== undefined) this.identities.delete(oldest);
    }
    this.identities.set(key, { value, expiresAt: now + IDENTITY_TTL_MS });
    return value;
  }
}
