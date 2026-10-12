/**
 * The HTML booking email, in the booking page's language: paper and ink, the
 * event's facts as a list, ONE primary button, and the product named only in a
 * quiet footer line when the deployment has a signup destination. The status
 * is a word with a dot, not a slab; there is no mono, no lime.
 *
 * Mail-safe on purpose: tables for layout, inline styles only, a bulletproof
 * button (a filled cell around the link, so clients that drop padding on `<a>`
 * still draw a button), a system font stack, a 520px column that reads at the
 * 600px most clients render at. Light only: a mail client's dark mode inverts a
 * light message reliably and a dark one badly.
 *
 * The plain-text part stays the user-editable template body (see
 * `renderTemplate`); this owns ONLY the HTML, driven by the template vars and
 * the email KIND (which fixes the status and the one action). Every
 * interpolated value is HTML-escaped: templates carry user and attendee text.
 *
 * The colours are the product's paper tokens (`@slate/shared/tokens.css`,
 * `[data-theme='light']`), restated because an email cannot read a
 * stylesheet; `email-layout.spec.ts` holds them to that file.
 */
import type { TemplateVarMap } from './templates';

export type EmailKind =
  | 'confirmation'
  | 'pending'
  | 'reschedule'
  | 'cancellation'
  | 'declined'
  | 'reminder'
  | 'follow_up';

export type Audience = 'attendee' | 'host';

/** Every built-in plus the open `{{form.*}}` tail; see TemplateVarMap. */
type Vars = TemplateVarMap;

/** What the deployment adds to the footer; absent = nothing about the product. */
export interface EmailGrowth {
  /** The signup destination, UTM-tagged. Null or absent: no "Made with" line. */
  signupUrl?: string | null;
}

export const EMAIL_COLORS = {
  ground: '#f2f2f3', // --muted
  paper: '#ffffff', // --background
  ink: '#1a1a1c', // --foreground
  muted: '#45454c', // --muted-foreground
  faint: '#67676f', // --faint
  border: '#e6e6e8', // --border
  signal: '#0e7a3f', // --signal-ink
  warning: '#8a5700', // --warning-ink
  destructive: '#cd2b31', // --destructive
  onInk: '#ffffff', // --primary-foreground
} as const;
const C = EMAIL_COLORS;

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A safe href: only http(s)/mailto; anything else collapses to '#'. */
function safeHref(url: string): string {
  const u = String(url ?? '').trim();
  return /^(https?:|mailto:)/i.test(u) ? esc(u) : '#';
}

/** The one primary action: an ink cell around the link (bulletproof). */
function button(label: string, href: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0;"><tr>` +
    `<td style="background:${C.ink};border-radius:10px;">` +
    `<a href="${safeHref(href)}" style="display:inline-block;padding:14px 24px;font-family:${FONT};` +
    `font-size:15px;font-weight:600;line-height:20px;color:${C.onInk};text-decoration:none;border-radius:10px;">` +
    `${esc(label)}</a></td></tr></table>`
  );
}

/** The status as the page says it: a dot and a word, in sentence case. */
function status(text: string, color: string): string {
  return (
    `<div style="font-size:13px;line-height:18px;font-weight:600;color:${color};margin:0 0 12px;">` +
    `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color};` +
    `margin:0 8px 1px 0;vertical-align:middle;"></span>${esc(text)}</div>`
  );
}

/** One fact. `valueHtml` is already escaped by the caller. */
function fact(label: string, valueHtml: string, first: boolean): string {
  const rule = first ? '' : `border-top:1px solid ${C.border};`;
  return (
    `<tr><td style="${rule}padding:12px 16px 12px 0;width:72px;vertical-align:top;font-size:13px;line-height:20px;color:${C.faint};">${esc(label)}</td>` +
    `<td style="${rule}padding:12px 0;vertical-align:top;font-size:15px;line-height:20px;color:${C.ink};font-weight:500;">${valueHtml}</td></tr>`
  );
}

const ES = (locale: string) => locale === 'es';

interface KindCopy {
  status: string;
  color: string;
  intro: string;
  /** The one action, or null when there is nothing to do. */
  action: { label: string; href: string } | null;
  note: string;
}

/** Status, intro and the one action per kind, EN and ES. */
function content(kind: EmailKind, v: Vars, locale: string, audience: Audience): KindCopy {
  const es = ES(locale);
  const host = v.host_name || (es ? 'el anfitrión' : 'the host');
  const who = audience === 'host' ? v.attendee_name || (es ? 'un invitado' : 'a guest') : host;
  const manage = v.manage_url
    ? { label: es ? 'Gestionar tu reserva' : 'Manage your booking', href: v.manage_url }
    : null;
  const again = v.booking_link
    ? { label: es ? 'Reservar otra hora' : 'Book another time', href: v.booking_link }
    : null;
  const reason = v.cancellation_reason
    ? es
      ? ` Motivo: ${v.cancellation_reason}`
      : ` Reason: ${v.cancellation_reason}`
    : '';

  switch (kind) {
    case 'confirmation':
      return {
        status: es ? 'Confirmada' : 'Confirmed',
        color: C.signal,
        intro: es
          ? `Tu reunión con ${who} quedó confirmada. La invitación de calendario va adjunta.`
          : `Your meeting with ${who} is confirmed. The calendar invite is attached.`,
        action: manage,
        note: manage
          ? es
            ? 'Desde tu reserva puedes reagendarla o cancelarla.'
            : 'From your booking you can reschedule or cancel it.'
          : '',
      };
    case 'reschedule':
      return {
        status: es ? 'Reagendada' : 'Rescheduled',
        color: C.signal,
        intro: es
          ? `Tu reunión con ${who} tiene una nueva hora. La invitación actualizada va adjunta.`
          : `Your meeting with ${who} has a new time. The updated invite is attached.`,
        action: manage,
        note: '',
      };
    case 'pending':
      // The host's copy of a request is a request TO them. It used to wear the
      // invitee's words ("We've sent your request to <you>") and the invitee's
      // "Cancel request" button over the invitee's own manage link, so the one
      // button in the host's mail withdrew the request they were asked to
      // accept. Confirming or declining happens in the host's bookings, not
      // through an invitee link, so the host copy carries no button.
      if (audience === 'host')
        return {
          status: es ? 'Por confirmar' : 'Needs your OK',
          color: C.warning,
          intro: es
            ? `${who} pidió esta hora. Confírmala o recházala desde tus reservas.`
            : `${who} asked for this time. Confirm or decline it from your bookings.`,
          action: null,
          note: '',
        };
      return {
        status: es ? 'Pendiente' : 'Pending',
        color: C.warning,
        intro: es
          ? `Enviamos tu solicitud a ${host}. Recibirás la confirmación cuando la acepte.`
          : `We sent your request to ${host}. You'll get a confirmation once it's accepted.`,
        action: v.manage_url
          ? { label: es ? 'Gestionar tu solicitud' : 'Manage your request', href: v.manage_url }
          : null,
        note: '',
      };
    case 'cancellation':
      return {
        status: es ? 'Cancelada' : 'Cancelled',
        color: C.destructive,
        intro: es
          ? `Tu reunión con ${who} fue cancelada.${reason}`
          : `Your meeting with ${who} was cancelled.${reason}`,
        action: again,
        note: '',
      };
    case 'declined':
      return {
        status: es ? 'No aceptada' : 'Not accepted',
        color: C.destructive,
        intro: es
          ? `${host} no pudo aceptar esta solicitud.${reason}`
          : `${host} couldn't accept this request.${reason}`,
        action: again,
        note: '',
      };
    case 'reminder':
      return {
        status: es ? 'Recordatorio' : 'Reminder',
        color: C.ink,
        intro: es ? `Un recordatorio de tu reunión con ${who}.` : `A reminder about your meeting with ${who}.`,
        action: manage,
        note: '',
      };
    case 'follow_up':
      return {
        status: es ? 'Gracias' : 'Thank you',
        color: C.ink,
        intro: es
          ? `Esperamos que tu reunión con ${who} haya salido bien.`
          : `We hope your meeting with ${who} went well.`,
        action: again,
        note: '',
      };
  }
}

/** Render the full HTML email for a booking notification. */
export function renderBrandedHtml(
  kind: EmailKind,
  vars: Vars,
  locale: string,
  audience: Audience = 'attendee',
  growth: EmailGrowth = {},
): string {
  const es = ES(locale);
  const c = content(kind, vars, locale, audience);
  const withLabel = audience === 'host' ? (es ? 'Invitado' : 'Guest') : es ? 'Con' : 'With';
  const withValue = audience === 'host' ? vars.attendee_name : vars.host_name;

  // The meeting is still ahead on these kinds, so its link is part of WHERE:
  // a link in the facts, not a second button competing with the one action.
  const meetingAhead = kind === 'confirmation' || kind === 'reschedule' || kind === 'reminder';
  const join =
    meetingAhead && vars.meeting_url
      ? `<a href="${safeHref(vars.meeting_url)}" style="color:${C.ink};text-decoration:underline;">${esc(es ? 'Unirse a la reunión' : 'Join the meeting')}</a>`
      : '';
  const where = [esc(vars.location), join].filter(Boolean).join('<br>');
  const before =
    kind === 'reschedule' && vars.previous_start_time
      ? `<span style="color:${C.faint};text-decoration:line-through;">${esc(vars.previous_start_time)}</span>`
      : '';

  const rows: Array<[string, string]> = [
    [es ? 'Cuándo' : 'When', esc(vars.start_time)],
    [es ? 'Antes' : 'Was', before],
    [withLabel, esc(withValue)],
    [es ? 'Dónde' : 'Where', where],
  ];
  const facts = rows
    .filter(([, html]) => html)
    .map(([label, html], i) => fact(label, html, i === 0))
    .join('');

  // The product is named once, and only where the deployment points somewhere
  // (the same switch as the page's badge). The host's own copy never carries it.
  const signup = audience === 'attendee' ? growth.signupUrl : null;
  const madeWith = signup
    ? `<div style="margin:0 0 6px;">${esc(es ? 'Hecho con Dapta Calendars' : 'Made with Dapta Calendars')} · ` +
      `<a href="${safeHref(signup)}" style="color:${C.ink};text-decoration:underline;">${esc(es ? 'Crea tu calendario gratis' : 'Create your free calendar')}</a></div>`
    : '';
  const auto = es ? 'Este es un mensaje automático.' : 'This is an automated message.';
  const help = es ? '¿Necesitas ayuda?' : 'Need help?';

  return `<div style="margin:0;padding:32px 12px;background:${C.ground};font-family:${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
    <tr><td style="background:${C.paper};border:1px solid ${C.border};border-radius:16px;padding:32px 28px;">
      ${status(c.status, c.color)}
      <div style="color:${C.ink};font-size:24px;font-weight:700;line-height:30px;letter-spacing:-0.01em;margin:0 0 8px;">${esc(vars.event_title)}</div>
      <div style="color:${C.muted};font-size:15px;line-height:22px;margin:0 0 20px;">${esc(c.intro)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};">
        ${facts}
      </table>
      ${c.action ? button(c.action.label, c.action.href) : ''}
      ${c.note ? `<div style="color:${C.faint};font-size:13px;line-height:20px;margin-top:16px;">${esc(c.note)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:20px 8px 4px;color:${C.faint};font-size:12px;line-height:18px;text-align:center;">
      ${madeWith}<div>${auto} ${help} <a href="mailto:support@daptatech.com" style="color:${C.faint};">support@daptatech.com</a></div>
    </td></tr>
  </table>
</div>`;
}
