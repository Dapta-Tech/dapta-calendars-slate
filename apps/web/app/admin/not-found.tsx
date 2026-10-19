import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { FormHeader } from '@/components/ui/page-header';

/**
 * A dashboard page for something this workspace does not have: a deleted event
 * type, team or schedule, or a mistyped id. Inside the dashboard and in the
 * host's language, with the way back home, rather than the public 404, whose
 * words are for a visitor holding someone else's link. A booking's own page
 * keeps its more specific one (`bookings/[uid]/not-found.tsx`).
 */
export default async function AdminNotFound() {
  const m = getMessages(await getLocale()).admin;
  return (
    <div className="mx-auto max-w-[1520px] px-gutter pb-gutter-y sm:px-gutter-wide">
      {/* An `h1`: the header draws the title the same either way, and the page
          is otherwise a paragraph with no heading for a screen reader to land on. */}
      <FormHeader
        backHref="/admin"
        backLabel={m.nav.home}
        title={<h1>{m.common.notFoundTitle}</h1>}
        gutter="responsive"
      />
      <p className="text-muted-foreground">{m.common.notFoundBody}</p>
    </div>
  );
}
