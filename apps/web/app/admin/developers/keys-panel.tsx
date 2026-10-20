'use client';

import { useState } from 'react';
import type { BookingMessages, Locale } from '@slate/shared';
import type { ApiKeyRow } from '@/lib/admin-api';
import { expiryState, toMs } from '@/lib/mcp-connect';
import type { ConnectSnippets } from './connect-agent';
import { ApiKeys } from './developer-client';
import { SetupGuide } from './setup-guide';

type DevMessages = BookingMessages['admin']['developer'];

/** A key an agent could use right now: not revoked, not past its expiry. */
export function isWorkingKey(k: ApiKeyRow, now: number): boolean {
  return !k.revoked_at_ms && expiryState(k.expiresAt, now) !== 'expired';
}

/**
 * The setup guide above the key list, sharing one create dialog: step 1's
 * button and the list's Create open the same one, and only one of them shows at
 * a time (the guide's while there is no working key, the list's after, and
 * always the list's while the API does not serve MCP and the guide has no steps).
 */
export function KeysPanel({
  keys,
  eventTypes,
  now,
  mcpAvailable,
  snippets,
  oauth,
  external,
  appsConnected,
  productName,
  docsLabel,
  messages: m,
  locale,
}: {
  keys: ApiKeyRow[];
  eventTypes: Array<{ id: string; title: string }>;
  now: number;
  /** The API says it serves MCP; off, the guide has no steps (see SetupGuide). */
  mcpAvailable: boolean;
  snippets: ConnectSnippets | null;
  oauth: boolean;
  /** People sign in through an external authorization server (see ConnectAgent). */
  external: boolean;
  /** Some app has signed in through OAuth: an agent is connected without a key. */
  appsConnected: boolean;
  productName: string;
  docsLabel: string;
  messages: DevMessages;
  locale: Locale;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const working = keys.filter((k) => isWorkingKey(k, now));
  const hasKey = working.length > 0;
  const agentConnected = appsConnected || working.some((k) => toMs(k.lastUsedAt) !== null);
  return (
    <>
      <SetupGuide
        m={m}
        mcpAvailable={mcpAvailable}
        snippets={snippets}
        oauth={oauth}
        external={external}
        hasKey={hasKey}
        agentConnected={agentConnected}
        productName={productName}
        docsLabel={docsLabel}
        onCreate={() => setCreateOpen(true)}
      />
      <ApiKeys
        keys={keys}
        eventTypes={eventTypes}
        now={now}
        messages={m}
        locale={locale}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
        // The guide's step 1 holds the page's one Create until a key exists;
        // with MCP off there is no step 1, so the list keeps it.
        showCreate={hasKey || !mcpAvailable}
      />
    </>
  );
}
