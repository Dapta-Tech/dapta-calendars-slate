import { getMessages } from '@slate/shared';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { NoAccess } from '@/components/no-access';
import { MembersClient } from './members-client';

export const dynamic = 'force-dynamic';

export default async function MembersSettings() {
  const [me, locale] = await Promise.all([adminApi.me(), getLocale()]);
  const m = getMessages(locale).admin.members;

  // Role gate: members without admin/owner see a clear "no access" panel rather
  // than an error (the API returns 403 for the roster call regardless).
  if (!isAdminRole(me.role)) {
    return <NoAccess title={m.noAccessTitle} body={m.noAccessBody} />;
  }

  const members = await adminApi.listMembers();
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{m.title}</h2>
        <p className="text-sm text-muted-foreground">{m.subtitle}</p>
      </div>
      {/* Role matrix — what each role can do, visible before anyone assigns one (QA3 fix 5). */}
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {[m.rolesHintOwner, m.rolesHintAdmin, m.rolesHintMember].map((hint) => {
          // "Role — capabilities": set just the role name in medium weight.
          const cut = hint.indexOf(' — ');
          return (
            <li key={hint}>
              {cut > 0 ? (
                <>
                  <span className="font-medium text-foreground">{hint.slice(0, cut)}</span>
                  {hint.slice(cut)}
                </>
              ) : (
                hint
              )}
            </li>
          );
        })}
      </ul>
      <MembersClient members={members} callerId={me.memberId} callerRole={me.role} messages={m} />
    </div>
  );
}
