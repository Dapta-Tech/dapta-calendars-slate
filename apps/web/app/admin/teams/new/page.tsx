import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { CreateTeamForm } from './create-team-form';

export const dynamic = 'force-dynamic';

export default async function NewTeamPage() {
  const [me, locale] = await Promise.all([adminApi.me(), getLocale()]);
  const m = getMessages(locale).admin.teams;
  const tz = me?.timeZone ?? 'America/New_York';

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <Link href="/admin/teams" className="text-sm text-muted-foreground hover:text-foreground">
        {m.backToTeamsList}
      </Link>
      <h1 className="mb-1 mt-2 text-3xl font-semibold tracking-tight">{m.createTitle}</h1>
      <p className="mb-6 text-muted-foreground">{m.createSubtitle}</p>
      <CreateTeamForm messages={m} defaultTimeZone={tz} accountCode={me?.accountCode ?? ''} />
    </div>
  );
}
