import { redirect } from 'next/navigation';
import { DEVELOPERS_CONNECT_HREF } from '@/lib/admin-nav';

/**
 * `/admin/developers` holds no page of its own: its pages are the connect
 * guide, Tools and the "API and webhooks" group. The address answers anyway,
 * as the dForms one does, with the connect guide: connecting an agent is what
 * most people come here for. `next.config.mjs` answers it before any render;
 * this is for what reaches it anyway.
 */
export default function DevelopersIndex() {
  redirect(DEVELOPERS_CONNECT_HREF);
}
