import { redirect } from 'next/navigation';
import { DEVELOPERS_KEYS_HREF } from '@/lib/admin-nav';

/**
 * `/admin/developers` holds no page of its own: MCP is a group in the rail
 * (Connect and keys, Webhooks, API docs). The address answers anyway, the way
 * the dForms one does, and what anyone came for here is a key.
 * `next.config.mjs` answers it before any render; this is for what reaches it
 * anyway.
 */
export default function DevelopersIndex() {
  redirect(DEVELOPERS_KEYS_HREF);
}
