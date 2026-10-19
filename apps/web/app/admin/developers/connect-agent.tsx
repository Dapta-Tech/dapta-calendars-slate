'use client';

import { useId, useState } from 'react';
import { t, type BookingMessages } from '@slate/shared';
import { buttonVariants, Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { MCP_TOOLS, scopeLabel, type ToolKind } from '@/lib/mcp-connect';

type DevMessages = BookingMessages['admin']['developer'];

/** Everything the guide prints, built on the server from the runtime MCP address. */
export interface ConnectSnippets {
  mcpUrl: string;
  cursorDeeplink: string;
  cursorJson: string;
  claudeCode: string;
  codexToml: string;
  exportKey: string;
  header: string;
  /** Claude's add-connector dialog, pre-filled (used when OAuth is on). */
  claudeConnector: string;
}

type TabId = 'cursor' | 'claude-code' | 'codex' | 'other' | 'chat';

export function CodeBlock({ value, label, copyLabel, copiedLabel }: { value: string; label?: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  return (
    <div className="flex flex-col gap-tight">
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      {/* Copy sits top-right inside the block, so a one-line value takes one line. */}
      <div className="flex items-start gap-inline rounded-md border border-border bg-muted p-inline pl-field">
        <pre className="min-w-0 flex-1 self-center overflow-x-auto whitespace-pre font-mono text-xs">
          <code>{value}</code>
        </pre>
        <Button
          variant="outline"
          size="lg"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={`${copyLabel} · ${label ?? value.slice(0, 24)}`}
        >
          <i aria-hidden className={`pi ${copied ? 'pi-check' : 'pi-copy'}`} style={{ fontSize: 12 }} />
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The agent tabs: the MCP address and the exact setup for each agent. Step 2 of
 * the setup guide (`setup-guide.tsx`), which carries the title and, in step 1,
 * the key.
 */
export function ConnectAgent({
  available,
  snippets,
  oauth = false,
  external = false,
  messages: m,
}: {
  /** The API serves MCP. Off: one plain sentence, no tabs and no address (the page also drops the tool list). */
  available: boolean;
  snippets: ConnectSnippets | null;
  /** OAuth is on: chat apps connect with a sign-in. */
  oauth?: boolean;
  /**
   * The sign-in is an external authorization server's: people sign in with the
   * account they use here, and a connection acts with their admin role.
   */
  external?: boolean;
  messages: DevMessages;
}) {
  const base = useId();
  const tabs: { id: TabId; label: string }[] = [
    { id: 'cursor', label: m.tabCursor },
    { id: 'claude-code', label: m.tabClaudeCode },
    { id: 'codex', label: m.tabCodex },
    { id: 'other', label: m.tabOther },
    { id: 'chat', label: oauth ? m.chatOAuthTitle : m.tabChat },
  ];
  const [active, setActive] = useState<TabId>('cursor');

  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActive(tabs[next]!.id);
    document.getElementById(`${base}-tab-${tabs[next]!.id}`)?.focus();
  };

  const copy = { copyLabel: m.copy, copiedLabel: m.copied };

  if (!available) {
    return (
      <section className="mb-section" aria-labelledby={`${base}-title`}>
        <h2 id={`${base}-title`} className="mb-tight text-xl font-semibold">
          {m.connectTitle}
        </h2>
        <div className="rounded-xl border border-border bg-card p-field">
          <p className="max-w-prose text-sm text-muted-foreground">{m.mcpUnavailable}</p>
        </div>
      </section>
    );
  }

  return (
    <div>
      {external ? <SignInNote m={m} /> : null}
      {/* Scrolls inside its own width: it sits in the guide's step column now,
          so the old bleed to the page gutter would run into the step numbers. */}
      <div role="tablist" aria-label={m.connectTitle} className="mb-field flex gap-tight overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'inline-flex min-h-control shrink-0 items-center whitespace-nowrap rounded-md px-field text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]',
              active === tab.id
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel-${active}`}
        aria-labelledby={`${base}-tab-${active}`}
        className="flex flex-col gap-field rounded-xl border border-border bg-card p-field"
      >
        {active === 'chat' && oauth && snippets ? (
          <ChatOAuth snippets={snippets} external={external} m={m} />
        ) : active === 'chat' ? (
          <div className="flex flex-col gap-tight">
            <h3 className="text-base font-semibold">{m.chatTitle}</h3>
            <p className="max-w-prose text-sm text-muted-foreground">{m.chatBody}</p>
          </div>
        ) : snippets === null ? (
          <p className="max-w-prose text-sm text-muted-foreground">{m.mcpUrlMissing}</p>
        ) : (
          <>
            <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
            <CodeBlock value={snippets.exportKey} label={m.stepKeyEnv} {...copy} />
            {active === 'cursor' ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">{m.cursorLead}</p>
                <div>
                  <a href={snippets.cursorDeeplink} className={buttonVariants({ size: 'lg' })}>
                    {m.addToCursor}
                  </a>
                </div>
                <p className="max-w-prose text-xs text-muted-foreground">{m.cursorKeyNote}</p>
                <CodeBlock value={snippets.cursorJson} label={m.cursorFileLabel} {...copy} />
              </>
            ) : null}
            {active === 'claude-code' ? <CodeBlock value={snippets.claudeCode} label={m.claudeCodeLead} {...copy} /> : null}
            {active === 'codex' ? <CodeBlock value={snippets.codexToml} label={m.codexLead} {...copy} /> : null}
            {active === 'other' ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">{m.otherLead}</p>
                <CodeBlock value={snippets.mcpUrl} label={m.otherUrl} {...copy} />
                <CodeBlock value={snippets.header} label={m.otherHeader} {...copy} />
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Signing in through an external authorization server, said once above the
 * tabs: with which account, what a connection may do, and how it ends. There
 * is no consent page or Connected apps list here to say it instead.
 */
function SignInNote({ m }: { m: DevMessages }) {
  return (
    <div className="mb-field flex flex-col gap-tight rounded-xl border border-border bg-card p-field">
      <h3 className="text-base font-semibold">{m.signInTitle}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">{m.signInBody}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{m.signInAccess}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{m.signInDisconnect}</p>
    </div>
  );
}

/** The chat-app tab when OAuth is on: real "add custom connector" steps, no key. */
function ChatOAuth({ snippets, external, m }: { snippets: ConnectSnippets; external: boolean; m: DevMessages }) {
  const copy = { copyLabel: m.copy, copiedLabel: m.copied };
  const steps = (items: string[]) => (
    <ol className="flex list-decimal flex-col gap-tight pl-group text-sm text-muted-foreground">
      {items.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
  return (
    <>
      <p className="max-w-prose text-sm text-muted-foreground">{external ? m.chatSignInLead : m.chatOAuthLead}</p>
      <div>
        <a href={snippets.claudeConnector} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'lg' })}>
          {m.addToClaude}
        </a>
      </div>
      <CodeBlock value={snippets.mcpUrl} label={m.mcpUrlLabel} {...copy} />
      <div className="flex flex-col gap-tight">
        <h3 className="text-base font-semibold">{m.chatClaudeHeading}</h3>
        {steps([m.chatClaudeStep1, m.chatClaudeStep2, external ? m.chatSignInClaudeStep3 : m.chatClaudeStep3])}
      </div>
      <div className="flex flex-col gap-tight">
        <h3 className="text-base font-semibold">{m.chatGptHeading}</h3>
        {steps([m.chatGptStep1, m.chatGptStep2, external ? m.chatSignInGptStep3 : m.chatGptStep3])}
      </div>
      {/* A sign-in has no step-up: what it may do is said above the tabs. */}
      {external ? null : <p className="max-w-prose text-xs text-muted-foreground">{m.chatScopesNote}</p>}
    </>
  );
}

const KIND_CLASS: Record<ToolKind, string> = {
  read: 'bg-muted text-muted-foreground',
  write: 'bg-warning/20 text-foreground',
  destructive: 'bg-destructive/15 text-destructive',
};

export function KindChip({ kind, m }: { kind: ToolKind; m: DevMessages }) {
  const label = kind === 'read' ? m.kindRead : kind === 'write' ? m.kindWrite : m.kindDestructive;
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-inline py-tight text-xs font-medium', KIND_CLASS[kind])}>
      {label}
    </span>
  );
}

/** The tools with read / write / destructive labels, before anyone creates a key. */
export function AgentTools({ messages: m }: { messages: DevMessages }) {
  return (
    <section className="mb-section">
      <h2 className="mb-tight text-xl font-semibold">{m.toolsTitle}</h2>
      <p className="mb-field max-w-prose text-sm text-muted-foreground">{m.toolsLead}</p>
      <ul className="grid grid-cols-1 gap-inline md:grid-cols-2">
        {MCP_TOOLS.map((tool) => (
          <li key={tool.name} className="flex flex-col gap-tight rounded-xl border border-border bg-card p-field">
            <div className="flex flex-wrap items-center justify-between gap-x-inline gap-y-tight">
              <code className="min-w-0 break-all font-mono text-sm font-medium">{tool.name}</code>
              <KindChip kind={tool.kind} m={m} />
            </div>
            <p className="text-xs text-muted-foreground">{m.toolDescriptions[tool.name] ?? ''}</p>
            <p className="text-xs text-foreground">
              {tool.scope ? t(m.toolNeeds, { scope: scopeLabel(m.scopeLabels, tool.scope) }) : tool.publicOk ? m.toolNeedsNoKey : m.toolNeedsAnyKey}
              {tool.scope && tool.publicOk ? ` ${m.toolOrPublic}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
