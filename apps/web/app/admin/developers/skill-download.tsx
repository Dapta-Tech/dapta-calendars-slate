'use client';

import { useRef, useState } from 'react';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { SKILL_ROUTE, SKILL_ZIP_NAME } from '@/lib/developer-skill/skill-names';

type DevMessages = BookingMessages['admin']['developer'];

/**
 * How long the file's object URL outlives the click. Revoked straight away,
 * some browsers cancel the save they have not started reading yet; the zip is
 * a few kilobytes, so holding it a little longer costs nothing.
 */
export const REVOKE_AFTER_MS = 40_000;

/** The line to show for a failed download, by the route's `error` code. */
export function skillErrorMessage(m: DevMessages, code: unknown): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return m.guideSkillErrorSession;
    case 'FORBIDDEN':
      return m.guideSkillErrorForbidden;
    case 'API_URL_NOT_CONFIGURED':
      return m.guideSkillUnavailable;
    default:
      return m.guideSkillErrorGeneric;
  }
}

/**
 * The skill's download button. It fetches the zip rather than linking to it:
 * a plain `download` link turns a refusal into the browser's own "Failed"
 * (or, in some browsers, a saved file of JSON), and the person never learns
 * why. Here a refusal becomes a line under the button that says what to do,
 * read from the route's `error` code.
 *
 * `aria-disabled` rather than `disabled` while the zip is built: the button
 * keeps keyboard focus, and a second press is ignored instead of starting a
 * second download.
 */
export function SkillDownload({ m }: { m: DevMessages }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State lands on the next render; a fast second press must be refused now.
  const inFlight = useRef(false);

  async function download() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(SKILL_ROUTE, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(skillErrorMessage(m, body?.error));
        return;
      }
      save(await res.blob());
    } catch {
      setError(m.guideSkillErrorGeneric);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="mt-field">
      <Button
        variant="outline"
        size="lg"
        onClick={download}
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        data-testid="setup-skill-download"
        className="aria-disabled:cursor-progress aria-disabled:opacity-70"
      >
        <i aria-hidden className="pi pi-download" style={{ fontSize: 14 }} />
        {pending ? m.guideSkillPending : m.guideSkillButton}
      </Button>
      {error ? (
        <p role="alert" data-testid="setup-skill-error" className="mt-field max-w-prose text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Hand the zip to the browser as a file, under the name the route gives it. */
function save(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = SKILL_ZIP_NAME;
  // In the page for the click: Firefox ignores one on a detached link.
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
