import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailProvider, EmailResult } from '../email.port';
import { formatSender, normalizeRecipients } from '../util';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
}

/**
 * SMTP transport via nodemailer. A pooled transporter is created once and
 * reused. Delivery failures resolve with `delivered:false` (the caller decides
 * whether to retry) — a booking is never rolled back on an email failure.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly replyTo?: string;

  constructor(opts: SmtpOptions, transporter?: Transporter) {
    this.from = formatSender(opts.fromEmail, opts.fromName);
    this.replyTo = opts.replyTo;
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: opts.host,
        port: opts.port,
        secure: opts.secure,
        pool: true,
        auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
      });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const to = normalizeRecipients(message.to);
    try {
      const info = await this.transporter.sendMail({
        from: message.from ?? this.from,
        to,
        replyTo: message.replyTo ?? this.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      return { delivered: true, messageId: info.messageId, driver: 'smtp' };
    } catch {
      return { delivered: false, driver: 'smtp' };
    }
  }
}
