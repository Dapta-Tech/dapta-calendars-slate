'use client';

import { useEffect, useState } from 'react';
import { type OneOffLinkView } from '@slate/types';
import { cn } from '@/lib/cn';
import { track } from '@/lib/analytics/port';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast';
import { listOneOffLinksAction, mintOneOffLinkAction, revokeOneOffLinkAction } from '../actions';
import { usePublicOrigin } from '@/components/public-origin';
import { EventTypeMessages } from './shared';

/**
 * One-off invite links (#69 / AB2, #110) — the minting panel.
 *
 * WHAT A HOST DOES HERE: mint a link, copy it (now or days later), see which
 * ones have been used, and revoke one they sent to the wrong person.
 *
 * Copying it LATER is the whole reason this list shows the token at all. The
 * storage policy in `docs/adr/0003-public-tokens-have-two-storage-policies.md`
 * chose clear text over the manage token's show-once hashing precisely because
 * the host is this token's custodian rather than its recipient: they mint it,
 * then paste it into an email, a DM or an applicant-tracking field, possibly
 * minutes or days later and possibly for five candidates at once. Show-once
 * would mean re-minting every time this panel closed.
 *
 * NOT A SECURITY CONTROL, and the copy must never imply otherwise. A one-off
 * link stops a link sent to one person from being forwarded and re-used; it
 * authenticates nobody. The per-IP limiter is the security control.
 *
 * Loads on MOUNT rather than on save, and holds its own state, so an unreachable
 * API costs the host this list and never the unsaved edits in the rest of the
 * form.
 */
export function OneOffLinksSection({
  eventTypeId,
  eventIsPublic,
  m,
  locale,
}: {
  /** Absent until the event exists — you cannot grant access to nothing. */
  eventTypeId?: string;
  /** Requirement 4: a link over a publicly bookable event limits nothing. */
  eventIsPublic: boolean;
  m: EventTypeMessages;
  locale: 'en' | 'es';
}) {
  const t = m.oneOffLinks;
  const { success } = useToast();
  const [links, setLinks] = useState<OneOffLinkView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!eventTypeId) return;
    let cancelled = false;
    void listOneOffLinksAction(eventTypeId).then((r) => {
      if (cancelled) return;
      if (r.ok) setLinks(r.links);
      else setError(t.failed);
    });
    return () => {
      cancelled = true;
    };
  }, [eventTypeId, t.failed]);

  const mint = async () => {
    if (!eventTypeId || busy) return;
    setBusy(true);
    setError(null);
    const r = await mintOneOffLinkAction(eventTypeId);
    setBusy(false);
    if (!r.ok) {
      setError(t.failed);
      return;
    }
    setLinks((prev) => [r.link, ...prev]);
    // Put the fresh link on the clipboard straight away: minting one and then
    // pasting it is a single intention, and the host came here to send it.
    // ONE toast for the pair — "created" then "copied" back to back reports a
    // single action twice and the second would hide the first.
    const copied = await copy(r.link, { quiet: true });
    success(copied ? t.copiedOnMint : t.minted);
  };

  /**
   * Returns whether the clipboard actually took it, so the caller can say which
   * of the two things happened rather than claiming the better one.
   *
   * A blocked clipboard is not an error worth a toast: the path is rendered in
   * full in the row beside the button and stays selectable, which is the
   * fallback that matters over plain HTTP and in embedded webviews.
   */
  const publicOrigin = usePublicOrigin();
  const copy = async (link: OneOffLinkView, opts?: { quiet?: boolean }): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(`${publicOrigin()}${link.path}`);
      track('link_copied', { link: 'one_off' });
      setCopiedId(link.id);
      // Let the row settle back to "Copy". Without this the button reads
      // "Copied." for the rest of the session and stops looking like a control.
      window.setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 2000);
      if (!opts?.quiet) success(t.copied);
      return true;
    } catch {
      return false;
    }
  };

  const revoke = async (link: OneOffLinkView) => {
    if (!eventTypeId || busy) return;
    setBusy(true);
    setError(null);
    const r = await revokeOneOffLinkAction(eventTypeId, link.id);
    setBusy(false);
    if (!r.ok) {
      setError(t.failed);
      return;
    }
    setLinks((prev) =>
      prev.map((l) => (l.id === link.id ? { ...l, state: 'revoked', revokedAt: Date.now() } : l)),
    );
    success(t.revoked);
  };

  const stateLabel = (state: OneOffLinkView['state']) =>
    state === 'live' ? t.stateLive : state === 'consumed' ? t.stateConsumed : t.stateRevoked;

  return (
    <div className="flex flex-col gap-inline">
      <span className="text-sm font-semibold text-muted-foreground">{t.title}</span>
      <p className="text-xs text-muted-foreground">{t.hint}</p>

      {/* Requirement 4: COPY PLUS A CONDITION, never a block. A host may have a
          reason to mint one over a visible event, so nothing here is disabled —
          they are told what it does and does not buy, where they mint it. */}
      {eventIsPublic ? (
        <p className="rounded-md border border-border bg-muted/40 px-field py-inline text-xs text-muted-foreground">
          {t.publicWarning}
        </p>
      ) : null}

      {!eventTypeId ? (
        // A link is a grant over an event type, so there is nothing to grant
        // until the event has an id. Said plainly rather than hidden, so the
        // feature is discoverable while creating an event.
        <p className="text-xs text-muted-foreground">{t.saveFirst}</p>
      ) : (
        <>
          <div>
            <Button type="button" variant="outline" onClick={mint} disabled={busy}>
              {t.mint}
            </Button>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {links.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t.empty}</p>
          ) : (
            <ul className="flex flex-col gap-inline">
              {links.map((link) => {
                const dead = link.state !== 'live';
                return (
                  <li
                    key={link.id}
                    className={cn(
                      'flex flex-wrap items-center gap-inline rounded-md border border-border px-field py-inline',
                      dead && 'opacity-60',
                    )}
                  >
                    {/* The token itself, readable and selectable. The clipboard
                        button is the fast path; this is the one that still works
                        when the browser blocks clipboard access, which it does
                        over plain HTTP and in some embedded webviews. */}
                    <code className="min-w-0 flex-1 truncate font-mono text-xs" title={link.path}>
                      {link.path}
                    </code>
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      {stateLabel(link.state)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t.createdAt.replace(
                        '{date}',
                        new Date(link.createdAt).toLocaleDateString(locale),
                      )}
                    </span>
                    {/* Copy stays available on a DEAD link too: a host looking at
                        a used link may well want to check which URL they sent. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void copy(link)}
                      aria-label={`${t.copy} — ${link.path}`}
                    >
                      {copiedId === link.id ? t.copied : t.copy}
                    </Button>
                    {link.state === 'live' ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void revoke(link)}
                        disabled={busy}
                      >
                        {t.revoke}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
