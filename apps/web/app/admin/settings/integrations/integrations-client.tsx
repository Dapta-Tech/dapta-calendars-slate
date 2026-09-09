'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import type { BookingMessages, Locale } from '@slate/shared';
import type { IntegrationCapabilities, IntegrationStatusView } from '@slate/types';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/components/toast';
import {
  availability,
  canConnect,
  canDisconnect,
  connectionState,
  rowFor,
  scopeChecklist,
  unhealthyReason,
  type Availability,
  type ConnectFailure,
  type ConnectionState,
} from './status';
import { connectIntegrationAction, disconnectIntegrationAction } from './actions';

type Msgs = BookingMessages['admin']['integrations'];

/** Replace `{key}` tokens in a catalog string — the locale copy owns wording. */
const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

/**
 * The one CRM the pilot ships. A second one is a second entry here plus its own
 * name/description keys — there is no provider-specific branching below this
 * line, which is what keeps the settings chrome vendor-neutral (#93, story 42).
 */
const PROVIDERS = [{ id: 'hubspot', nameKey: 'hubspotName', descKey: 'hubspotDesc' }] as const;

// 44px minimum on every touch target (mobile bar). Matches the members and
// developer tabs, which already inline this recipe rather than importing one.
const TOUCH = 'min-h-[44px]';

export function IntegrationsPanel({
  rows,
  capabilities,
  loadError,
  locale,
  timeZone,
  messages: m,
}: {
  rows: IntegrationStatusView[];
  capabilities: IntegrationCapabilities | null;
  loadError: boolean;
  locale: Locale;
  timeZone: string;
  messages: Msgs;
}) {
  const [current, setCurrent] = useState(rows);
  // A write revalidates this route, so the server sends fresh rows down as a
  // prop. Without this the optimistic value would outlive the truth it was
  // guessing at, and the revalidate would be dead work.
  useEffect(() => setCurrent(rows), [rows]);

  return (
    <div className="flex flex-col gap-4">
      {loadError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {m.loadError}
        </p>
      ) : null}

      {/* No card when the rows could not be read. `rows: []` renders as "never
          connected" with a live Connect button, and telling an account that may
          well be connected that nothing is being sent — directly under a banner
          admitting we could not load it — is worse than showing nothing. */}
      {loadError ? null : PROVIDERS.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p.id}
          name={m[p.nameKey]}
          description={m[p.descKey]}
          row={rowFor(current, p.id)}
          capabilities={capabilities}
          onRow={(next) =>
            setCurrent((prev) => {
              const rest = prev.filter((r) => r.provider !== p.id);
              return next ? [...rest, next] : rest;
            })
          }
          locale={locale}
          timeZone={timeZone}
          m={m}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  provider,
  name,
  description,
  row,
  capabilities,
  onRow,
  locale,
  timeZone,
  m,
}: {
  provider: string;
  name: string;
  description: string;
  row: IntegrationStatusView | undefined;
  capabilities: IntegrationCapabilities | null;
  onRow: (next: IntegrationStatusView | null) => void;
  locale: Locale;
  timeZone: string;
  m: Msgs;
}) {
  const { success, error } = useToast();
  const [pending, start] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const noteId = useId();

  const state = connectionState(row);
  // Both derivations are told WHICH provider this card is: a deployment can
  // have an adapter that is not this one, and offering Connect there would only
  // ever answer CRM_DISABLED.
  const avail = availability(capabilities, provider);
  const connectable = canConnect(capabilities, provider);

  function disconnect() {
    start(async () => {
      const res = await disconnectIntegrationAction(provider);
      // `disconnected: false` means there was nothing to disconnect. Reporting
      // success and flipping the card for a no-op would be a lie the next page
      // load contradicts.
      if (!res.ok || !res.disconnected) {
        error(m.errorGeneric);
        return;
      }
      setConfirming(false);
      // Mirrors the server's soft delete: the row SURVIVES with its label and
      // last4 (#63), so the card must show "disconnected", not "never
      // connected". Dropping it here would offer Connect where Reconnect
      // belongs and hide the history the host just made. The health fields are
      // nulled to match what the server writes, so a stale scope list cannot
      // resurface if the row is later reconnected.
      onRow(
        row
          ? { ...row, status: 'disconnected', lastCheckDetail: null, lastErrorDetail: null }
          : null,
      );
      success(m.disconnectedToast);
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      {/* Wraps at narrow widths so the badge drops under the title instead of
          squeezing it — the card has to survive 360px. */}
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="font-semibold tracking-tight">{name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <StatusBadge state={state} m={m} />
      </header>

      <Details row={row} state={state} locale={locale} timeZone={timeZone} m={m} />

      {avail !== 'ok' ? <UnavailableNote availability={avail} id={noteId} m={m} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {state === 'connected' || state === 'unhealthy' ? null : (
          <Button
            className={TOUCH}
            disabled={!connectable || pending}
            // A disabled button explains itself: the note above says which of
            // the deployment states put it out of reach.
            aria-describedby={connectable ? undefined : noteId}
            onClick={() => setDialogOpen(true)}
          >
            {state === 'disconnected' ? m.reconnect : m.connect}
          </Button>
        )}

        {canDisconnect(row) && !confirming ? (
          <Button
            variant="destructive"
            className={TOUCH}
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            {m.disconnect}
          </Button>
        ) : null}
      </div>

      {confirming ? (
        // Inline confirm, following the members tab. Disconnecting unplugs the
        // whole workspace's CRM, so it is never a single click.
        <div className="flex flex-col gap-2 rounded-md border border-destructive/60 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-foreground">{m.disconnectConfirm}</p>
          <p className="text-sm text-muted-foreground">{m.disconnectNothingDeleted}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              className={TOUCH}
              disabled={pending}
              onClick={disconnect}
            >
              {pending ? m.disconnecting : m.confirmDisconnect}
            </Button>
            <Button
              variant="outline"
              className={TOUCH}
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {m.cancel}
            </Button>
          </div>
        </div>
      ) : null}

      <ConnectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConnected={(status) => {
          onRow(status);
          setDialogOpen(false);
          success(m.connectedToast);
        }}
        provider={provider}
        titleId={titleId}
        scopes={scopeChecklist(capabilities, provider)}
        m={m}
      />
    </section>
  );
}

/**
 * State as TEXT plus a dot, never colour alone — the dot is decorative and the
 * word carries the meaning, so the card reads the same to a screen reader and
 * in a colour-blind palette.
 */
function StatusBadge({ state, m }: { state: ConnectionState; m: Msgs }) {
  const label =
    state === 'connected'
      ? m.statusConnected
      : state === 'unhealthy'
        ? m.statusUnhealthy
        : state === 'disconnected'
          ? m.statusDisconnected
          : m.statusNotConnected;
  const tone =
    state === 'connected'
      ? 'border-primary-edge/50 bg-primary/10 text-foreground'
      : state === 'unhealthy'
        ? 'border-destructive bg-destructive/10 text-destructive'
        : 'border-border bg-muted/50 text-muted-foreground';
  const dot =
    state === 'connected'
      ? 'bg-primary'
      : state === 'unhealthy'
        ? 'bg-destructive'
        : 'bg-muted-foreground';
  return (
    <span
      data-testid="integration-status"
      data-state={state}
      className={
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ' +
        tone
      }
    >
      <span aria-hidden className={'h-1.5 w-1.5 rounded-full ' + dot} />
      {label}
    </span>
  );
}

/** What the card knows about the credential. Never the credential. */
function Details({
  row,
  state,
  locale,
  timeZone,
  m,
}: {
  row: IntegrationStatusView | undefined;
  state: ConnectionState;
  locale: Locale;
  timeZone: string;
  m: Msgs;
}) {
  if (state === 'none') return <p className="text-sm text-muted-foreground">{m.notConnectedBody}</p>;

  // An EXPLICIT zone, not the runtime's. `lastCheckAt` arrives as a server prop
  // and this is a client component, so a zone-less formatter renders in the
  // server's zone and hydrates in the browser's — a hydration mismatch on every
  // account that has ever been checked. The account's own zone is also the
  // right answer for the reader.
  const checked =
    row?.lastCheckAt != null
      ? fill(m.lastChecked, {
          date: new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone,
          }).format(new Date(row.lastCheckAt)),
        })
      : m.neverChecked;

  return (
    <div className="flex flex-col gap-3">
      {/* Plain text, not a <dl>: these are two facts about one credential, not
          term/definition pairs, and a <dd> without a <dt> reads to a screen
          reader as a definition of nothing. */}
      <div className="min-w-0 space-y-0.5 text-sm">
        {row?.label ? <p className="font-medium text-foreground">{row.label}</p> : null}
        {/* `break-words` so a long portal name cannot push the card sideways. */}
        <p className="break-words text-xs text-muted-foreground">
          {row?.tokenLast4 ? `${fill(m.endingIn, { last4: row.tokenLast4 })} · ` : ''}
          {checked}
        </p>
      </div>

      {state === 'unhealthy' ? <UnhealthyDetail row={row} m={m} /> : null}
      {state === 'disconnected' ? (
        <p className="text-sm text-muted-foreground">{m.disconnectedBody}</p>
      ) : null}
    </div>
  );
}

/**
 * The one screen #74 made possible: when the provider named the scopes it was
 * missing, they are rendered LITERALLY, unmapped and untranslated, because the
 * host has to match them character-for-character against a checkbox in the
 * provider's own UI.
 */
function UnhealthyDetail({ row, m }: { row: IntegrationStatusView | undefined; m: Msgs }) {
  const reason = unhealthyReason(row);
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-destructive/60 bg-destructive/5 p-3"
    >
      <p className="text-sm font-medium text-foreground">{m.unhealthyLead}</p>

      {reason.kind === 'scopes' ? (
        <>
          <p className="text-sm text-muted-foreground">{m.unhealthyScopes}</p>
          <ScopeList scopes={reason.scopes} />
          <p className="text-sm text-muted-foreground">{m.unhealthyKeepsCredential}</p>
        </>
      ) : reason.kind === 'message' ? (
        <p className="break-words text-sm text-muted-foreground">{reason.message}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{m.unhealthyUnknown}</p>
      )}
    </div>
  );
}

/** Provider scope identifiers. `break-all` because they are long and unspaced. */
function ScopeList({ scopes }: { scopes: string[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {scopes.map((s) => (
        <li key={s}>
          <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
            {s}
          </code>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why connecting is not on offer. Says WHICH reason, never just "no" — and
 * `unknown` is its own state rather than being folded into `disabled`: a probe
 * that failed has not established that a CRM is switched off, and telling a
 * correctly configured deployment to go set `CRM_PROVIDER` would be a confident
 * wrong answer to a question we never got to ask.
 */
function UnavailableNote({
  availability: a,
  id,
  m,
}: {
  availability: Exclude<Availability, 'ok'>;
  id: string;
  m: Msgs;
}) {
  const [title, body] =
    a === 'disabled'
      ? [m.disabledTitle, m.disabledBody]
      : a === 'no-key'
        ? [m.noKeyTitle, m.noKeyBody]
        : [m.unknownTitle, m.unknownBody];
  return (
    <div id={id} className="rounded-md border border-dashed border-border bg-muted/40 p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * The connect surface: the scope checklist and the token field, together.
 *
 * The checklist is ADVISORY. Ticking a box sends nothing — `#63` rejected
 * introspecting a token for its scope list, so the request carries provider,
 * token and label and no scopes. The boxes exist so the host can track their
 * own progress against the provider's screen while they work.
 */
function ConnectDialog({
  open,
  onClose,
  onConnected,
  provider,
  titleId,
  scopes,
  m,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (status: IntegrationStatusView) => void;
  provider: string;
  titleId: string;
  /** From the ADAPTER, via the capabilities reply — never from the catalog. */
  scopes: string[];
  m: Msgs;
}) {
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [pending, start] = useTransition();

  function close() {
    // The token never outlives the dialog, not even in React state.
    setToken('');
    setLabel('');
    setChecked([]);
    setFailure(null);
    onClose();
  }

  function submit() {
    const trimmed = token.trim();
    if (!trimmed || pending) return;
    setFailure(null);
    start(async () => {
      const res = await connectIntegrationAction(provider, trimmed, label);
      if (res.ok) {
        setToken('');
        setLabel('');
        setChecked([]);
        onConnected(res.status);
        return;
      }
      // Kept in the dialog, not thrown as a toast: the host is mid-task and the
      // fix (a scope, another token) happens right here.
      setFailure(res.failure);
    });
  }

  return (
    <Modal open={open} onClose={close} title={m.dialogTitle} labelId={titleId}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{m.dialogLead}</p>

        {/* Absent only if the adapter reports none, which the disabled Connect
            button already prevented reaching. Rendered from the provider's own
            list so the instructions cannot drift from what it needs. */}
        {scopes.length > 0 ? (
        <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{m.scopesTitle}</legend>
          <p className="text-xs text-muted-foreground">{m.scopesLead}</p>
          {scopes.map((scope) => (
            <label
              key={scope}
              className={`flex ${TOUCH} cursor-pointer items-center gap-2 text-sm`}
            >
              <Checkbox
                checked={checked.includes(scope)}
                onChange={(e) =>
                  setChecked((cur) =>
                    e.target.checked ? [...cur, scope] : cur.filter((s) => s !== scope),
                  )
                }
              />
              <code className="break-all text-xs text-foreground">{scope}</code>
            </label>
          ))}
        </fieldset>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{m.tokenLabel}</span>
          <Input
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder={m.tokenPlaceholder}
            // The dialog opens on the thing the host came to do. Without this
            // the modal's generic "first control" rule lands focus on the first
            // scope checkbox instead.
            data-modal-autofocus
            className={TOUCH}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <span className="text-xs text-muted-foreground">{m.tokenHelp}</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{m.labelLabel}</span>
          <Input
            value={label}
            maxLength={80}
            placeholder={m.labelPlaceholder}
            className={TOUCH}
            onChange={(e) => setLabel(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">{m.labelHelp}</span>
        </label>

        {failure ? <ConnectError failure={failure} m={m} /> : null}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <Button variant="outline" className={TOUCH} disabled={pending} onClick={close}>
            {m.cancel}
          </Button>
          <Button className={TOUCH} disabled={pending || !token.trim()} onClick={submit}>
            {pending ? m.connecting : m.connect}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A refusal, in the host's language, plus the scope names in the provider's.
 *
 * Every branch says NOTHING WAS SAVED, because the API is fail-closed and the
 * host's next question after "rejected" is always whether a half-broken
 * credential is now sitting in the account.
 */
function ConnectError({ failure, m }: { failure: ConnectFailure; m: Msgs }) {
  const headline =
    failure.kind === 'scopes'
      ? m.errorMissingScopes
      : failure.kind === 'rejected'
        ? m.errorRejected
        : failure.kind === 'unverified'
          ? m.errorUnverified
          : failure.kind === 'no-key'
            ? m.errorNoKey
            : failure.kind === 'disabled'
              ? m.errorDisabled
              : m.errorGeneric;

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3"
    >
      <p className="text-sm font-medium text-destructive">{headline}</p>
      {failure.kind === 'scopes' ? <ScopeList scopes={failure.scopes} /> : null}
      <p className="text-xs text-muted-foreground">{m.nothingStored}</p>
    </div>
  );
}
