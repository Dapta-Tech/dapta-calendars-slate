'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { t, type BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { DEVELOPERS_DOCS_HREF } from '@/lib/admin-nav';
import { cn } from '@/lib/cn';
import { CodeBlock, ConnectAgent, type ConnectSnippets } from './connect-agent';

type DevMessages = BookingMessages['admin']['developer'];

/**
 * The three steps that connect an agent to this workspace through the MCP
 * server: create a key, connect the agent (the tabs of `ConnectAgent`), ask it
 * something. The same shape as the dForms guide, so the two products teach the
 * same thing the same way.
 *
 * A step shows as done from what the page can know: the workspace has a working
 * key; a key has been used, or an app has signed in through OAuth. None of that
 * blocks a step. Step 1's button opens the key list's own create dialog, so
 * there is one way to make a key, and it is the page's only Create while there
 * is no key (R30: one create action per screen).
 */
export function SetupGuide({
  m,
  snippets,
  oauth,
  hasKey,
  agentConnected,
  productName,
  docsLabel,
  onCreate,
}: {
  m: DevMessages;
  snippets: ConnectSnippets | null;
  oauth: boolean;
  hasKey: boolean;
  agentConnected: boolean;
  productName: string;
  /** The API docs page's name in the rail, the link under the prompt. */
  docsLabel: string;
  onCreate: () => void;
}) {
  return (
    <section
      aria-labelledby="setup-guide-title"
      data-testid="setup-guide"
      className="rounded-xl border border-border bg-card p-card sm:p-group"
    >
      <h2 id="setup-guide-title" className="text-xl font-semibold">
        {m.guideTitle}
      </h2>
      <p className="mt-tight max-w-prose text-sm text-muted-foreground">{m.guideIntro}</p>

      <ol className="mt-group flex flex-col">
        <Step n={1} title={m.guideKeyTitle} done={hasKey} doneLabel={m.guideStepDone} testId="setup-step-key">
          <p className="max-w-prose text-sm text-muted-foreground">{hasKey ? m.guideKeyDone : m.guideKeyBody}</p>
          {hasKey ? null : (
            <div className="mt-field">
              <Button size="lg" data-testid="setup-create-key" onClick={onCreate}>
                {m.createKey}
              </Button>
            </div>
          )}
        </Step>

        <Step n={2} title={m.connectTitle} done={agentConnected} doneLabel={m.guideStepDone} testId="setup-step-agent">
          <p className="mb-field max-w-prose text-sm text-muted-foreground">
            {agentConnected ? m.guideAgentDone : m.guideAgentBody}
          </p>
          <ConnectAgent snippets={snippets} oauth={oauth} messages={m} />
        </Step>

        <Step n={3} title={m.guideTryTitle} done={false} doneLabel={m.guideStepDone} last testId="setup-step-try">
          <p className="mb-inline max-w-prose text-sm text-muted-foreground">{m.guideTryHint}</p>
          <CodeBlock
            value={t(m.guidePrompt, { product: productName })}
            copyLabel={m.copyPrompt}
            copiedLabel={m.copied}
          />
          <p className="mt-field max-w-prose text-xs text-muted-foreground">
            {m.guideTryNote}{' '}
            <Link href={DEVELOPERS_DOCS_HREF} className="font-medium text-foreground underline underline-offset-2">
              {docsLabel}
            </Link>
            .
          </p>
        </Step>
      </ol>
    </section>
  );
}

/** One numbered step, with the line that joins it to the next. */
function Step({
  n,
  title,
  done,
  doneLabel,
  last,
  testId,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  doneLabel: string;
  last?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <li data-testid={testId} data-done={done || undefined} className="flex min-w-0 gap-field">
      <div className="flex shrink-0 flex-col items-center">
        <span
          aria-hidden
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold',
            done ? 'bg-signal text-signal-foreground' : 'border border-border bg-background text-foreground',
          )}
        >
          {done ? <i className="pi pi-check" style={{ fontSize: 12 }} /> : n}
        </span>
        {last ? null : <span aria-hidden className="mt-tight w-px flex-1 bg-border" />}
      </div>
      <div className={cn('min-w-0 flex-1', last ? undefined : 'pb-group')}>
        <h3 className="text-base font-semibold">
          {title}
          {done ? <span className="sr-only"> ({doneLabel})</span> : null}
        </h3>
        <div className="mt-tight">{children}</div>
      </div>
    </li>
  );
}
