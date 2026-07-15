import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

// Customer-facing name comes from the deployment (same rule as the wordmark);
// 'Slate' never surfaces in the UI.
const PRODUCT_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';

export default async function ConnectionsPage() {
  const [connections, token, me] = await Promise.all([
    adminApi.listConnections(),
    // Provider status: enabled only when an external calendar adapter is wired.
    adminApi.connectionToken().catch(() => ({ enabled: false, message: 'Calendar sync unavailable.' })),
    // Best-effort default for the connect dialog's "which account?" prompt —
    // most hosts connect their own Dapta login email, so pre-filling it (still
    // editable) saves a step; never required for the flow to work.
    adminApi.me().catch(() => null),
  ]);
  const admin = getMessages(await getLocale()).admin;
  const messages = {
    ...admin.connections,
    pageDesc: admin.connections.pageDesc.replace('{product}', PRODUCT_NAME),
    emptyBody: admin.connections.emptyBody.replace('{product}', PRODUCT_NAME),
  };
  // Calendars is a top-level admin surface (rail item), styled like every
  // other list page: PageHeader (title left, primary action top-right) +
  // content column (R30 list/create pattern). The primary "Connect another"
  // action lives in the SAME header row as the title — ConnectionsClient
  // renders the PageHeader itself so the action can be wired to its dialog
  // state, exactly like Bookings' "+ New booking". ONE container width for the
  // whole page (header + body) — same max-w-[1520px] canvas as every other
  // admin list page (Bookings/Event types/Teams) so the body's right edge
  // lines up under the header action, not a narrower column underneath it.
  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <ConnectionsClient
        title={admin.nav.calendars}
        subtitle={messages.pageDesc}
        connections={connections}
        status={{ enabled: token.enabled, message: token.message }}
        messages={messages}
        defaultEmail={me?.email ?? null}
      />
    </div>
  );
}
