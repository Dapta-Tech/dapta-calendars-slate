/**
 * The EmailProvider port — the boundary every caller depends on. Concrete
 * transports (log-only, smtp, http, …) are selected by configuration, never
 * imported directly by application code. Adding a provider means adding an
 * adapter behind this interface; callers never change.
 */

/** Which transport actually handled (or would handle) the message. */
export type EmailDriver = 'log-only' | 'noop' | 'smtp' | 'http';

export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  /** MIME type, e.g. `text/calendar; method=REQUEST; charset=utf-8`. */
  contentType?: string;
}

export interface EmailMessage {
  /** Tenant context asserted by the authenticated backend, never by a browser. */
  accountId?: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  /** Override the configured sender (rare). */
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /**
   * Stable, event-specific de-duplication key. The BookingNotifier sets one per
   * message so a retried delivery (same booking + same lifecycle event) is
   * de-duplicated by a managed service, while distinct events (e.g. two separate
   * reschedules to different times) get distinct keys. The generic wire ignores
   * it; the `transactional-v1` profile forwards it as `idempotencyKey`.
   */
  idempotencyKey?: string;
  /**
   * The recipient's language (`en`, `es`), for whatever the transport adds to
   * the message itself: a managed service's support footer. The content is
   * already written in it. The generic wire ignores it.
   */
  locale?: string;
}

export interface EmailResult {
  /** True when actually dispatched; false for log-only/noop. */
  delivered: boolean;
  messageId?: string;
  driver: EmailDriver;
}

export interface EmailProvider {
  /**
   * Deliver one email. Implementations resolve with `delivered:false` for an
   * ordinary failure they can report; they throw only for programmer errors
   * (e.g. a message with no recipient). A booking is never rolled back on an
   * email failure — the caller decides whether to retry.
   */
  send(message: EmailMessage): Promise<EmailResult>;
  /**
   * True when the transport cannot deliver without a tenant (`accountId`) —
   * only the signed transactional wire today. Callers use this to decide
   * whether a legacy queue row missing its account context can still be sent
   * (smtp/log-only/noop: yes) or must be skipped. Absent = false.
   */
  readonly requiresAccountContext?: boolean;
  /**
   * True when the transport appends its own support footer to every message,
   * one the caller cannot remove (the managed transactional wire). The booking
   * layout then leaves its own "Need help?" line out, so a reader gets one
   * support footer, not two. Absent = false: SMTP and the rest keep the line.
   */
  readonly addsSupportFooter?: boolean;
  /**
   * False for a transport that never delivers anything (log-only, noop): a
   * caller that would rely on this service's email reaching someone (the
   * calendar write muting the provider's own invitation) must not. Absent =
   * a real transport.
   */
  readonly delivers?: boolean;
}
