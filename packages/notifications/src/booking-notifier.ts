import type { EmailProvider, EmailResult } from './email.port';
import { buildIcs, icsContentType } from './ics';
import { renderBrandedHtml, type Audience, type EmailGrowth, type EmailKind } from './email-layout';
import {
  bookingDetails,
  bookingDetailsText,
  type BookingAnswer,
  type BookingGuest,
} from './booking-details';
import {
  renderTemplate,
  templateVars,
  type EmailTemplate,
  type RenderedEmail,
  type TemplateLocale,
  formatWhen,
  inviteeManageUrl,
  recipientTimeZone,
} from './templates';

/** Everything a booking notification needs to render, provider-agnostic. */
export interface BookingNotification {
  accountId: string;
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  /**
   * `timeZone` is the host's own zone, which the host's copy is written in (see
   * `recipientTimeZone`). Absent on forks that build notifications directly,
   * and on rows queued before it was carried (the API fills those in at
   * delivery). Without it the notifier falls back to the attendee's zone.
   */
  host: { name?: string | null; email?: string | null; timeZone?: string | null };
  /** Additional assigned hosts (collective / fixed_round_robin) — also notified. */
  coHosts?: Array<{ name?: string | null; email?: string | null }>;
  /**
   * `phone` and `notes` are what the invitee gave beside their name and email;
   * only the host's copy shows them (`bookingDetails`). Absent on rows queued
   * before they were carried, which then show name and email only.
   */
  attendee: {
    name: string;
    email: string;
    timeZone?: string | null;
    phone?: string | null;
    notes?: string | null;
  };
  /**
   * Everyone else the booking invites (extra attendees, added guests), for the
   * host's copy. Snapshotted at enqueue like the rest. Absent = none listed.
   */
  guests?: BookingGuest[] | null;
  /**
   * The booking form's answers, in the event type's question order and
   * labelled as the host wrote the questions (`collectBookingAnswers`),
   * snapshotted at enqueue. The host's copy of the request, the confirmed
   * booking and the move lists them; no invitee copy does. Not `formAnswers`,
   * which is the raw record behind the `{{form.*}}` template namespace.
   */
  answers?: BookingAnswer[] | null;
  /**
   * Where the HOST acts on this booking: the dashboard's bookings page,
   * deep-linked to it. Behind the host's login, and a plain page load there
   * changes nothing, so a mail scanner that follows it cannot confirm or
   * decline anything (no state-changing link is ever put in an email). The
   * host's request carries it as its one button. Never on an invitee copy.
   */
  dashboardUrl?: string | null;
  location?: string | null;
  /**
   * The conferencing link. Filled at DELIVERY time, never at enqueue — it is
   * minted later by the calendar outbox row, so the enqueue-time snapshot
   * cannot contain it (ADR 0007). Absent/null renders no join affordance
   * anywhere: the template line drops, the HTML CTA is omitted, the `.ics`
   * keeps its human LOCATION and gains no `URL:`.
   */
  meetingUrl?: string | null;
  /**
   * The booking's snapshotted location kind, carried so the DELIVERY side can
   * tell whether this booking is even supposed to have a link — and therefore
   * whether it is worth waiting a bounded moment for one. Absent on rows
   * queued before C2, which is exactly the "never wait" case.
   */
  locationKind?: string | null;
  manageUrl?: string | null;
  cancellationReason?: string | null;
  previousStartUtc?: string | null;
  /** DTSTAMP for the .ics (injected for determinism). Defaults to startUtc. */
  stamp?: string;
  /**
   * Which side this message is for: `attendee` → attendee only; `host` → host +
   * co-hosts (deduped, `:host`-suffixed idempotency key). ABSENT = legacy: one
   * message to everyone with the attendee copy — pre-toggle callers and forks
   * that construct notifications directly keep today's behavior.
   */
  audience?: 'attendee' | 'host';
  /**
   * Resolved template to render (per-account custom or shipped default). The
   * enqueue side snapshots it into the outbox payload so a later template edit
   * never rewrites already-queued mail. Absent = built-in copy.
   */
  template?: EmailTemplate | null;
  /** Locale for template variable formatting (`en` default). */
  templateLocale?: string | null;
  /** True while the booking awaits host confirmation (drives {{pending_note}}). */
  pending?: boolean;
  /**
   * Whether this account's mail carries the Dapta branding (the invitee's
   * "Made with" line), as the API decided it with `showDaptaBranding`. Filled at
   * DELIVERY time like `meetingUrl`, so a row queued weeks ahead follows a lapse.
   * Only `false` hides the line; absent (old rows, forks) keeps it.
   */
  showBranding?: boolean;
  /** Public book-again URL for this event type (drives {{booking_link}}). */
  bookingLink?: string | null;
  /**
   * The booking's own intake answers, raw, driving the `{{form.<field name>}}`
   * namespace (#68 decision 2). Snapshotted into the outbox payload at enqueue
   * time like the rest of this object (ADR 0007) — the answer exists the moment
   * the booking does, so nothing here waits on delivery. Absent = no form
   * variables resolve, and each of their lines is dropped.
   */
  formAnswers?: Record<string, unknown> | null;
}

/**
 * The kinds whose HOST copy says who the booking is from and what they
 * answered: the request (decide on it), the confirmed booking (prepare for it)
 * and the move. A cancellation, a decline or a reminder is about a booking the
 * host already read about. Exported so the enqueue side snapshots the block
 * for exactly these kinds.
 */
export const HOST_DETAIL_KINDS: ReadonlySet<string> = new Set<EmailKind>([
  'pending',
  'confirmation',
  'reschedule',
]);

/**
 * The host's dashboard link for this booking, for the host's copy only, and
 * only an http(s) one. Mirror of `inviteeManageUrl`: each side gets its own
 * way in and never the other's.
 */
export function hostDashboardUrl(n: Pick<BookingNotification, 'audience' | 'dashboardUrl'>): string {
  if (n.audience !== 'host') return '';
  const url = (n.dashboardUrl ?? '').trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : '';
}

/**
 * Renders and sends booking emails through the EmailProvider port, each with an
 * .ics invite where appropriate (SEQUENCE 0/1/2 for confirm/reschedule/cancel;
 * stable UID). The app only ever calls these methods; the transport is whatever
 * adapter is wired.
 *
 * Recipients: without an `audience`, confirmation/reschedule/cancellation go to
 * the attendee AND the host (deduped) — parity with the old service. With an
 * `audience` (the toggle-aware enqueue path) each side gets its own message so
 * per-side notification settings can silence one without the other.
 */
export class BookingNotifier {
  /**
   * `growth.signupUrl`: the deployment's signup destination for the invitee's
   * footer line. `growth.supportEmail`: the deployment's support address for
   * the "Need help?" footer line. Absent (a bare fork, every existing caller):
   * neither line.
   */
  constructor(
    private readonly email: EmailProvider,
    private readonly growth: EmailGrowth = {},
  ) {}

  /** Recipient set for the notification's audience, deduped, empties dropped. */
  private recipients(n: BookingNotification): string[] {
    const set = new Set<string>();
    if (n.audience !== 'host' && n.attendee.email) set.add(n.attendee.email);
    if (n.audience !== 'attendee') {
      if (n.host.email) set.add(n.host.email);
      for (const h of n.coHosts ?? []) if (h.email) set.add(h.email);
    }
    return [...set];
  }

  /** Host-side messages get their own dedupe key; attendee keeps the legacy key. */
  private idem(n: BookingNotification, base: string): string {
    return n.audience === 'host' ? `${base}:host` : base;
  }

  /**
   * Render an email: the subject + plain-text stay the (user-editable) template
   * copy; the HTML is always the branded booking layout, keyed by `kind` (badge
   * + call-to-action set) and the recipient audience. Falls back to legacy copy
   * for subject/text only when no template is resolved.
   */
  private copy(
    n: BookingNotification & { reminderLeadMinutes?: number },
    kind: EmailKind,
    legacy: () => { subject: string; lines: string[] },
  ): RenderedEmail {
    const locale: TemplateLocale = n.templateLocale === 'es' ? 'es' : 'en';
    const audience: Audience = n.audience === 'host' ? 'host' : 'attendee';
    const vars = templateVars(n, locale);
    const growth = n.showBranding === false ? { ...this.growth, signupUrl: null } : this.growth;
    // Who the booking is from and what they answered: on the host's copy of
    // the request, the confirmed booking and the move, whatever its template
    // says, so a host who edited the template still sees it.
    const details = audience === 'host' && HOST_DETAIL_KINDS.has(kind) ? bookingDetails(n, locale) : null;
    // The host's request is the one host copy with something to do.
    const actionUrl = kind === 'pending' ? hostDashboardUrl(n) : '';
    const html = renderBrandedHtml(kind, vars, locale, audience, growth, { details, actionUrl });
    const withDetails = (text: string) =>
      details ? [text, bookingDetailsText(details, locale, actionUrl)].filter(Boolean).join('\n\n') : text;
    if (n.template) {
      const base = renderTemplate(n.template, vars);
      return { subject: base.subject, text: withDetails(base.text), html };
    }
    const { subject, lines } = legacy();
    const kept = lines.filter(Boolean);
    // A subject is a header: a line break in a title must not end it early.
    return { subject: subject.replace(/[\r\n]+/g, ' '), text: withDetails(kept.join('\n')), html };
  }

  sendConfirmation(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const rendered = this.copy(n, 'confirmation', () => ({
      subject: `Confirmed: ${n.title} — ${when}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `Your booking "${n.title}" is confirmed.`,
        `When: ${when}`,
        n.host.name ? `Host: ${n.host.name}` : '',
        n.location ? `Where: ${n.location}` : '',
        inviteeManageUrl(n) ? `Manage your booking: ${inviteeManageUrl(n)}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: this.idem(n, `calendar:${n.uid}:confirmation`),
      attachments: [this.ics(n, 'REQUEST', 0)],
    });
  }

  /**
   * A scheduled REMINDER before the meeting. No new .ics — the confirmed invite
   * already lives in the calendar; this is just a nudge. The `payload` carries
   * `reminderLeadMinutes` so the copy can say "starts in X".
   */
  sendReminder(n: BookingNotification & { reminderLeadMinutes?: number }): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const lead = n.reminderLeadMinutes;
    const inWord =
      lead == null ? 'soon' : lead % 1440 === 0 ? `in ${lead / 1440} day(s)` : lead % 60 === 0 ? `in ${lead / 60} hour(s)` : `in ${lead} minutes`;
    const rendered = this.copy(n, 'reminder', () => ({
      subject: `Reminder: ${n.title} — ${when}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `Reminder: "${n.title}" starts ${inWord}.`,
        `When: ${when}`,
        n.host.name ? `Host: ${n.host.name}` : '',
        n.location ? `Where: ${n.location}` : '',
        inviteeManageUrl(n) ? `Manage your booking: ${inviteeManageUrl(n)}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      // Distinct per lead so two reminders (24h, 1h) aren't de-duped as one.
      idempotencyKey: this.idem(n, `calendar:${n.uid}:reminder:${lead ?? 'x'}`),
      // No .ics on a reminder.
    });
  }

  /**
   * Post-meeting FOLLOW-UP (thank-you) — scheduled at end + lead, attendee
   * side, strictly opt-in (default OFF). No .ics: the meeting already
   * happened; this is a courtesy note with a book-again link.
   */
  sendFollowUp(n: BookingNotification & { reminderLeadMinutes?: number }): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const rendered = this.copy(n, 'follow_up', () => ({
      subject: `Thanks for meeting — ${n.title}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `Thanks for taking the time for "${n.title}" (${when}) — we hope it was useful.`,
        n.bookingLink ? `Want to talk again? Book another slot: ${n.bookingLink}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      // Keyed per lead, mirroring reminders — a re-pointed follow-up at the
      // same lead after reschedule replaces, not duplicates.
      idempotencyKey: this.idem(n, `calendar:${n.uid}:follow_up:${n.reminderLeadMinutes ?? 'x'}`),
      // No .ics on a follow-up.
    });
  }

  /**
   * B5: a `requiresConfirmation` booking is PENDING, not confirmed. Tell the
   * attendee we received the request — and DO NOT attach a CONFIRMED invite (no
   * .ics), so their calendar isn't populated with an event the host may decline.
   */
  sendPendingRequest(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const rendered = this.copy(n, 'pending', () => ({
      subject: `Request received: ${n.title} — ${when}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `We received your request to book "${n.title}".`,
        `When: ${when}`,
        n.host.name ? `Host: ${n.host.name}` : '',
        `This is pending confirmation${n.host.name ? ` by ${n.host.name}` : ''}. ` +
          `You'll get another email once it's confirmed.`,
        inviteeManageUrl(n) ? `Cancel this request: ${inviteeManageUrl(n)}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      // Without an audience the host is copied too — the cue to confirm/decline.
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: this.idem(n, `calendar:${n.uid}:pending`),
      // No .ics on purpose — nothing is confirmed yet.
    });
  }

  /** B3: the host declined a pending request — tell the attendee it's off. */
  sendDeclined(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const rendered = this.copy(n, 'declined', () => ({
      subject: `Not accepted: ${n.title} — ${when}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `Unfortunately your request to book "${n.title}" (${when}) was not accepted.`,
        n.cancellationReason ? `Reason: ${n.cancellationReason}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      // Without an audience the host is copied too — confirms the decline landed.
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: this.idem(n, `calendar:${n.uid}:declined`),
      // No .ics — the pending request never produced a confirmed event.
    });
  }

  sendReschedule(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const prev = n.previousStartUtc ? formatWhen(n.previousStartUtc, recipientTimeZone(n)) : null;
    const rendered = this.copy(n, 'reschedule', () => ({
      subject: `Rescheduled: ${n.title} — ${when}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `Your booking "${n.title}" has been rescheduled.`,
        prev ? `Was: ${prev}` : '',
        `Now: ${when}`,
        n.host.name ? `Host: ${n.host.name}` : '',
        n.location ? `Where: ${n.location}` : '',
        inviteeManageUrl(n) ? `Manage your booking: ${inviteeManageUrl(n)}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      // Keyed by the TARGET start: a retry of the same reschedule is de-duped,
      // but a second reschedule to a different time is a distinct message.
      idempotencyKey: this.idem(n, `calendar:${n.uid}:reschedule:${n.startUtc}`),
      attachments: [this.ics(n, 'REQUEST', 1)],
    });
  }

  sendCancellation(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, recipientTimeZone(n));
    const rendered = this.copy(n, 'cancellation', () => ({
      subject: `Cancelled: ${n.title} — ${when}`,
      lines: [
        `Hi ${n.attendee.name},`,
        ``,
        `Your booking "${n.title}" (${when}) has been cancelled.`,
        n.cancellationReason ? `Reason: ${n.cancellationReason}` : '',
      ],
    }));
    return this.email.send({
      accountId: n.accountId,
      to: this.recipients(n),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: this.idem(n, `calendar:${n.uid}:cancellation`),
      attachments: [this.ics(n, 'CANCEL', 2)],
    });
  }

  private ics(n: BookingNotification, method: 'REQUEST' | 'CANCEL', sequence: number) {
    return {
      filename: 'invite.ics',
      content: buildIcs({
        uid: n.uid,
        method,
        sequence,
        startUtc: n.startUtc,
        endUtc: n.endUtc,
        title: n.title,
        location: n.location,
        url: n.meetingUrl,
        organizer: n.host,
        attendees: [{ name: n.attendee.name, email: n.attendee.email }],
        stamp: n.stamp ?? n.startUtc,
      }),
      contentType: icsContentType(method),
    };
  }
}

