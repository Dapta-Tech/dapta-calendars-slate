'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { t, type BookingMessages, type Locale } from '@slate/shared';
import { Modal } from '@/components/modal';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import type { ApiKeyRow, WebhookRow } from '@/lib/admin-api';
import { EXPIRY_PRESET_DAYS, expiryState, SCOPE_CATALOG, scopeLabel, toMs } from '@/lib/mcp-connect';
import { KindChip } from './connect-agent';
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

const DEFAULT_SCOPES = ['availability:read'];

/** A fixed, locale-free date so server and client render the same text. */
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function KeyFacts({ k, m, now, eventTypeTitles }: { k: ApiKeyRow; m: DevMessages; now: number; eventTypeTitles: Map<string, string> }) {
  const state = expiryState(k.expiresAt, now);
  const expMs = toMs(k.expiresAt);
  const last = toMs(k.lastUsedAt);
  const ids = k.eventTypeIds ?? [];
  const scopes = k.scopes ?? null;
  return (
    <div className="flex basis-full flex-col gap-tight text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-inline">
        {scopes === null ? (
          <span>{m.keyScopesUnknown}</span>
        ) : (
          scopes.map((s) => (
            <span key={s} className="inline-flex items-center rounded-full bg-muted px-inline py-tight text-foreground">
              {scopeLabel(m.scopeLabels, s)}
            </span>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-field gap-y-tight">
        {/* A field the API did not send is left out, not shown as a default: an
            older API must never make a limited key read "all event types". */}
        {k.eventTypeIds !== undefined ? (
          <span title={ids.map((id) => eventTypeTitles.get(id) ?? id).join(', ') || undefined}>
            {ids.length === 0 ? m.keyAllEventTypes : t(m.keyOnlyEventTypes, { count: String(ids.length) })}
          </span>
        ) : null}
        {k.expiresAt !== undefined ? (
          <span className={state === 'expired' ? 'text-destructive' : undefined}>
            {expMs === null ? m.keyNoExpiry : t(state === 'expired' ? m.keyExpired : m.keyExpires, { date: day(expMs) })}
          </span>
        ) : null}
        {k.lastUsedAt !== undefined ? (
          <span>{last === null ? m.keyNeverUsed : t(m.keyLastUsed, { date: day(last) })}</span>
        ) : null}
      </div>
    </div>
  );
}

const TRIGGERS = ['booking.created', 'booking.rescheduled', 'booking.cancelled'];

export function ApiKeys({
  keys,
  eventTypes = [],
  now,
  messages: m,
  locale,
  createOpen,
  onCreateOpenChange,
  showCreate = true,
}: {
  keys: ApiKeyRow[];
  /** For the optional allowlist; empty hides the picker. */
  eventTypes?: Array<{ id: string; title: string }>;
  /** Server clock at render, so "expired" is the same on both sides of hydration. */
  now: number;
  messages: DevMessages;
  /** Active admin locale — the ConfirmDialog's own confirm/cancel copy. */
  locale?: Locale;
  /** The create dialog, when something else on the page opens it too (the setup guide). */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  /** Off while the setup guide's first step holds the page's one Create (R30). */
  showCreate?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = createOpen ?? ownOpen;
  const setOpen = onCreateOpenChange ?? setOwnOpen;
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [limitTypes, setLimitTypes] = useState(false);
  const [typeIds, setTypeIds] = useState<string[]>([]);
  const [expiryDays, setExpiryDays] = useState(0);
  const eventTypeTitles = new Map(eventTypes.map((e) => [e.id, e.title]));
  const [reveal, setReveal] = useState<string | null>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);

  // The new key is shown once, here, below the setup guide: from the guide's
  // step 1 that is a screen or more away, and the button that opened the dialog
  // is gone as soon as a key exists, so the dialog has nothing to hand focus
  // back to. Bring the key into view and put focus on it instead. Runs after
  // the dialog's own focus restore (cleanups first), so it wins.
  useEffect(() => {
    if (!reveal) return;
    revealRef.current?.scrollIntoView({ block: 'center' });
    revealRef.current?.focus();
  }, [reveal]);

  const submit = () =>
    start(async () => {
      const r = await createApiKeyAction({
        name,
        scopes,
        eventTypeIds: limitTypes ? typeIds : undefined,
        expiresInDays: expiryDays,
      });
      if (r.plaintext) {
        setReveal(r.plaintext);
        setName('');
        setScopes(DEFAULT_SCOPES);
        setLimitTypes(false);
        setTypeIds([]);
        setExpiryDays(0);
        setOpen(false);
      } else {
        // The modal stays open with everything typed: an API that predates a
        // scope refuses the key, and closing the form would read as success.
        error(r.error ?? m.genericError);
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
    <section className="mb-section">
      <div className="mb-tight flex flex-wrap items-center justify-between gap-field">
        <h2 className="text-xl font-semibold">{m.apiKeys}</h2>
        {showCreate ? (
          <Button size="lg" onClick={() => setOpen(true)}>
            {m.createKey}
          </Button>
        ) : null}
      </div>
      {/* What this section is FOR — the page assumed its audience (QA2 fix 4). */}
      <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.apiKeysLead}</p>

      {reveal ? (
        <div
          ref={revealRef}
          tabIndex={-1}
          data-testid="api-key-reveal"
          className="mb-card rounded-xl border border-primary-edge bg-card p-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="mb-tight text-sm text-muted-foreground">{m.copyOnce}</p>
          <code className="break-all font-mono text-sm">{reveal}</code>
        </div>
      ) : null}

      <ul className="flex flex-col gap-inline">
        {keys.map((k) => (
          <li
            key={k.id}
            className="flex flex-wrap items-center justify-between gap-x-field gap-y-inline rounded-xl border border-border bg-card p-field"
          >
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{k.name}</span>{' '}
              <code className="font-mono text-xs text-muted-foreground">
                {k.prefix}…{k.last4}
              </code>
              {k.revoked_at_ms ? <span className="ml-inline text-destructive">{m.revoked}</span> : null}
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
            {!k.revoked_at_ms ? <KeyFacts k={k} m={m} now={now} eventTypeTitles={eventTypeTitles} /> : null}
          </li>
        ))}
        {keys.length === 0 ? <li className="text-sm text-muted-foreground">{m.noKeys}</li> : null}
      </ul>

      <Modal open={open} onClose={() => setOpen(false)} title={m.createKey} labelId="new-api-key-title">
        <div className="flex flex-col gap-card">
          <label className="flex flex-col gap-tight text-sm">
            <span className="text-muted-foreground">{m.name}</span>
            <Input
              value={name}
              data-modal-autofocus
              className="min-h-control"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-tight text-sm">
            <legend className="text-muted-foreground">{m.scopesLead}</legend>
            <div className="flex flex-col">
              {SCOPE_CATALOG.map(({ scope, kind }) => (
                <label key={scope} className="flex min-h-control cursor-pointer items-center gap-inline">
                  <Checkbox
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((cur) => (e.target.checked ? [...cur, scope] : cur.filter((x) => x !== scope)))
                    }
                  />
                  <span className="min-w-0 flex-1">{scopeLabel(m.scopeLabels, scope)}</span>
                  <KindChip kind={kind} m={m} />
                </label>
              ))}
            </div>
          </fieldset>
          {eventTypes.length > 0 ? (
            <fieldset className="flex flex-col gap-tight text-sm">
              <legend className="text-muted-foreground">{m.eventTypesLabel}</legend>
              <label className="flex min-h-control cursor-pointer items-center gap-inline">
                <Checkbox checked={!limitTypes} onChange={() => setLimitTypes(false)} />
                {m.eventTypesAll}
              </label>
              <label className="flex min-h-control cursor-pointer items-center gap-inline">
                <Checkbox checked={limitTypes} onChange={() => setLimitTypes(true)} />
                {m.eventTypesOnly}
              </label>
              {limitTypes ? (
                <div className="ml-group flex flex-col">
                  {eventTypes.map((et) => (
                    <label key={et.id} className="flex min-h-control cursor-pointer items-center gap-inline">
                      <Checkbox
                        checked={typeIds.includes(et.id)}
                        onChange={(e) =>
                          setTypeIds((cur) => (e.target.checked ? [...cur, et.id] : cur.filter((x) => x !== et.id)))
                        }
                      />
                      {et.title}
                    </label>
                  ))}
                </div>
              ) : null}
            </fieldset>
          ) : null}
          <div className="flex flex-col gap-tight text-sm">
            <span className="text-muted-foreground">{m.expiryLabel}</span>
            <Select
              value={String(expiryDays)}
              onChange={(v) => setExpiryDays(Number(v))}
              options={EXPIRY_PRESET_DAYS.map((d) => ({
                value: String(d),
                label: d === 0 ? m.expiryNever : t(m.expiryDays, { days: String(d) }),
              }))}
              locale={locale}
              ariaLabel={m.expiryLabel}
            />
          </div>
          <div className="mt-tight flex flex-wrap justify-end gap-inline">
            <Button variant="outline" size="lg" onClick={() => setOpen(false)}>
              {m.cancel}
            </Button>
            <Button size="lg" disabled={pending || !name || scopes.length === 0 || (limitTypes && typeIds.length === 0)} onClick={submit}>
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
    <li className="flex flex-col gap-inline rounded-xl border border-border bg-card p-field">
      {/* Stacks at 360px: the URL owns the first line, the controls the next. */}
      <div className="flex flex-wrap items-center justify-between gap-x-field gap-y-inline">
        <code className="min-w-0 flex-1 break-all font-mono text-xs">{w.subscriber_url}</code>
        <span className="flex flex-wrap items-center gap-inline">
          {/* A <span>, not a <label>. `Switch` renders `<button role="switch">`,
              and a button is NOT a labelable element — wrapping it in a label
              would neither make the word clickable nor make it the control's
              programmatic name. The name is the `aria-label`, which also carries
              the URL so a screen reader knows WHICH webhook it is toggling; the
              word beside it is the visible caption, as on the notifications
              rows. */}
          <span className="flex min-h-control items-center gap-inline text-xs text-muted-foreground">
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
          </span>
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
          <ul className="flex flex-col gap-tight border-t border-border pt-inline">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-inline text-xs">
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
      {/* The whole of MCP, Webhooks: the title and lead are the page header,
          with Add webhook top-right where a list page keeps its create action. */}
      <PageHeader
        title={m.webhooks}
        subtitle={m.webhooksLead}
        longSubtitle
        action={
          <Button size="lg" onClick={() => setOpen(true)}>
            {m.addWebhook}
          </Button>
        }
      />

      {/* The one and only chance to read this secret — it is encrypted at rest
          from here on, and no endpoint gives it back (W / #75). */}
      {reveal ? (
        <div className="mb-card rounded-xl border border-primary-edge bg-card p-field">
          <p className="mb-tight text-sm text-muted-foreground">{m.webhookSecretCopyOnce}</p>
          <code className="break-all font-mono text-sm">{reveal}</code>
        </div>
      ) : null}

      <ul className="flex flex-col gap-inline">
        {webhooks.map((w) => (
          <WebhookItem key={w.id} w={w} start={start} pending={pending} m={m} onAskDelete={(x) => void askDelete(x)} />
        ))}
        {webhooks.length === 0 ? <li className="text-sm text-muted-foreground">{m.noWebhooks}</li> : null}
      </ul>

      <Modal open={open} onClose={() => setOpen(false)} title={m.addWebhook} labelId="new-webhook-title">
        <div className="flex flex-col gap-card">
          <label className="flex flex-col gap-tight text-sm">
            <span className="text-muted-foreground">{m.subscriberUrl}</span>
            <Input
              value={url}
              placeholder="https://…"
              data-modal-autofocus
              className="min-h-control"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className="flex flex-col gap-tight text-sm">
            <span className="text-muted-foreground">{m.events}</span>
            <div className="flex flex-col">
              {TRIGGERS.map((tr) => (
                <label key={tr} className="flex min-h-control cursor-pointer items-center gap-inline">
                  <Checkbox
                    checked={triggers.includes(tr)}
                    onChange={(e) =>
                      setTriggers((cur) => (e.target.checked ? [...cur, tr] : cur.filter((x) => x !== tr)))
                    }
                  />
                  {/* The label in the reader's language; the wire name, which
                      the payload carries, as it is. */}
                  <span>{m.webhookEventLabels[tr.replace('booking.', '')] ?? tr}</span>
                  <code className="font-mono text-xs text-muted-foreground">{tr}</code>
                </label>
              ))}
            </div>
          </div>
          <div className="mt-tight flex flex-wrap justify-end gap-inline">
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
