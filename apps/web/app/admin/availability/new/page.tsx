import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { NewSchedule } from '../new-schedule';

export const dynamic = 'force-dynamic';

export default async function NewSchedulePage() {
  const m = getMessages(await getLocale()).admin.availability;

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <Link href="/admin/availability" className="text-sm text-muted-foreground hover:text-foreground">
        ← {m.title}
      </Link>
      <h1 className="mb-1 mt-2 text-3xl font-semibold tracking-tight">{m.newSchedule}</h1>
      <p className="mb-6 text-muted-foreground">{m.subtitle}</p>
      <NewSchedule messages={m} redirectOnSuccess="/admin/availability" />
    </div>
  );
}
