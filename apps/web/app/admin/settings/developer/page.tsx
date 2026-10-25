import { redirect } from 'next/navigation';
import { DEVELOPERS_CONNECT_HREF } from '@/lib/admin-nav';

/**
 * The old home of "MCP & API". Links to this address already exist (bookmarks,
 * older docs, the OAuth end-to-end script), so it keeps answering, with the
 * connect guide: connecting an agent is what that page was mostly for, and the
 * keys are one click away under "API and webhooks". `next.config.mjs`
 * redirects it before any render; this page covers anything that reaches it
 * anyway.
 */
export default function OldDeveloperSettings() {
  redirect(DEVELOPERS_CONNECT_HREF);
}
