import { redirect } from 'next/navigation';
import { DEVELOPERS_KEYS_HREF } from '@/lib/admin-nav';

/**
 * The old home of "MCP & API", now the rail's MCP group. Links to this address
 * already exist (bookmarks, older docs, the OAuth end-to-end script), so it
 * keeps answering. `next.config.mjs` redirects it before any render; this page
 * covers anything that reaches it anyway.
 */
export default function OldDeveloperSettings() {
  redirect(DEVELOPERS_KEYS_HREF);
}
