import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { loadEventPreviewHost } from '@/lib/event-preview';
import { BrandedShell } from '@/components/branded-shell';
import { DraftBookingPreview } from './draft-booking-preview';

export const dynamic = 'force-dynamic';

/**
 * The event editor's eye button opens this: the unsaved draft as the booking
 * page, in the host's own look, full size, in a tab of its own. Signed-in
 * only (it reads the host's profile through the admin API).
 */
export default async function EventDraftPreview({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const { team: teamId } = await searchParams;
  const [me, locale, teams] = await Promise.all([adminApi.me(), getLocale(), adminApi.listTeams().catch(() => [])]);
  const team = teamId ? teams.find((t) => t.id === teamId) : undefined;
  const host = await loadEventPreviewHost(
    me,
    team ? { name: team.name, slug: team.slug, logoUrl: team.logoUrl } : undefined,
  );
  const m = getMessages(locale).admin.eventTypes.editor.preview;
  return (
    <BrandedShell brandColor={host.brandColor} style={host.style} className="bp-viewport">
      <main className="w-full py-10 md:px-6 md:py-12">
        <DraftBookingPreview
          hostName={host.hostName}
          avatarUrl={host.avatarUrl}
          logoUrl={host.logoUrl}
          locale={locale === 'es' ? 'es' : 'en'}
          m={m}
        />
      </main>
    </BrandedShell>
  );
}
