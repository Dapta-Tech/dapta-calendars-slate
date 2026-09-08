/**
 * Branded HTML layout for booking emails — a simple, well-designed shell around
 * the structured booking data (Felipe-approved 2026-07-15). Light theme for
 * broad client compatibility, with Dapta's lime accent (--primary #cbe84f).
 *
 * The plain-text part stays the user-editable template body (see
 * `renderTemplate`); this owns ONLY the HTML rendering, driven by the template
 * vars + the email KIND (which fixes the status badge + call-to-action set).
 * All interpolated values are HTML-escaped — templates carry user/attendee text.
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

/** Every built-in plus the open `{{form.*}}` tail — see TemplateVarMap. */
type Vars = TemplateVarMap;

const LIME = '#cbe84f';
const INK = '#1a1a1c';
const BG = '#f4f4f5';
const CARD = '#ffffff';
const MUTED = '#6a6a6c';
const BORDER = '#e6e6e8';

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

function button(label: string, href: string, primary = true): string {
  const style = primary
    ? `background:${LIME};color:${INK};border:1px solid ${LIME};`
    : `background:#ffffff;color:${INK};border:1px solid ${BORDER};`;
  return (
    `<a href="${safeHref(href)}" style="display:inline-block;padding:11px 20px;margin:0 6px 8px 0;` +
    `border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;${style}">${esc(label)}</a>`
  );
}

function badge(text: string, color: string, bg: string): string {
  return (
    `<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;` +
    `font-weight:700;letter-spacing:.02em;color:${color};background:${bg};">${esc(text)}</span>`
  );
}

function detailRow(label: string, value: string): string {
  if (!value) return '';
  return (
    `<tr><td style="padding:7px 0;color:${MUTED};font-size:13px;width:78px;vertical-align:top;">${esc(label)}</td>` +
    `<td style="padding:7px 0;color:${INK};font-size:14px;font-weight:500;">${esc(value)}</td></tr>`
  );
}

const ES = (locale: string) => locale === 'es';

/** Badge + heading + intro + CTA set per kind (localized EN/ES). */
function content(kind: EmailKind, v: Vars, locale: string, audience: Audience) {
  const es = ES(locale);
  const host = v.host_name || (es ? 'el anfitrión' : 'the host');
  const who = audience === 'host' ? v.attendee_name || (es ? 'un invitado' : 'a guest') : host;
  const manage = v.manage_url;
  const again = v.booking_link;
  const GREEN = { c: '#274d00', b: '#e8f7b0' };
  const AMBER = { c: '#7a5b00', b: '#fbeeb8' };
  const RED = { c: '#7a1f1f', b: '#f7d9d9' };

  const reschedule = button(es ? 'Reagendar' : 'Reschedule', manage, true);
  const cancel = button(es ? 'Cancelar' : 'Cancel', manage, false);
  const bookAgain = button(es ? 'Reservar otra hora' : 'Book another time', again, true);

  switch (kind) {
    case 'confirmation':
      return {
        badge: badge(es ? 'CONFIRMADA' : 'CONFIRMED', GREEN.c, GREEN.b),
        heading: es ? 'Reserva confirmada' : "You're booked in",
        intro: es
          ? `Tu reunión con ${who} quedó confirmada. Adjuntamos la invitación de calendario — ábrela para agregar el evento.`
          : `Your meeting with ${who} is confirmed. We've attached a calendar invite — open it to add the event.`,
        ctas: manage ? reschedule + cancel : '',
        note: es ? 'La invitación de calendario (invite.ics) va adjunta.' : 'The calendar invite (invite.ics) is attached.',
      };
    case 'reschedule':
      return {
        badge: badge(es ? 'REAGENDADA' : 'RESCHEDULED', GREEN.c, GREEN.b),
        heading: es ? 'Nueva hora confirmada' : 'New time confirmed',
        intro: es
          ? `Tu reunión con ${who} se movió a una nueva hora. Invitación actualizada adjunta.`
          : `Your meeting with ${who} was moved to a new time. Updated invite attached.`,
        ctas: manage ? reschedule + cancel : '',
        note: es ? 'La invitación actualizada va adjunta.' : 'The updated calendar invite is attached.',
      };
    case 'pending':
      return {
        badge: badge(es ? 'PENDIENTE' : 'PENDING', AMBER.c, AMBER.b),
        heading: es ? 'Solicitud recibida' : 'Request received',
        intro: es
          ? `Enviamos tu solicitud a ${host}. Recibirás la confirmación cuando la acepte.`
          : `We've sent your request to ${host}. You'll get a confirmation once it's accepted.`,
        ctas: manage ? button(es ? 'Cancelar solicitud' : 'Cancel request', manage, false) : '',
        note: '',
      };
    case 'cancellation':
      return {
        badge: badge(es ? 'CANCELADA' : 'CANCELLED', RED.c, RED.b),
        heading: es ? 'Esta reunión fue cancelada' : 'This meeting was cancelled',
        intro: es
          ? `Tu reunión con ${who} fue cancelada.${v.cancellation_reason ? ` Motivo: ${v.cancellation_reason}` : ''}`
          : `Your meeting with ${who} has been cancelled.${v.cancellation_reason ? ` Reason: ${v.cancellation_reason}` : ''}`,
        ctas: again ? bookAgain : '',
        note: '',
      };
    case 'declined':
      return {
        badge: badge(es ? 'RECHAZADA' : 'DECLINED', RED.c, RED.b),
        heading: es ? 'Solicitud no aceptada' : 'Request not accepted',
        intro: es
          ? `${host} no pudo aceptar esta solicitud.${v.cancellation_reason ? ` Motivo: ${v.cancellation_reason}` : ''}`
          : `${host} couldn't accept this request.${v.cancellation_reason ? ` Reason: ${v.cancellation_reason}` : ''}`,
        ctas: again ? bookAgain : '',
        note: '',
      };
    case 'reminder':
      return {
        badge: badge(es ? 'RECORDATORIO' : 'REMINDER', GREEN.c, GREEN.b),
        heading: es ? 'Tu reunión es pronto' : 'Your meeting starts soon',
        intro: es ? `Un recordatorio de tu reunión con ${who}.` : `A quick reminder about your meeting with ${who}.`,
        ctas: manage ? reschedule : '',
        note: '',
      };
    case 'follow_up':
      return {
        badge: badge(es ? 'GRACIAS' : 'THANK YOU', GREEN.c, GREEN.b),
        heading: es ? 'Gracias por tu tiempo' : 'Thanks for your time',
        intro: es ? `Esperamos que tu reunión con ${who} haya salido bien.` : `We hope your meeting with ${who} went well.`,
        ctas: again ? bookAgain : '',
        note: '',
      };
  }
}

/** Render the full branded HTML email for a booking notification. */
export function renderBrandedHtml(
  kind: EmailKind,
  vars: Vars,
  locale: string,
  audience: Audience = 'attendee',
): string {
  const es = ES(locale);
  const c = content(kind, vars, locale, audience);
  const withLabel = audience === 'host' ? (es ? 'Invitado' : 'Guest') : es ? 'Con' : 'With';
  const withValue = audience === 'host' ? vars.attendee_name : vars.host_name;
  const details =
    detailRow(es ? 'Cuándo' : 'When', vars.start_time) +
    detailRow(withLabel, withValue) +
    detailRow(es ? 'Dónde' : 'Where', vars.location);
  const help = es ? '¿Necesitas ayuda?' : 'Need help?';
  const auto = es
    ? 'Mensaje automático de Dapta Calendars.'
    : 'Automated message from Dapta Calendars.';

  return `<div style="margin:0;padding:24px 12px;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;">
    <tr><td style="padding:2px 4px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:30px;height:30px;background:${LIME};border-radius:8px;text-align:center;vertical-align:middle;color:${INK};font-weight:800;font-size:17px;">D</td>
        <td style="padding-left:10px;color:${INK};font-weight:700;font-size:16px;">Dapta Calendars</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:${CARD};border:1px solid ${BORDER};border-radius:16px;padding:28px 26px;">
      <div style="margin-bottom:14px;">${c.badge}</div>
      <div style="color:${MUTED};font-size:13px;font-weight:600;letter-spacing:.02em;margin:0 0 4px;">${esc(c.heading)}</div>
      <div style="color:${INK};font-size:22px;font-weight:700;line-height:1.25;margin:0 0 8px;">${esc(vars.event_title)}</div>
      <div style="color:${MUTED};font-size:14px;line-height:1.5;margin:0 0 18px;">${esc(c.intro)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};margin:0 0 20px;">
        ${details}
      </table>
      ${c.ctas ? `<div>${c.ctas}</div>` : ''}
      ${c.note ? `<div style="color:${MUTED};font-size:12px;line-height:1.5;margin-top:16px;">${esc(c.note)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:18px 6px 4px;color:#9a9a9c;font-size:12px;line-height:1.5;">
      ${auto} ${help} <a href="mailto:support@daptatech.com" style="color:${INK};">support@daptatech.com</a>
    </td></tr>
  </table>
</div>`;
}
