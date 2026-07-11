import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { FormHeader } from '@/components/ui/page-header';
import { HostBookingForm } from './host-booking-form';

export const dynamic = 'force-dynamic';

export default async function NewHostBooking() {
  const [me, eventTypes] = await Promise.all([
    adminApi.me(),
    adminApi.listEventTypes(),
  ]);
  const m = getMessages(await getLocale()).admin.bookings;

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      {me?.handle && eventTypes.length > 0 ? (
        <HostBookingForm
          accountCode={me.accountCode}
          handle={me.handle}
          eventTypes={eventTypes}
          messages={m}
          backHref="/admin/bookings"
          backLabel={m.title}
          heading={m.newTitle}
        />
      ) : (
        <>
          <FormHeader backHref="/admin/bookings" backLabel={m.title} title={m.newTitle} />
          <p className="text-muted-foreground">{m.createEventFirst}</p>
        </>
      )}
    </div>
  );
}
