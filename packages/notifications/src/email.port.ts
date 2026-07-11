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
}
