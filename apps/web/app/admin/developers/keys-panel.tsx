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
 * a time (the guide's while there is no working key, the list's after).
 */
export function KeysPanel({
  keys,
  eventTypes,
  now,
  snippets,
  oauth,
  appsConnected,
  productName,
  docsLabel,
  messages: m,
  locale,
}: {
  keys: ApiKeyRow[];
  eventTypes: Array<{ id: string; title: string }>;
  now: number;
  snippets: ConnectSnippets | null;
  oauth: boolean;
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
        snippets={snippets}
        oauth={oauth}
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
        showCreate={hasKey}
      />
    </>
  );
}
