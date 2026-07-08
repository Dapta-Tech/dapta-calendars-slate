import Link from 'next/link';
import { adminApi } from '@/lib/admin-api';
import { HostBookingForm } from './host-booking-form';

export const dynamic = 'force-dynamic';

export default async function NewHostBooking() {
  const [me, eventTypes] = await Promise.all([
    adminApi.me().catch(() => null),
    adminApi.listEventTypes().catch(() => []),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <Link href="/admin/bookings" className="text-sm text-muted-foreground hover:text-foreground">
        ← Bookings
      </Link>
      <h1 className="mb-1 mt-2 text-3xl font-semibold tracking-tight">New booking</h1>
      <p className="mb-6 text-muted-foreground">
        Book on behalf of an attendee — from an open slot or any time (R29).
      </p>
      {me?.handle && eventTypes.length > 0 ? (
        <HostBookingForm accountCode={me.accountCode} handle={me.handle} eventTypes={eventTypes} />
      ) : (
        <p className="text-muted-foreground">Create an event type first.</p>
      )}
    </div>
  );
}
