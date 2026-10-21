'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { t, type BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { DEVELOPERS_DOCS_HREF } from '@/lib/admin-nav';
import { cn } from '@/lib/cn';
import { CodeBlock, ConnectAgent, type ConnectSnippets } from './connect-agent';
import { SkillDownload } from './skill-download';

type DevMessages = BookingMessages['admin']['developer'];

/**
 * The three steps that connect an agent to this workspace through the MCP
 * server: create a key, connect the agent (the tabs of `ConnectAgent`), ask it
 * something. The same shape as the dForms guide, so the two products teach the
 * same thing the same way.
 *
 * A step shows as done from what the page can know: the workspace has a working
 * key; a key has been used, or an app has signed in through this API's own
 * OAuth server. None of that blocks a step.
 *
 * With sign-in through an external authorization server (`external`), the
 * guide leads with it: step 1 is signing in from the app (Claude, ChatGPT,
 * Cursor, Claude Code and any other app that signs in), step 2 is a key, for
 * headless agents and scripts or for narrower access. That server's sign-ins
 * leave nothing this page can read, so step 1 is never marked done, and step 2
 * only says a key has been used. Step 1's button opens the key list's own create dialog, so
 * there is one way to make a key, and it is the page's only Create while there
 * is no key (R30: one create action per screen).
 *
 * Under the steps, the way in for an agent without MCP: the skill zip, which
 * teaches it the REST API with the same key (offered with MCP off too, where it
 * is the only way in). It is built on the server for this
 * installation; with no public API address there is nothing to write into it,
 * so the guide says so instead of offering a download that would fail. A
 * download that fails anyway (the session ended meanwhile) says why in place.
 */
export function SetupGuide({
  m,
  mcpAvailable,
  snippets,
  oauth,
  external,
  hasKey,
  keyUsed,
  appsConnected,
  productName,
  docsLabel,
  skillAvailable,
  onCreate,
}: {
  m: DevMessages;
  /**
   * The API says it serves MCP (`mcpEnabled`). Off, an older API without the
   * field, or a read that failed: the guide is one sentence, with no steps and
   * no address, since MCP_PUBLIC_URL only says where MCP would answer.
   */
  mcpAvailable: boolean;
  snippets: ConnectSnippets | null;
  oauth: boolean;
  /** People sign in through an external authorization server: the guide leads with signing in. */
  external: boolean;
  hasKey: boolean;
  /** A working key has been used. */
  keyUsed: boolean;
  /** An app has signed in through this API's own OAuth server (never with `external`). */
  appsConnected: boolean;
  productName: string;
  /** The API docs page's name in the rail, the link under the prompt. */
  docsLabel: string;
  /** The installation has a public API address, so the skill can be built. */
  skillAvailable: boolean;
  onCreate: () => void;
}) {
  // The skill teaches the REST API, which does not depend on MCP, so it is
  // offered in both states. With MCP off it is the only way in, and the
  // sentence above it already says why, so it loses the "No MCP?" question.
  const skill = (asked: boolean) => (
    <div data-testid="setup-skill" className="mt-group border-t border-border pt-group">
      {asked ? <h3 className="mb-tight text-base font-semibold">{m.guideSkillTitle}</h3> : null}
      <p className="max-w-prose text-sm text-muted-foreground">{t(m.guideSkillBody, { product: productName })}</p>
      {skillAvailable ? (
        <SkillDownload m={m} />
      ) : (
        <p data-testid="setup-skill-unavailable" className="mt-field max-w-prose text-sm text-muted-foreground">
          {m.guideSkillUnavailable}
        </p>
      )}
    </div>
  );

  if (!mcpAvailable) {
    return (
      <section
        aria-labelledby="setup-guide-title"
        data-testid="setup-guide"
        data-mcp="off"
        className="mb-section rounded-xl border border-border bg-card p-card sm:p-group"
      >
        <h2 id="setup-guide-title" className="text-xl font-semibold">
          {m.connectTitle}
        </h2>
        <p className="mt-tight max-w-prose text-sm text-muted-foreground">{m.mcpUnavailable}</p>
        {skill(false)}
      </section>
    );
  }
  const agentConnected = appsConnected || keyUsed;
  const createKey = hasKey ? null : (
    <div className="mt-field">
      <Button size="lg" data-testid="setup-create-key" onClick={onCreate}>
        {m.createKey}
      </Button>
    </div>
  );
  const tryStep = (
    <Step n={3} title={m.guideTryTitle} done={false} doneLabel={m.guideStepDone} last testId="setup-step-try">
      <p className="mb-inline max-w-prose text-sm text-muted-foreground">{m.guideTryHint}</p>
      <CodeBlock value={t(m.guidePrompt, { product: productName })} copyLabel={m.copyPrompt} copiedLabel={m.copied} wrap />
      <p className="mt-field max-w-prose text-xs text-muted-foreground">
        {m.guideTryNote}{' '}
        <Link href={DEVELOPERS_DOCS_HREF} className="font-medium text-foreground underline underline-offset-2">
          {docsLabel}
        </Link>
        .
      </p>
    </Step>
  );

  return (
    <section
      aria-labelledby="setup-guide-title"
      data-testid="setup-guide"
      className="mb-section rounded-xl border border-border bg-card p-card sm:p-group"
    >
      <h2 id="setup-guide-title" className="text-xl font-semibold">
        {m.guideTitle}
      </h2>
      <p className="mt-tight max-w-prose text-sm text-muted-foreground">{m.guideIntro}</p>

      {external ? (
        <ol className="mt-group flex flex-col">
          <Step n={1} title={m.signInTitle} done={false} doneLabel={m.guideStepDone} testId="setup-step-sign-in">
            <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.signInBody}</p>
            <ConnectAgent snippets={snippets} variant="sign-in" label={m.signInTitle} messages={m} />
            <p className="mt-field max-w-prose text-xs text-muted-foreground">{m.signInAccess}</p>
            <p className="mt-tight max-w-prose text-xs text-muted-foreground">{m.signInDisconnect}</p>
          </Step>

          <Step n={2} title={m.guideKeyAltTitle} done={keyUsed} doneLabel={m.guideStepDone} testId="setup-step-key">
            <p className="max-w-prose text-sm text-muted-foreground">
              {keyUsed ? m.guideKeyUsedDone : hasKey ? m.guideKeyDone : m.guideKeyAltBody}
            </p>
            {createKey}
            <div className="mt-field">
              <ConnectAgent snippets={snippets} variant="keys" label={m.guideKeyAltTitle} messages={m} />
            </div>
          </Step>

          {tryStep}
        </ol>
      ) : (
        <ol className="mt-group flex flex-col">
          <Step n={1} title={m.guideKeyTitle} done={hasKey} doneLabel={m.guideStepDone} testId="setup-step-key">
            <p className="max-w-prose text-sm text-muted-foreground">{hasKey ? m.guideKeyDone : m.guideKeyBody}</p>
            {createKey}
          </Step>

          <Step n={2} title={m.connectTitle} done={agentConnected} doneLabel={m.guideStepDone} testId="setup-step-agent">
            <p className="mb-field max-w-prose text-sm text-muted-foreground">
              {/* Say only what happened: "or an app has signed in" only when one has. */}
              {appsConnected ? m.guideAgentDone : keyUsed ? m.guideKeyUsedDone : m.guideAgentBody}
            </p>
            <ConnectAgent snippets={snippets} oauth={oauth} messages={m} />
          </Step>

          {tryStep}
        </ol>
      )}

      {skill(true)}
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
