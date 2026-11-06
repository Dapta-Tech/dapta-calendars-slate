import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { hostFetch } from '@/lib/auth-session';
import { getLocale } from '@/lib/locale';
import { loadEventPreviewHost } from '@/lib/event-preview';
import { BrandedShell } from '@/components/branded-shell';
import { DraftBookingPreview } from './draft-booking-preview';

export const dynamic = 'force-dynamic';

/** How far ahead the preview reads real times. */
const PREVIEW_DAYS = 60;

/**
 * The host's REAL times for a saved personal event, through the authenticated
 * host surface (it answers for hidden events too). Null when there is no such
 * event or the read fails: the preview then uses example times and says so.
 */
async function realSlots(slug: string): Promise<{ slots: { startUtc: string }[]; timeZone: string | null } | null> {
  const from = new Date();
  const to = new Date(from.getTime() + PREVIEW_DAYS * 86_400_000);
  const qs = new URLSearchParams({ slug, from: from.toISOString(), to: to.toISOString() });
  try {
    const res = await hostFetch(`/v1/me/availability?${qs}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { slots?: { startUtc: string }[]; timeZone?: string | null };
    return { slots: j.slots ?? [], timeZone: j.timeZone ?? null };
  } catch {
    return null;
  }
}

/**
 * The event editor's eye button opens this: the unsaved draft as the booking
 * page, in the host's own look, full size and clickable (picking a time holds
 * nothing and submitting books nothing). A saved event shows its real times;
 * a new or team event shows example times. Signed-in only.
 */
export default async function EventDraftPreview({
  searchParams,
}: {
  searchParams: Promise<{ team?: string; event?: string }>;
}) {
  const { team: teamId, event: savedSlug } = await searchParams;
  const [me, locale, teams] = await Promise.all([adminApi.me(), getLocale(), adminApi.listTeams().catch(() => [])]);
  const team = teamId ? teams.find((t) => t.id === teamId) : undefined;
  const [host, real] = await Promise.all([
    loadEventPreviewHost(me, team ? { name: team.name, slug: team.slug, logoUrl: team.logoUrl } : undefined),
    savedSlug && !team ? realSlots(savedSlug) : Promise.resolve(null),
  ]);
  const m = getMessages(locale).admin.eventTypes.editor.preview;
  return (
    <BrandedShell brandColor={host.brandColor} style={host.style} className="bp-viewport">
      <main className="w-full py-10 md:px-6 md:py-12">
        <DraftBookingPreview
          hostName={host.hostName}
          avatarUrl={host.avatarUrl}
          logoUrl={host.logoUrl}
          locale={locale === 'es' ? 'es' : 'en'}
          realSlots={real?.slots ?? null}
          timeZone={real?.timeZone ?? me?.timeZone ?? 'UTC'}
          m={m}
        />
      </main>
    </BrandedShell>
  );
}
