import Link from 'next/link';
import { getMessages, t } from '@slate/shared';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { fillMessages } from '@/lib/fill-messages';
import { getLocale } from '@/lib/locale';
import { CopyLink } from '@/components/copy-link';
import { SetupChecklist } from '@/components/setup-checklist';
import { AgentBanner } from './_components/agent-banner';
import { AgentCard } from './_components/agent-card';
import { CONNECT_VARS } from './developers/connect-vars';

export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  const me = await adminApi.me();
  const [eventTypes, bookings, teams, setupStatus] = await Promise.all([
    adminApi.listEventTypes(),
    adminApi.listBookings('limit=100'),
    adminApi.listTeams(),
    adminApi.setupStatus(),
  ]);
  const upcoming = bookings.items.filter(
    (b) => b.status === 'accepted' && new Date(b.startUtc).getTime() > Date.now(),
  );
  const publicUrl = me?.handle ? `/${me.accountCode}/${me.handle}` : null;
  const admin = getMessages(await getLocale()).admin;
  const h = admin.home;
  const firstName = me?.displayName?.split(' ')[0];
  // Connecting an agent is for owners and admins, like the rail's "Connect
  // your agent": a sign-in reaches only the workspaces where the person is one,
  // so a member is not shown a door that opens on "no access".
  const agents = isAdminRole(me.role);

  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      {agents ? <AgentBanner m={h.agentBanner} /> : null}
      <h1 className="mb-tight text-3xl font-semibold tracking-tight">
        {firstName ? t(h.welcomeNamed, { name: firstName }) : h.welcome}
      </h1>
      <p className="mb-section text-muted-foreground">{h.subtitle}</p>

      <SetupChecklist status={setupStatus} messages={h} />

      {/* Every member has an auto-assigned handle (short-links §3), so the link
          always exists — but a link to a page with nothing on it is not worth
          copying. Shown only once the host has a published event type (#84);
          until then the checklist above is telling them to create one. */}
      {publicUrl && setupStatus.hasPublishedEventType ? (
        <div className="mb-section flex flex-col gap-inline rounded-md border border-border bg-card p-card">
          <span className="text-sm text-muted-foreground">{h.bookingLink}</span>
          {/* `opensNewTab` only: `CopyLink`'s Open control is a real button that
              opens a new tab now (A2, #112), and its screen-reader suffix must
              not fall back to English on the Spanish catalog. The rest of this
              screen is A1's (#111). */}
          <CopyLink
            path={publicUrl}
            labels={{
              copy: h.copy,
              copied: h.copied,
              open: h.open,
              opensNewTab: admin.common.opensNewTab,
            }}
          />
        </div>
      ) : null}

      <div className="mb-section grid grid-cols-3 gap-card">
        <Stat label={h.statEventTypes} value={eventTypes.length} href="/admin/event-types" />
        <Stat label={h.statUpcoming} value={upcoming.length} href="/admin/bookings" />
        <Stat label={h.statTeams} value={teams.length} href="/admin/teams" />
      </div>

      {/* After the figures, where the dForms home has the same card. */}
      {agents ? <AgentCard m={fillMessages(h.agentCard, CONNECT_VARS)} /> : null}

      <div className="grid gap-card sm:grid-cols-3">
        <Shortcut href="/admin/event-types" title={h.createEvent} desc={h.createEventDesc} />
        <Shortcut href="/admin/availability" title={h.setAvailability} desc={h.setAvailabilityDesc} />
        <Shortcut href="/admin/settings/booking-page" title={h.stylePage} desc={h.stylePageDesc} />
      </div>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-tight rounded-md border border-border bg-card p-card transition-transform hover:border-primary active:scale-[0.99]"
    >
      <span className="text-3xl font-semibold">{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </Link>
  );
}

function Shortcut({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-tight rounded-md border border-border bg-card p-card transition-transform hover:border-primary active:scale-[0.99]"
    >
      <span className="font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{desc}</span>
    </Link>
  );
}
