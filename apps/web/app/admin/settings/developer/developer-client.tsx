'use client';

import { useState, useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import type { ApiScope } from '@slate/types';
import { Modal } from '@/components/modal';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { ApiKeyRow, WebhookRow } from '@/lib/admin-api';
import {
  createApiKeyAction,
  createWebhookAction,
  deleteWebhookAction,
  pingWebhookAction,
  webhookDeliveriesAction,
  toggleWebhookAction,
  revokeApiKeyAction,
} from './actions';

type DevMessages = BookingMessages['admin']['developer'];

const SCOPES: ApiScope[] = [
  'availability:read',
  'event-types:read',
  'calendars:read',
  'bookings:read',
  'bookings:write',
];
const TRIGGERS = ['booking.created', 'booking.rescheduled', 'booking.cancelled'];

export function ApiKeys({
  keys,
  messages: m,
  locale,
}: {
  keys: ApiKeyRow[];
  messages: DevMessages;
  /** Active admin locale — the ConfirmDialog's own confirm/cancel copy. */
  locale?: Locale;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['availability:read']);
  const [reveal, setReveal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);

  const submit = () =>
    start(async () => {
      const r = await createApiKeyAction(name, scopes);
      if (r.plaintext) {
        setReveal(r.plaintext);
        setName('');
        setScopes(['availability:read']);
        setOpen(false);
      }
    });

  // A2 (#112): revoking used to be one click. A live key stops working the
  // instant this returns and there is no undo, so it is asked for by name.
  const askRevoke = async (k: ApiKeyRow) => {
    const ok = await confirm({
      title: m.revokeTitle,
      message: t(m.revokeBody, { name: k.name }),
      confirmLabel: m.revoke,
      cancelLabel: m.cancel,
      destructive: true,
    });
    if (!ok) return;
    start(async () => {
      const r = await revokeApiKeyAction(k.id);
      if (r.ok) success(m.revokedToast);
      else error(r.error ?? m.genericError);
    });
  };

  return (
    <section className="mb-10">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{m.apiKeys}</h2>
        <Button size="lg" onClick={() => setOpen(true)}>
          {m.createKey}
        </Button>
      </div>
      {/* What this section is FOR — the page assumed its audience (QA2 fix 4). */}
      <p className="mb-3 max-w-prose text-sm text-muted-foreground">{m.apiKeysLead}</p>

      {reveal ? (
        <div className="mb-4 rounded-xl border border-primary-edge bg-card p-3">
          <p className="mb-1 text-sm text-muted-foreground">{m.copyOnce}</p>
          <code className="break-all font-mono text-sm">{reveal}</code>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {keys.map((k) => (
          <li
            key={k.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-border bg-card p-3"
          >
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{k.name}</span>{' '}
              <code className="font-mono text-xs text-muted-foreground">
                {k.prefix}…{k.last4}
              </code>
              {k.revoked_at_ms ? <span className="ml-2 text-destructive">{m.revoked}</span> : null}
            </span>
            {!k.revoked_at_ms ? (
              <Button
                variant="destructive"
                size="lg"
                disabled={pending}
                aria-label={`${m.revoke} · ${k.name}`}
                onClick={() => void askRevoke(k)}
              >
                {m.revoke}
              </Button>
            ) : null}
          </li>
        ))}
        {keys.length === 0 ? <li className="text-sm text-muted-foreground">{m.noKeys}</li> : null}
      </ul>

      <Modal open={open} onClose={() => setOpen(false)} title={m.createKey} labelId="new-api-key-title">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.name}</span>
            <Input
              value={name}
              data-modal-autofocus
              className="min-h-[44px]"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.scopes}</span>
            <div className="flex flex-col">
              {SCOPES.map((s) => (
                <label key={s} className="flex min-h-[44px] cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
                    }
                  />
                  <code className="font-mono text-xs text-foreground">{s}</code>
                </label>
              ))}
            </div>
          </div>
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="lg" onClick={() => setOpen(false)}>
              {m.cancel}
            </Button>
            <Button size="lg" disabled={pending || !name || scopes.length === 0} onClick={submit}>
              {pending ? m.creating : m.createKey}
            </Button>
          </div>
        </div>
      </Modal>
      {dialog}
    </section>
  );
}

function WebhookItem({
  w,
  start,
  pending,
  m,
  onAskDelete,
}: {
  w: WebhookRow;
  start: (fn: () => void | Promise<void>) => void;
  pending: boolean;
  m: DevMessages;
  onAskDelete: (w: WebhookRow) => void;
}) {
  const [ping, setPing] = useState<string | null>(null);
  // Delivery history (QA fix 10): fetched lazily on expand — proof that real
  // deliveries are landing, beyond the manual test ping.
  const [deliveries, setDeliveries] = useState<
    Array<{ id: string; event: string; ok: boolean; statusCode: number | null; error: string | null; createdAt: number }> | null
  >(null);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const { success, error } = useToast();
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      {/* Stacks at 360px: the URL owns the first line, the controls the next. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{w.subscriber_url}</code>
        <span className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-[44px] items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={w.active === 1}
              disabled={pending}
              aria-label={`${m.active} · ${w.subscriber_url}`}
              onCheckedChange={(next) =>
                start(async () => {
                  const r = await toggleWebhookAction(w.id, next);
                  if (r.ok) success(m.toggledToast);
                  else error(r.error ?? m.genericError);
                })
              }
            />
            {m.active}
          </label>
          <Button variant="outline" size="lg" disabled={pending} onClick={() => start(async () => setPing((await pingWebhookAction(w.id)).message))}>
            {m.ping}
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={pending}
            aria-expanded={showDeliveries}
            onClick={() => {
              const next = !showDeliveries;
              setShowDeliveries(next);
              if (next && deliveries === null)
                start(async () => setDeliveries((await webhookDeliveriesAction(w.id)).items));
            }}
          >
            <i
              aria-hidden
              className={`pi ${showDeliveries ? 'pi-chevron-down' : 'pi-chevron-right'}`}
              style={{ fontSize: 12 }}
            />
            {m.deliveries}
          </Button>
          <Button
            variant="destructive"
            size="lg"
            disabled={pending}
            aria-label={`${m.delete} · ${w.subscriber_url}`}
            onClick={() => onAskDelete(w)}
          >
            {m.delete}
          </Button>
        </span>
      </div>
      {ping ? <span className="text-xs text-muted-foreground">{ping}</span> : null}
      {showDeliveries ? (
        deliveries === null ? (
          <span className="text-xs text-muted-foreground">{m.loading}</span>
        ) : deliveries.length === 0 ? (
          <span className="text-xs text-muted-foreground">{m.noDeliveries}</span>
        ) : (
          <ul className="flex flex-col gap-1 border-t border-border pt-2">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs">
                {/* Was a bare ✓ / ✗ — a glyph doing an icon's job, with no
                    accessible name. Now the design language's own mark, with
                    the outcome spelled out for a screen reader. */}
                <span className={d.ok ? 'text-primary' : 'text-destructive'}>
                  <i
                    aria-hidden
                    className={`pi ${d.ok ? 'pi-check-circle' : 'pi-times-circle'}`}
                    style={{ fontSize: 12 }}
                  />
                  <span className="sr-only">{d.ok ? m.deliveryOk : m.deliveryFailed}</span>
                </span>
                <code className="font-mono">{d.event}</code>
                <span className="text-muted-foreground">
                  {d.statusCode ? `HTTP ${d.statusCode}` : (d.error ?? '')}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {new Date(d.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

export function Webhooks({
  webhooks,
  messages: m,
  locale,
}: {
  webhooks: WebhookRow[];
  messages: DevMessages;
  /** Active admin locale — the ConfirmDialog's own confirm/cancel copy. */
  locale?: Locale;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [triggers, setTriggers] = useState<string[]>(['booking.created']);
  const [reveal, setReveal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);

  /**
   * W (#75): the reply is now load-bearing in both directions, so neither half
   * may be dropped.
   *
   * On success the signing secret comes back ONCE — it is an envelope at rest
   * from here on, with no read endpoint — so it is revealed the way a new API
   * key is, immediately above the list. On failure the modal STAYS OPEN with the
   * typed url intact: a deployment with no encryption key refuses every create,
   * and closing the form on that answer would read as success.
   */
  const submit = () =>
    start(async () => {
      const r = await createWebhookAction(url, triggers);
      if (!r.ok) {
        error(r.code === 'INTEGRATION_KEY_MISSING' ? m.webhookNoKeyError : (r.error ?? m.genericError));
        return;
      }
      setReveal(r.secret ?? null);
      setUrl('');
      setTriggers(['booking.created']);
      setOpen(false);
    });

  // A2 (#112): deleting a webhook silently killed a live integration AND burned
  // its signing secret, which no endpoint hands back. It asks first, by URL.
  const askDelete = async (w: WebhookRow) => {
    const ok = await confirm({
      title: m.deleteWebhookTitle,
      message: t(m.deleteWebhookBody, { url: w.subscriber_url }),
      confirmLabel: m.delete,
      cancelLabel: m.cancel,
      destructive: true,
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteWebhookAction(w.id);
      if (r.ok) success(m.deletedToast);
      else error(r.error ?? m.genericError);
    });
  };

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{m.webhooks}</h2>
        <Button size="lg" onClick={() => setOpen(true)}>
          {m.addWebhook}
        </Button>
      </div>
      <p className="mb-3 max-w-prose text-sm text-muted-foreground">{m.webhooksLead}</p>

      {/* The one and only chance to read this secret — it is encrypted at rest
          from here on, and no endpoint gives it back (W / #75). */}
      {reveal ? (
        <div className="mb-4 rounded-xl border border-primary-edge bg-card p-3">
          <p className="mb-1 text-sm text-muted-foreground">{m.webhookSecretCopyOnce}</p>
          <code className="break-all font-mono text-sm">{reveal}</code>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {webhooks.map((w) => (
          <WebhookItem key={w.id} w={w} start={start} pending={pending} m={m} onAskDelete={(x) => void askDelete(x)} />
        ))}
        {webhooks.length === 0 ? <li className="text-sm text-muted-foreground">{m.noWebhooks}</li> : null}
      </ul>

      <Modal open={open} onClose={() => setOpen(false)} title={m.addWebhook} labelId="new-webhook-title">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.subscriberUrl}</span>
            <Input
              value={url}
              placeholder="https://…"
              data-modal-autofocus
              className="min-h-[44px]"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.events}</span>
            <div className="flex flex-col">
              {TRIGGERS.map((tr) => (
                <label key={tr} className="flex min-h-[44px] cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={triggers.includes(tr)}
                    onChange={(e) =>
                      setTriggers((cur) => (e.target.checked ? [...cur, tr] : cur.filter((x) => x !== tr)))
                    }
                  />
                  {tr.replace('booking.', '')}
                </label>
              ))}
            </div>
          </div>
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="lg" onClick={() => setOpen(false)}>
              {m.cancel}
            </Button>
            <Button size="lg" disabled={pending || !url} onClick={submit}>
              {pending ? m.creating : m.addWebhook}
            </Button>
          </div>
        </div>
      </Modal>
      {dialog}
    </section>
  );
}
