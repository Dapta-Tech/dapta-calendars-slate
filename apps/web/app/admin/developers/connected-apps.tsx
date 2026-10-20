'use client';

import { useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import type { ConnectedApp } from '@/lib/admin-api';
import { scopeLabel } from '@/lib/mcp-connect';
import { revokeConnectedAppAction } from './actions';

type DevMessages = BookingMessages['admin']['developer'];

/** A fixed, locale-free date so server and client render the same text. */
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The account's OAuth connections (apps that signed in through the consent
 * screen), with Disconnect. Disconnecting revokes the grant: the app can no
 * longer refresh, and the access token it holds dies at its expiry, which the
 * copy states in minutes from the deployment's own token lifetime.
 */
export function ConnectedApps({
  apps,
  accessTokenTtlSeconds,
  messages: m,
  locale,
}: {
  apps: ConnectedApp[];
  accessTokenTtlSeconds: number;
  messages: DevMessages;
  locale?: Locale;
}) {
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);
  const minutes = String(Math.max(1, Math.round(accessTokenTtlSeconds / 60)));

  const askRevoke = async (app: ConnectedApp) => {
    const name = app.clientName ?? m.connectedUnnamed;
    const ok = await confirm({
      title: m.connectedRevokeTitle,
      message: t(m.connectedRevokeBody, { name, minutes }),
      confirmLabel: m.connectedRevoke,
      cancelLabel: m.cancel,
      destructive: true,
    });
    if (!ok) return;
    start(async () => {
      const r = await revokeConnectedAppAction(app.id);
      if (r.ok) success(m.connectedRevokedToast);
      else error(r.error ?? m.genericError);
    });
  };

  return (
    <section className="mb-section">
      <h2 className="mb-tight text-xl font-semibold">{m.connectedTitle}</h2>
      <p className="mb-tight max-w-prose text-sm text-muted-foreground">{m.connectedLead}</p>
      <p className="mb-field max-w-prose text-xs text-muted-foreground">{t(m.connectedExpiryNote, { minutes })}</p>
      <ul className="flex flex-col gap-inline">
        {apps.map((app) => {
          const name = app.clientName ?? m.connectedUnnamed;
          return (
            <li
              key={app.id}
              className="flex flex-wrap items-center justify-between gap-x-field gap-y-inline rounded-xl border border-border bg-card p-field"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-tight text-sm">
                <span className="font-medium">{name}</span>
                {/* The host it is identified by: the name above is the app's own claim. */}
                <span className="text-xs text-muted-foreground">{t(m.connectedFrom, { host: app.clientHost })}</span>
              </span>
              <Button
                variant="destructive"
                size="lg"
                disabled={pending}
                aria-label={`${m.connectedRevoke} · ${name}`}
                onClick={() => void askRevoke(app)}
              >
                {m.connectedRevoke}
              </Button>
              <div className="flex basis-full flex-col gap-tight text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-inline">
                  {app.scopes.map((s) => (
                    <span key={s} className="inline-flex items-center rounded-full bg-muted px-inline py-tight text-foreground">
                      {scopeLabel(m.scopeLabels, s)}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-field gap-y-tight">
                  <span>{t(m.connectedSince, { date: day(app.createdAt) })}</span>
                  <span>{app.lastUsedAt ? t(m.connectedLastUsed, { date: day(app.lastUsedAt) }) : m.connectedNeverUsed}</span>
                  {app.approvedBy ? <span>{t(m.connectedApprovedBy, { who: app.approvedBy })}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
        {apps.length === 0 ? <li className="text-sm text-muted-foreground">{m.connectedNone}</li> : null}
      </ul>
      {dialog}
    </section>
  );
}
