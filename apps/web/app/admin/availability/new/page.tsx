import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { NewSchedule } from '../new-schedule';

export const dynamic = 'force-dynamic';

export default async function NewSchedulePage() {
  const m = getMessages(await getLocale()).admin.availability;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <NewSchedule messages={m} backHref="/admin/availability" backLabel={m.title} />
    </div>
  );
}
