'use client';

import Link from 'next/link';
import { type BookingMessages } from '@slate/shared';
import { LOCATION_KINDS, type LocationKind } from '@slate/types';
import { type Connection } from '@/lib/admin-api';
import { joinHostNames } from '../team-hosts';
import { buttonVariants } from '@/components/ui/button';
import { EventTypeMessages, Field, SchedulingMethod, TeamMemberOption, inputCls } from './shared';

/**
 * WHERE the meeting happens: a location KIND plus, for the kinds that need one,
 * a detail. Each kind gets its own labelled input, so every shape a location can
 * take is reachable — a bare text box could only ever express "custom".
 *
 * `conferencing` is the one kind with no detail: the link is minted by the
 * calendar port when the booking is confirmed. Its display name is injected by
 * the deployment (ADR 0008) — this repo names no platform, so a bare fork shows
 * only the generic wording.
 */
export function LocationField({
  kind,
  detail,
  onKind,
  onDetail,
  connections,
  teamHosts,
  schedulingType,
  fixedHostIds,
  m,
  locationLabels,
  locale,
}: {
  kind: LocationKind | '';
  detail: string;
  onKind: (kind: LocationKind | '') => void;
  onDetail: (detail: string) => void;
  connections?: Connection[];
  /** Present only for a TEAM event: every host the location applies to. */
  teamHosts?: TeamMemberOption[];
  /** Team events: decides whose calendar a booking's link can come from. */
  schedulingType: SchedulingMethod;
  /** Fixed round robin: the hosts on every booking (live form state). */
  fixedHostIds: string[];
  m: EventTypeMessages;
  locationLabels: BookingMessages['location'];
  /** Sorts and joins host names; the same on the server and in the browser. */
  locale: 'en' | 'es';
}) {
  // ADR 0008: the repo names no conferencing platform, the RUNNING product does.
  // The port reports it and it rides here on the connections response the editor
  // already fetches — so a host sees which platform they are choosing. Null (a
  // bare fork, or no calendar connected) falls back to the generic wording,
  // which is correct: there is no conferencing to name. This is a HOST-facing
  // affordance only; invitee surfaces stay generic.
  const conferencingLabel =
    connections?.map((c) => c.conferencingLabel).find((l) => !!l && l.trim() !== '') ?? null;
  const kindLabel: Record<LocationKind, string> = {
    conferencing: conferencingLabel?.trim() || locationLabels.conferencing,
    in_person: locationLabels.inPerson,
    phone: locationLabels.phone,
    custom: locationLabels.custom,
  };
  const detailLabel: Partial<Record<LocationKind, string>> = {
    in_person: m.locationDetailAddress,
    phone: m.locationDetailPhone,
    custom: m.locationDetailCustom,
  };
  // Warn, never disable: a host must be able to configure conferencing BEFORE
  // connecting a calendar, or connecting later leaves a silently broken event.
  // `connections === undefined` is a team event, warned about per host below.
  const missingDestination =
    kind === 'conferencing' && !!connections && !connections.some((c) => c.isDestination);
  // A team event has ONE location for every host, but its meeting link is
  // minted on the first host ON THE BOOKING with a calendar set to receive new
  // events, organizer first (`destinationRefs` in calendar-refs.ts). So the gap
  // depends on who is on a booking:
  //  - round robin: one host, so each host without one is a gap;
  //  - collective: every host, so one calendar among them is enough;
  //  - fixed round robin: every fixed host, so one fixed calendar is enough;
  //    without it, each rotating host without one is a gap. Read the hosts the
  //    way the engine does (`combineTeamSlots` in parity.ts): no fixed host is
  //    plain round robin, no rotating host is collective over the fixed ones.
  // Strictly `false`: an API that predates the field sends nothing, and an
  // unknown is not a gap.
  const lacksCalendar = (h: TeamMemberOption) => h.hasDestinationCalendar === false;
  let gapHosts: TeamMemberOption[] = [];
  let noHostHasCalendar = false;
  if (kind === 'conferencing' && teamHosts) {
    const isFixed = (h: TeamMemberOption) => fixedHostIds.includes(h.memberId);
    const fixed = schedulingType === 'fixed_round_robin' ? teamHosts.filter(isFixed) : [];
    const rotating = schedulingType === 'fixed_round_robin' ? teamHosts.filter((h) => !isFixed(h)) : [];
    if (schedulingType === 'collective' || (fixed.length > 0 && rotating.length === 0)) {
      const attending = schedulingType === 'collective' ? teamHosts : fixed;
      noHostHasCalendar = attending.length > 0 && attending.every(lacksCalendar);
    } else if (fixed.length > 0) {
      if (fixed.every(lacksCalendar)) gapHosts = rotating.filter(lacksCalendar);
    } else {
      gapHosts = teamHosts.filter(lacksCalendar);
    }
  }
  // The roster arrives in no set order: `joinHostNames` sorts and joins it in
  // the page's locale, so the server render and the browser's agree.
  const gapTemplate =
    gapHosts.length === 1 ? m.locationTeamNoDestinationOne : m.locationTeamNoDestinationMany;
  const linkGapWarning = noHostHasCalendar
    ? m.locationTeamNoDestinationAll
    : gapHosts.length > 0
      ? gapTemplate.replace('{names}', joinHostNames(gapHosts, locale))
      : null;
  const conferencingHint = !teamHosts
    ? m.locationConferencingHint
    : schedulingType === 'round_robin'
      ? m.locationTeamConferencingHint
      : m.locationTeamSharedConferencingHint;

  return (
    <div className="flex flex-col gap-field">
      <Field label={m.fLocation}>
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as LocationKind | '';
            onKind(next);
            // Detail belongs to the kind that asked for it — carrying an
            // address over into "Phone" would be worse than starting clean.
            if (next !== kind) onDetail('');
          }}
          className={inputCls}
        >
          <option value="">{m.locationNone}</option>
          {LOCATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>
      </Field>

      {kind && kind !== 'conferencing' ? (
        <Field label={detailLabel[kind] ?? m.fLocation}>
          <input
            value={detail}
            onChange={(e) => onDetail(e.target.value)}
            placeholder={m.locationPlaceholder}
            className={inputCls}
          />
        </Field>
      ) : null}

      {kind === 'conferencing' ? (
        <p className="text-xs text-muted-foreground">{conferencingHint}</p>
      ) : null}

      {/* No connect button, unlike the personal warning below: each host
          sets their own calendar, so there is nothing to click for them. */}
      {linkGapWarning ? (
        <div className="flex flex-col items-start gap-inline rounded-md border border-border bg-muted/40 px-field py-inline text-xs text-muted-foreground">
          <p>{linkGapWarning}</p>
        </div>
      ) : null}

      {missingDestination ? (
        <div className="flex flex-col items-start gap-inline rounded-md border border-border bg-muted/40 px-field py-inline text-xs text-muted-foreground">
          <p>{m.locationNoDestinationWarning}</p>
          <Link href="/admin/connections" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {m.calendarLinkConnect}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
