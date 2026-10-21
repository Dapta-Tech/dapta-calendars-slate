/**
 * The workspace invitation email: an admin invited an address into their
 * account, and this tells that address how to get in.
 *
 * Built-in copy, EN and ES, not a per-account template: the reader is not a
 * booker, and the one thing the email must get right (which address to sign in
 * with, and where) is not something a template should be able to drop. The HTML
 * is the booking email's layout (`renderMemberInviteHtml`); the subject and the
 * plain-text part live here.
 */
import { renderMemberInviteHtml, type EmailGrowth } from './email-layout';
import type { EmailProvider } from './email.port';
import { LogOnlyEmailProvider } from './adapters/log-only';
import { NoopEmailProvider } from './adapters/noop';

/** What the outbox row carries: everything resolved at enqueue time. */
export interface MemberInviteNotification {
  accountId: string;
  /** The invited member (the row the invitation created). */
  memberId: string;
  /** The address the invitation is for. */
  email: string;
  workspaceName: string;
  /** Who sent it (the inviter's display name), when known. */
  inviterName: string | null;
  role: 'admin' | 'member';
  /** `{PUBLIC_APP_URL}/invite/{account code}`: sign in, then this workspace. */
  acceptUrl: string;
  locale: 'en' | 'es';
  /**
   * What tells one send from another for the provider's de-duplication: the
   * first invitation and each resend are distinct messages, a retry of either
   * is not.
   */
  sendKey: string;
}

export interface RenderedInvite {
  subject: string;
  text: string;
  html: string;
}

/** A subject is a header: no line breaks, and a sane length. */
function oneLine(s: string, max: number): string {
  const flat = String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Subject, plain text and HTML for one invitation. */
export function renderMemberInvite(n: MemberInviteNotification, growth: EmailGrowth = {}): RenderedInvite {
  const es = n.locale === 'es';
  const workspace = oneLine(n.workspaceName, 120);
  const inviter = n.inviterName ? oneLine(n.inviterName, 120) : null;
  const subject = inviter
    ? es
      ? `${inviter} te invitó a ${workspace}`
      : `${inviter} invited you to ${workspace}`
    : es
      ? `Te invitaron a ${workspace}`
      : `You’re invited to ${workspace}`;
  const role = n.role === 'admin' ? (es ? 'administrador' : 'an admin') : es ? 'miembro' : 'a member';
  const lead = inviter
    ? es
      ? `${inviter} te invitó a unirte a ${workspace} como ${role}.`
      : `${inviter} invited you to join ${workspace} as ${role}.`
    : es
      ? `Te invitaron a unirte a ${workspace} como ${role}.`
      : `You’re invited to join ${workspace} as ${role}.`;
  const text = [
    lead,
    '',
    es ? `Acepta la invitación: ${n.acceptUrl}` : `Accept the invitation: ${n.acceptUrl}`,
    '',
    es ? `Entra con ${n.email} para aceptar.` : `Sign in with ${n.email} to accept.`,
    es
      ? 'Si no esperabas esta invitación, puedes ignorar este correo.'
      : 'If you weren’t expecting this invitation, you can ignore this email.',
  ].join('\n');
  const html = renderMemberInviteHtml(
    { workspaceName: workspace, inviterName: inviter, role: n.role, email: n.email, acceptUrl: n.acceptUrl },
    n.locale,
    growth,
  );
  return { subject: oneLine(subject, 200), text, html };
}

/**
 * Whether this provider actually sends mail. The log-only default (every bare
 * fork) and noop resolve without delivering, so an admin there is told to pass
 * the word on themselves instead of reading "Invitation sent."
 */
export function deliversEmail(provider: EmailProvider): boolean {
  return !(provider instanceof LogOnlyEmailProvider || provider instanceof NoopEmailProvider);
}
