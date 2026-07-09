import type { EmailMessage, EmailProvider, EmailResult } from '../email.port';
import { normalizeRecipients } from '../util';

export interface HttpEmailOptions {
  /** The email-service endpoint to POST the message to. */
  endpoint: string;
  /** Optional bearer token for the endpoint. */
  token?: string;
  fromEmail: string;
  fromName?: string;
}

/**
 * Generic HTTP mailer adapter — POSTs a provider-agnostic JSON payload to an
 * external email service and treats a 2xx as delivered. This is the seam for
 * wiring the app to ANY managed send endpoint via configuration (the concrete
 * endpoint + auth live outside the public repo, in deployment config). No
 * provider is hardcoded here.
 *
 * A non-2xx response or a network error THROWS (the durable outbox worker
 * catches it and retries — B1/DM1); failures are never swallowed to
 * `delivered:false`, which would look like success and silently drop the mail.
 */
export class HttpEmailProvider implements EmailProvider {
  constructor(
    private readonly opts: HttpEmailOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    const to = normalizeRecipients(message.to);
    const payload = {
      from: message.from ?? this.opts.fromEmail,
      fromName: this.opts.fromName,
      to,
      replyTo: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
        encoding: typeof a.content === 'string' ? undefined : 'base64',
        contentType: a.contentType,
      })),
    };
    try {
      const res = await this.fetchImpl(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`http mailer failed: HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { messageId?: string };
      return { delivered: true, messageId: body.messageId, driver: 'http' };
    } catch (err) {
      // Surface the failure so the outbox worker retries (never a silent drop).
      throw err instanceof Error ? err : new Error(`http mailer failed: ${String(err)}`);
    }
  }
}
