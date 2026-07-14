import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { ConnectedClient } from './connected-client';

// Customer-facing name comes from the deployment; "Slate" never surfaces here.
const PRODUCT_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';

export const metadata = { title: `Connected — ${PRODUCT_NAME}` };

/**
 * The OAuth popup's landing page (Bug C). Membrane redirects the popup here
 * once the provider handshake completes — success as `?connectionId=<id>`,
 * failure as `?error=<message>&errorData=<json>&connectionId=<id>` — instead
 * of stranding the user on Membrane's own "you can close this tab" page. The
 * LAST thing the user sees is Dapta Calendars, branded, with an immediate
 * auto-close (success) or a readable failure (error present) + a signal back
 * to the opener modal (see connected-client.tsx). No admin data is read
 * here; this is a pure landing — `errorData` (vendor-shaped JSON) is
 * deliberately never rendered, only the plain `error` message, kept off this
 * generic page and passed instead to the opener's own error surface.
 */
export default async function ConnectedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connectionId?: string }>;
}) {
  const { error } = await searchParams;
  const m = getMessages(await getLocale()).admin.connections;
  return (
    <ConnectedClient
      error={error ?? null}
      m={{
        title: m.connectedPageTitle,
        body: m.connectedPageBody,
        close: m.connectedPageClose,
        errorTitle: m.connectedPageErrorTitle,
        errorBody: m.connectedPageErrorBody,
      }}
    />
  );
}
