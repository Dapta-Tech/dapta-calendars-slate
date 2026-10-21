'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { chosenWorkspaceAction } from '@/app/admin/workspace-actions';

/**
 * Keeps a tab honest about which workspace it is in.
 *
 * The choice lives in one cookie for the whole browser, so another tab can
 * change it while this one still shows the old workspace; a form here would
 * then post into the new one. When this tab comes back into view it asks which
 * workspace the cookie names now, and re-renders when that is not the one the
 * page was rendered for, before the person can act on stale content.
 */
export function WorkspaceSync({ rendered }: { rendered: string | null }) {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = await chosenWorkspaceAction().catch(() => rendered);
      if (alive && now !== rendered) router.refresh();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      alive = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [rendered, router]);
  return null;
}
