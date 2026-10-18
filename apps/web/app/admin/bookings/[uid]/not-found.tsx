import { ADMIN_BOOKINGS_PATH, getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { FormHeader } from '@/components/ui/page-header';

/**
 * A booking's own page for a uid this workspace does not have. Inside the
 * dashboard and in the host's language, with the way back to the list, rather
 * than the public booking pages' 404. The same words for another workspace's
 * booking as for one that does not exist, so the page never says which.
 */
export default async function BookingNotFound() {
  const m = getMessages(await getLocale()).admin.bookings;
  return (
    <div className="mx-auto max-w-[1520px] px-gutter pb-gutter-y sm:px-gutter-wide">
      <FormHeader backHref={ADMIN_BOOKINGS_PATH} backLabel={m.title} title={m.notFoundTitle} gutter="responsive" />
      <p className="text-muted-foreground">{m.notFoundBody}</p>
    </div>
  );
}
