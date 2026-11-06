'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { EventTypeMessages } from './shared';

/** One value an agent needs, with a copy button. */
function CopyRow({ label, value, m }: { label: string; value: string; m: EventTypeMessages['editor']['agents'] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the value is still selectable */
    }
  };
  return (
    <div className="flex flex-col gap-tight">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-inline">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-muted px-inline py-inline font-mono text-xs text-foreground">
          {value}
        </code>
        <Button type="button" variant="outline" size="lg" onClick={copy} className="shrink-0">
          {copied ? m.copied : m.copy}
        </Button>
        <span className="sr-only" aria-live="polite">
          {copied ? m.copied : ''}
        </span>
      </div>
    </div>
  );
}

/**
 * How an AI agent books THIS event — read-only, nothing here is saved with the
 * event. Agents reach events through the MCP server: by the event's ID, or by
 * its booking page. Before the first save there is no ID yet, and an
 * installation without a sign-in MCP address says so instead of showing one.
 */
export function AgentsTab({
  eventTypeId,
  title,
  mcpUrl,
  m,
}: {
  eventTypeId?: string;
  title: string;
  mcpUrl?: string | null;
  m: EventTypeMessages['editor']['agents'];
}) {
  const prompt = m.prompt.replace('{title}', title.trim() || '…');
  return (
    <section className="flex flex-col gap-card">
      <div className="flex flex-col gap-tight">
        <h2 className="text-base font-semibold text-foreground">{m.title}</h2>
        <p className="text-sm text-muted-foreground">{m.intro}</p>
      </div>
      {eventTypeId ? (
        <CopyRow label={m.eventIdLabel} value={eventTypeId} m={m} />
      ) : (
        <div className="flex flex-col gap-tight">
          <span className="text-sm text-muted-foreground">{m.eventIdLabel}</span>
          <p className="text-sm text-muted-foreground">{m.eventIdPending}</p>
        </div>
      )}
      <CopyRow label={m.promptLabel} value={prompt} m={m} />
      {mcpUrl ? (
        <CopyRow label={m.mcpLabel} value={mcpUrl} m={m} />
      ) : (
        <div className="flex flex-col gap-tight">
          <span className="text-sm text-muted-foreground">{m.mcpLabel}</span>
          <p className="text-sm text-muted-foreground">{m.mcpUnavailable}</p>
        </div>
      )}
      <Link
        href="/admin/developers/connect"
        className="self-start text-sm font-medium text-primary underline underline-offset-4"
      >
        {m.connectLink}
      </Link>
    </section>
  );
}
