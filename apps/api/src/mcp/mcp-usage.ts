import { Logger } from '@nestjs/common';
import { SCRUB_RULES, scrubErrorText, type AnalyticsProps } from '@slate/shared';
import { analyticsLabel, type AnalyticsEffects, type RawCaptureInput } from '../analytics-effects';
import { header, type ReqLike } from '../auth.provider';
import { signInKey, untrusted, type McpCall, type McpClientInfo, type ToolFailure } from './support';

/** The vendor's name for one tool call in its MCP analytics. */
export const MCP_TOOL_CALL_EVENT = '$mcp_tool_call';

/**
 * The server name on the event. Not the protocol's `serverInfo.name`: it is
 * cased like the other Dapta MCPs that report into the same project (`dForms`,
 * `Dapta`), so the MCP screens split them by this property.
 */
export const MCP_ANALYTICS_SERVER_NAME = 'dCal';

/** Who an anonymous call (a public booking tool, no credential) is filed under. Never an address. */
export const MCP_ANONYMOUS_DISTINCT_ID = 'dcal-mcp-anonymous';

/** How long a resolved identity is reused before it is read again. */
const IDENTITY_TTL_MS = 5 * 60_000;

/** At most this many identities are remembered; the oldest go first. */
const IDENTITY_CACHE_MAX = 2_000;

/**
 * What a client's name or version may look like to be sent as given: letters,
 * digits, spaces and `._()+-`, with an optional npm scope in front
 * (`@modelcontextprotocol/inspector`). No `:` or other `/`, so no port or
 * path fits, and see `HOST_SHAPED`. Anything else is sent as `other`.
 */
const CLIENT_LABEL = /^(?:@[A-Za-z0-9._-]{1,40}\/)?[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/;

/** A dot before a letter (`example.com`, `x.xn--p1ai`) or a punycode label: a host name, never sent. */
const HOST_SHAPED = /\.[A-Za-z]|xn--/i;

/**
 * The only part of a user agent that is kept: product tokens, a name with no
 * dot (so never a host) then a dotted numeric version with at most a
 * pre-release tag (`claude-code/2.1.0`, `Mozilla/5.0`,
 * `mcp-remote/1.0.0-beta.1`). Comments, bare words, hosts, ports, paths, free
 * suffixes and anything else are dropped, so free text has nowhere to go.
 */
const PRODUCT_TOKEN =
  /^[A-Za-z][A-Za-z0-9_+-]{0,39}\/\d{1,8}(?:\.\d{1,8}){0,4}(?:[-+](?:alpha|beta|rc|dev|pre|preview|canary|nightly|next|build)(?:\.?\d{1,8})?)?$/;

/** An IPv4 address, not part of a longer dotted number (`Chrome/120.0.6099.109` stays). */
const IPV4_IN_TEXT = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;

/** An IPv6 address, full or compressed (`2001:db8::1`, `::1`). */
const IPV6_IN_TEXT = /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;

/** Longest user agent sent. */
const USER_AGENT_MAX = 200;

/**
 * The error scrubber's rules minus the two that read version numbers as
 * phone or account numbers (`Chrome/120.0.6099.109`): a user agent is mostly
 * version numbers.
 */
const USER_AGENT_RULES = SCRUB_RULES.filter((rule) => rule.name !== 'phone-national' && rule.name !== 'digit-run');

/**
 * Client text with IP addresses and whatever the error scrubber's `rules`
 * recognize (keys and tokens, email addresses, phones) replaced. A second
 * line behind the allowlists above, which already leave no room for a URL,
 * a host with a path or an email address.
 */
function redactClientText(text: string, rules: typeof SCRUB_RULES): string {
  return scrubErrorText(text.replace(IPV6_IN_TEXT, '[ip]').replace(IPV4_IN_TEXT, '[ip]'), rules);
}

/**
 * A client's name or version, from the caller and so untrusted: sent as given
 * only when it fits `CLIENT_LABEL`, is not host-shaped and nothing in it is
 * redacted (an IP address, a long number, a key), else `other`. Undefined
 * when it is missing.
 */
export function clientLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const plain = CLIENT_LABEL.test(text) && !HOST_SHAPED.test(text) && redactClientText(text, SCRUB_RULES) === text;
  return plain ? text : 'other';
}

/**
 * A `User-Agent`, from the caller and so untrusted, reduced to its product
 * tokens (`PRODUCT_TOKEN`): invisible, bidi and control characters go first,
 * then everything that is not a product token, then IP addresses and keys,
 * then it is cut to 200 characters. Undefined when no product token is left.
 */
export function userAgentLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = untrusted(value, USER_AGENT_MAX * 4)
    .split(/[\s();,]+/)
    .filter((token) => PRODUCT_TOKEN.test(token) && !HOST_SHAPED.test(token));
  const clean = redactClientText(tokens.join(' '), USER_AGENT_RULES).slice(0, USER_AGENT_MAX).trim();
  return clean || undefined;
}

/**
 * The client a request came from, from the request alone: `clientInfo` on an
 * `initialize`, or the per-request envelope (`_meta`) a 2026-07-28 client
 * sends with every message, plus the `User-Agent` and a vendor header. Only
 * names and versions are read; the rest of the body is never looked at here.
 * For usage analytics only: nothing here is trusted or decides access.
 */
export function clientInfoOf(req: ReqLike & { body?: unknown }): McpClientInfo {
  const params = (req.body as { params?: { clientInfo?: unknown; _meta?: Record<string, unknown> } } | undefined)?.params;
  const meta = params?._meta?.['io.modelcontextprotocol/clientInfo'];
  const info = (params?.clientInfo ?? meta) as { name?: unknown; version?: unknown } | undefined;
  const agent = header(req, 'user-agent') ?? '';
  const vendor = header(req, 'x-anthropic-client')?.trim() || /\b(anthropic|claude)/i.test(agent)
    ? 'anthropic'
    : Object.keys(req.headers).some((h) => h.toLowerCase().startsWith('openai-')) || /\bopenai\b/i.test(agent)
      ? 'openai'
      : undefined;
  const client: McpClientInfo = {};
  const name = clientLabel(info && typeof info === 'object' ? info.name : undefined);
  const version = clientLabel(info && typeof info === 'object' ? info.version : undefined);
  const userAgent = userAgentLabel(agent);
  if (name) client.name = name;
  if (version) client.version = version;
  if (userAgent) client.userAgent = userAgent;
  if (vendor) client.vendor = vendor;
  return client;
}

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
  /**
   * A sign-in through an external server that acted in no account: its hashed
   * per-person id (`signInKey`, the namespace of its holds and rate limits),
   * never the server's raw subject.
   */
  signInId: string | null;
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
    signInId: !principal && login ? signInKey(login) : null,
  };
}

interface Cached {
  value: Promise<unknown>;
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
 * id or an account name. A call refused as RATE_LIMITED is never reported: it
 * is not usage, and one request can carry a whole batch of them.
 *
 * Who it is about:
 *  - a credential acting as a member (an OAuth connection, or a sign-in in an
 *    account): the member's email, like every other server event, grouped by
 *    the account's code. No email on file: dropped;
 *  - an API key (it belongs to an account, not a member): its public handle, grouped
 *    by the account, with `$process_person_profile: false`;
 *  - a sign-in that acted in no account: its hashed per-person id
 *    (`signInKey`), with `$process_person_profile: false`;
 *  - no credential: one constant id, with `$process_person_profile: false`.
 *
 * Identities are read once and reused for a few minutes, so a burst of calls
 * does not cost a query each (concurrent misses share one read). A member
 * with no email is remembered; one that could not be read, or a read that
 * failed, is not. Never an address or anything derived from one.
 *
 * `report` never rejects and the gateway never awaits it: a slow or failing
 * database or vendor cannot slow or fail a tool call. With analytics off (no
 * provider, every bare fork) it returns before reading anything.
 */
export class McpUsageReporter {
  private readonly log = new Logger('McpUsage');
  private readonly identities = new Map<string, Cached>();

  constructor(
    private readonly analytics: AnalyticsEffects | null,
    private readonly serverVersion: string,
    private readonly clock: () => number = Date.now,
  ) {}

  async report(event: McpToolCallEvent): Promise<void> {
    const analytics = this.analytics;
    if (!analytics?.enabled) return;
    if (event.errorCode === 'RATE_LIMITED') return;
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
      if (!event.ok && event.errorCode) properties.$mcp_error_type = analyticsLabel(event.errorCode);
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
      const member = await this.cached(
        `member:${accountId}:${memberId}`,
        () => analytics.memberIdentity(accountId, memberId, MCP_TOOL_CALL_EVENT),
        (found) => found !== 'unreadable',
      );
      // No email on file (or not readable now): dropped, never sent under a
      // made-up id that would merge unrelated people (the rule every host
      // event follows).
      if (typeof member === 'string') return null;
      return {
        input: { distinctId: member.email, accountId, accountKey: member.accountKey, isInternal: member.isInternal },
        personless: false,
      };
    }
    if (event.accountId && event.keyPrefix) {
      const { accountId } = event;
      const account = await this.cached(
        `account:${accountId}`,
        () => analytics.accountIdentity(accountId),
        (found) => found !== null,
      );
      if (!account) return null;
      return {
        input: { distinctId: event.keyPrefix, accountId, accountKey: account.accountKey, isInternal: account.isInternal },
        personless: true,
      };
    }
    const distinctId = event.signInId ?? MCP_ANONYMOUS_DISTINCT_ID;
    return { input: { distinctId, accountId: null, accountKey: null, isInternal: false }, personless: true };
  }

  /**
   * The read behind `key`, shared while it is fresh. The promise is kept, not
   * its value, so concurrent misses cost one read; it is forgotten when the
   * read fails or its answer is not worth keeping (`keep`).
   */
  private cached<T>(key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> {
    const now = this.clock();
    const hit = this.identities.get(key);
    if (hit && hit.expiresAt > now) return hit.value as Promise<T>;
    const value: Promise<T> = Promise.resolve()
      .then(load)
      .then(
        (found) => {
          if (!keep(found)) this.forget(key, value);
          return found;
        },
        (err: unknown) => {
          this.forget(key, value);
          throw err;
        },
      );
    this.identities.delete(key);
    if (this.identities.size >= IDENTITY_CACHE_MAX) {
      const oldest = this.identities.keys().next().value;
      if (oldest !== undefined) this.identities.delete(oldest);
    }
    this.identities.set(key, { value, expiresAt: now + IDENTITY_TTL_MS });
    return value;
  }

  /** Drops `key` only while it still holds this read, never a newer one. */
  private forget(key: string, value: Promise<unknown>): void {
    if (this.identities.get(key)?.value === value) this.identities.delete(key);
  }
}
