import type { EmailMessage } from './email.port';

/** Normalize `to` into a non-empty array of trimmed addresses, or throw. */
export function normalizeRecipients(to: EmailMessage['to']): string[] {
  const list = (Array.isArray(to) ? to : [to])
    .map((addr) => (typeof addr === 'string' ? addr.trim() : ''))
    .filter(Boolean);
  if (list.length === 0) {
    throw new Error('EmailMessage requires at least one recipient');
  }
  return list;
}

/** Format a `Name <email>` sender string, omitting the name when absent. */
export function formatSender(fromEmail: string, fromName?: string): string {
  return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
}
