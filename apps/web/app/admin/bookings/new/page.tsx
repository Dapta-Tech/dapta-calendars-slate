import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
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
      <Link href="/admin/bookings" className="text-sm text-muted-foreground hover:text-foreground">
        ← {m.title}
      </Link>
      <h1 className="mb-1 mt-2 text-3xl font-semibold tracking-tight">{m.newTitle}</h1>
      <p className="mb-6 text-muted-foreground">{m.newSubtitle}</p>
      {me?.handle && eventTypes.length > 0 ? (
        <HostBookingForm accountCode={me.accountCode} handle={me.handle} eventTypes={eventTypes} messages={m} />
      ) : (
        <p className="text-muted-foreground">{m.createEventFirst}</p>
      )}
    </div>
  );
}
