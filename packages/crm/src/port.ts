/**
 * The `CrmProvider` PORT — the boundary between the booking lifecycle and an
 * external CRM.
 *
 * WHY THIS PACKAGE MAY NAME A VENDOR: invariant R15 forbids naming a CALENDAR
 * vendor anywhere in this repo, and a reader who finds `hubspot` beside it will
 * reasonably try to "fix" the apparent violation. It is not one. ADR 0001
 * (`docs/adr/0001-crm-integrations-are-open-core-and-name-their-vendor.md`)
 * carves CRM out of R15: the whole integration is a public API plus a token the
 * END USER pastes, so there is no Dapta-side credential, contract, or
 * infrastructure name to protect. Read the ADR before changing this.
 *
 * The port takes the token PER CALL rather than holding it. That is what keeps
 * one provider instance serving every account in a deployment, and it is what
 * makes "the adapter never sees the encryption key" true by construction: the
 * key lives in `@slate/db`, which hands down plaintext and nothing else.
 */

/** Where a booking's data goes; the invitee is the lead, guests are not (#63). */
export interface CrmContactInput {
  token: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /**
   * H2 (#108): the host's MAPPED answers, already coerced to the strings this
   * provider wants. Absent or empty on an event type with no mappings, which
   * is every event type until a host configures one.
   *
   * These OVERWRITE whatever the properties held; identity never does
   * (ADR 0005). The adapter is what enforces the second half — an identity
   * property in this bag is dropped, no matter who assembled it.
   */
  properties?: Record<string, string>;
}

export interface CrmContactResult {
  contactId: string;
  /** False when the CRM already knew this email — its name was left untouched. */
  created: boolean;
}

export interface CrmMeetingInput {
  token: string;
  contactId: string;
  title: string;
  /** Pre-rendered plain text. The port does no formatting and no i18n. */
  body: string;
  startUtc: string;
  endUtc: string;
}

export interface CrmMeetingUpdate {
  token: string;
  meetingId: string;
  title?: string;
  body?: string;
  startUtc?: string;
  endUtc?: string;
  /** `scheduled` on create/reschedule, `canceled` on cancel. */
  outcome?: CrmMeetingOutcome;
}

export type CrmMeetingOutcome = 'scheduled' | 'canceled';

/**
 * One contact property as the provider's schema describes it (H2 / #108).
 *
 * The four exclusion flags travel RAW rather than pre-filtered: the port
 * reports what the portal says, and the caller decides what is offerable. That
 * keeps "which properties are unusable" one rule in one place instead of a
 * policy baked into every adapter.
 */
export interface CrmProperty {
  name: string;
  label: string;
  /** `string` | `number` | `bool` | `date` | `datetime` | `enumeration`. */
  type: string;
  /** `text` | `textarea` | `phonenumber` | `select` | `radio` | `checkbox` | … */
  fieldType: string;
  options: { value: string; label: string }[];
  archived: boolean;
  calculated: boolean;
  hidden: boolean;
  /** The provider computes this value; a write to it is refused. */
  readOnlyValue: boolean;
}

export interface CrmProvider {
  /** True when a real CRM is wired. False = the OSS default; nothing is enqueued. */
  readonly enabled: boolean;
  /** Human name for logs and health detail — never a secret. */
  readonly name: string;

  /**
   * The provider scope names a credential must carry, as the provider spells
   * them. The connect dialog renders this as its checklist (H1b / #93), so the
   * setup instructions a host follows and the permissions the adapter actually
   * needs are ONE list — they cannot drift, and no locale catalog can edit
   * them. Empty on a disabled provider.
   */
  readonly requiredScopes: readonly string[];

  /**
   * Connect-time probe: prove the credential works by USING it, before anything
   * is stored. Fail-closed — a token that cannot read is never persisted.
   * Throws `CrmAuthError` on 401/403.
   */
  verifyCredential(input: { token: string }): Promise<void>;

  /**
   * Search by email, then create ONLY if absent.
   *
   * Deliberately not an upsert. A booking is not the source of truth on a
   * lead's identity, and the vendor documents that partial upserts are not
   * supported when `email` is the id property for contacts — so an upsert keyed
   * by email WOULD overwrite the name on a contact the CRM already knows. The
   * extra call per booking is nothing at pilot volume (#63).
   */
  resolveContact(input: CrmContactInput): Promise<CrmContactResult>;

  /**
   * The contact properties this portal exposes (H2 / #108).
   *
   * Reads the SAME endpoint `verifyCredential` already probes, so mapping needs
   * no scope a connected credential does not already carry. Unfiltered — the
   * caller drops archived / calculated / hidden / read-only and identity.
   */
  listContactProperties(input: { token: string }): Promise<CrmProperty[]>;

  /** Create the meeting ASSOCIATED to the contact in the same call. */
  createMeeting(input: CrmMeetingInput): Promise<{ meetingId: string }>;

  /** Patch an existing meeting — cancel and reschedule, never a second meeting. */
  updateMeeting(input: CrmMeetingUpdate): Promise<void>;
}

/**
 * A credential problem: 401 (invalid or revoked) or 403 (missing scope).
 *
 * TERMINAL by design. Retrying cannot succeed, so the worker marks the
 * integration unhealthy and stops rather than burning attempts (#63).
 *
 * `requiredGranularScopes` is a scope NAME LIST, not prose — verified against a
 * live portal in #74, where a 403 came back with `category: "MISSING_SCOPES"`
 * and `errors[].context.requiredGranularScopes`. Carrying it structured is what
 * lets a UI name the exact checkbox the host missed.
 */
export class CrmAuthError extends Error {
  override readonly name = 'CrmAuthError';
  constructor(
    message: string,
    readonly status: number,
    readonly category: string | null = null,
    readonly requiredGranularScopes: string[] = [],
  ) {
    super(message);
  }
}

/**
 * The CRM rejected a property it does not have. Recoverable ONCE within a job
 * by dropping the named property and retrying — the error body identifies it.
 */
export class CrmPropertyError extends Error {
  override readonly name = 'CrmPropertyError';
  constructor(
    message: string,
    readonly propertyName: string | null,
  ) {
    super(message);
  }
}

/**
 * The OSS default. `enabled === false`, so `CrmEffects` enqueues nothing and a
 * bare clone behaves exactly as it did before this package existed. Every
 * method throws rather than silently succeeding: reaching one means something
 * bypassed the `enabled` check, and that should be loud.
 */
export class DisabledCrmProvider implements CrmProvider {
  readonly enabled = false;
  readonly name = 'disabled';
  /** Nothing to grant when nothing is wired. */
  readonly requiredScopes: readonly string[] = [];
  /**
   * REJECTS rather than throwing synchronously. These methods are typed
   * `Promise<…>`, and a caller that does `provider.createMeeting(…).catch(…)`
   * would sail straight past a sync throw — turning a wiring bug into an
   * unhandled rejection somewhere unrelated instead of a failed outbox row.
   */
  private unreachable<T>(): Promise<T> {
    return Promise.reject(new Error('no CRM provider is configured (CRM_PROVIDER=disabled)'));
  }
  verifyCredential(): Promise<void> {
    return this.unreachable();
  }
  resolveContact(): Promise<CrmContactResult> {
    return this.unreachable();
  }
  listContactProperties(): Promise<CrmProperty[]> {
    return this.unreachable();
  }
  createMeeting(): Promise<{ meetingId: string }> {
    return this.unreachable();
  }
  updateMeeting(): Promise<void> {
    return this.unreachable();
  }
}
