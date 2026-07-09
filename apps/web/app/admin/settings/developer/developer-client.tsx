'use client';

import { useState, useTransition } from 'react';
import type { ApiKeyRow, WebhookRow } from '@/lib/admin-api';
import {
  createApiKeyAction,
  createWebhookAction,
  deleteWebhookAction,
  pingWebhookAction,
  toggleWebhookAction,
  revokeApiKeyAction,
} from './actions';

const SCOPES = ['availability:read', 'bookings:read', 'bookings:write'];
const TRIGGERS = ['booking.created', 'booking.rescheduled', 'booking.cancelled'];

export function ApiKeys({ keys }: { keys: ApiKeyRow[] }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['availability:read']);
  const [reveal, setReveal] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-xl font-semibold">API keys</h2>
      <ul className="mb-4 flex flex-col gap-2">
        {keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between rounded-md border border-border bg-card p-3">
            <span className="text-sm">
              <span className="font-medium">{k.name}</span>{' '}
              <code className="text-muted-foreground">{k.prefix}…{k.last4}</code>
              {k.revoked_at_ms ? <span className="ml-2 text-destructive">revoked</span> : null}
            </span>
            {!k.revoked_at_ms ? (
              <button
                type="button"
                onClick={() => start(() => revokeApiKeyAction(k.id))}
                className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
              >
                Revoke
              </button>
            ) : null}
          </li>
        ))}
        {keys.length === 0 ? <li className="text-sm text-muted-foreground">No API keys.</li> : null}
      </ul>

      {reveal ? (
        <div className="mb-4 rounded-md border border-primary bg-card p-3">
          <p className="mb-1 text-sm text-muted-foreground">Copy this now — it won’t be shown again:</p>
          <code className="break-all text-sm">{reveal}</code>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2" />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Scopes</span>
          <div className="flex gap-3">
            {SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={pending || !name || scopes.length === 0}
          onClick={() =>
            start(async () => {
              const r = await createApiKeyAction(name, scopes);
              if (r.plaintext) {
                setReveal(r.plaintext);
                setName('');
              }
            })
          }
          className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? '…' : 'Create key'}
        </button>
      </div>
    </section>
  );
}

function WebhookItem({
  w,
  start,
  pending,
}: {
  w: WebhookRow;
  start: (fn: () => void) => void;
  pending: boolean;
}) {
  const [ping, setPing] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <code className="break-all text-sm">{w.subscriber_url}</code>
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={w.active === 1}
              disabled={pending}
              onChange={(e) => start(() => toggleWebhookAction(w.id, e.target.checked))}
            />
            active
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => setPing((await pingWebhookAction(w.id)).message))}
            className="rounded-md border border-border px-3 py-1 text-sm hover:border-primary"
          >
            Ping
          </button>
          <button
            type="button"
            onClick={() => start(() => deleteWebhookAction(w.id))}
            className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
          >
            Delete
          </button>
        </span>
      </div>
      {ping ? <span className="text-xs text-muted-foreground">{ping}</span> : null}
    </li>
  );
}

export function Webhooks({ webhooks }: { webhooks: WebhookRow[] }) {
  const [url, setUrl] = useState('');
  const [triggers, setTriggers] = useState<string[]>(['booking.created']);
  const [pending, start] = useTransition();

  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold">Webhooks</h2>
      <ul className="mb-4 flex flex-col gap-2">
        {webhooks.map((w) => (
          <WebhookItem key={w.id} w={w} start={start} pending={pending} />
        ))}
        {webhooks.length === 0 ? <li className="text-sm text-muted-foreground">No webhooks.</li> : null}
      </ul>
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Subscriber URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="w-72 rounded-md border border-input bg-background px-3 py-2" />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Events</span>
          <div className="flex gap-3">
            {TRIGGERS.map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={triggers.includes(t)}
                  onChange={(e) => setTriggers((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))}
                />
                {t.replace('booking.', '')}
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={pending || !url}
          onClick={() => start(async () => { await createWebhookAction(url, triggers); setUrl(''); })}
          className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? '…' : 'Add webhook'}
        </button>
      </div>
    </section>
  );
}
